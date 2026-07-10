import { z } from "zod";
import { prisma } from "../db.js";
import { recordAudit } from "../lib/audit.js";
import {
  ACKNOWLEDGE_NOTIFICATION_ACTION,
  UNACKNOWLEDGE_NOTIFICATION_ACTION,
  type NotificationSeverity,
  type NotificationType,
} from "../lib/actionContracts.js";
import type { AuthedUser } from "../middleware/auth.js";
import { fail, ok, type ServiceResult } from "./result.js";
import { listFollowUpsDue } from "./communicationService.js";
import { detectUpcomingOverload } from "./calendarService.js";
import { buildDataQualityItems } from "./dataQualityService.js";

// Notification and Escalation Module — see VCUF master documentation and the
// vcubf-programmer-skill module list. This module stores no duplicate
// business facts: every item in the feed is computed fresh, on read, from
// real data already owned by other modules —
//   - Communication Log Module: follow-ups that are overdue or never had a
//     date entered (communicationService.listFollowUpsDue).
//   - Job Allocation and Capacity Management / Calendar and Scheduling
//     Intelligence Module: upcoming weeks where a real employee's computed
//     workload exceeds their declared capacity (calendarService.
//     detectUpcomingOverload), including the same real mitigation options.
//   - Quote, Pricing and Profitability Module: draft/sent quotes whose
//     valid_until date has passed or is about to.
//   - Data Quality Engine: possible duplicate clients and clients missing a
//     contact method, computed structurally over real CRM Core client data
//     (dataQualityService.buildDataQualityItems) — never a merge, never an
//     automatic edit, always presented for a human to review.
// Nothing here is invented — severity is derived directly from real dates
// and percentages already stored elsewhere, never guessed. The only state
// this module persists is which computed item a user has explicitly
// acknowledged (see NotificationAcknowledgement), so a handled item does not
// keep resurfacing — and that acknowledgement is fully reversible.

export interface AttentionItemBase {
  key: string;
  type: NotificationType;
  severity: NotificationSeverity;
  title: string;
  message: string;
  dueAt: string | null;
  entity: { type: string; id: string; label?: string };
}

export interface AttentionItem extends AttentionItemBase {
  acknowledged: boolean;
  acknowledgedAt: string | null;
}

const QUOTE_EXPIRY_WARNING_WINDOW_DAYS = 7;

function daysBetween(a: Date, b: Date): number {
  return (a.getTime() - b.getTime()) / (1000 * 60 * 60 * 24);
}

async function buildFollowUpItems(user: AuthedUser): Promise<AttentionItemBase[]> {
  const records = await listFollowUpsDue(user);
  const now = new Date();
  return records.map((r) => {
    const overdueDays = r.followUpDueAt ? daysBetween(now, r.followUpDueAt) : null;
    const severity: NotificationSeverity =
      overdueDays !== null && overdueDays > 2 ? "urgent" : "warning";
    return {
      key: `follow_up:${r.id}`,
      type: "follow_up_due",
      severity,
      title: `Follow up with ${r.client?.displayName ?? "client"}`,
      message: r.followUpDueAt
        ? `Follow-up was due ${r.followUpDueAt.toISOString().slice(0, 10)}: ${r.summary}`
        : `Follow-up needed (no due date entered): ${r.summary}`,
      dueAt: r.followUpDueAt ? r.followUpDueAt.toISOString() : null,
      entity: { type: "communication_record", id: r.id, label: r.client?.displayName },
    };
  });
}

async function buildOverloadItems(user: AuthedUser): Promise<AttentionItemBase[]> {
  const report = await detectUpcomingOverload(user);
  return report.overloadedWeeks.map((w) => {
    const severity: NotificationSeverity = w.utilizationPct >= 120 ? "urgent" : "warning";
    return {
      key: `capacity_overload:${w.employeeId}:${w.weekStart}`,
      type: "capacity_overload",
      severity,
      title: `${w.employeeName} is overloaded week of ${w.weekStart}`,
      message: `${w.currentLoadHours}h projected against ${w.weeklyCapacityHours}h weekly capacity (${w.utilizationPct}%).`,
      dueAt: w.weekStart,
      entity: { type: "employee_week", id: `${w.employeeId}:${w.weekStart}`, label: w.employeeName },
    };
  });
}

async function buildQuoteExpiryItems(user: AuthedUser): Promise<AttentionItemBase[]> {
  const now = new Date();
  const windowEnd = new Date(now.getTime() + QUOTE_EXPIRY_WARNING_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const quotes = await prisma.quote.findMany({
    where: {
      companyId: user.companyId,
      quoteStatus: { in: ["draft", "sent"] },
      validUntil: { not: null, lte: windowEnd },
    },
    include: { client: { select: { id: true, displayName: true } } },
  });
  return quotes.map((q) => {
    const expired = q.validUntil !== null && q.validUntil < now;
    const severity: NotificationSeverity = expired ? "urgent" : "warning";
    return {
      key: `quote_expiring:${q.id}`,
      type: "quote_expiring",
      severity,
      title: `Quote "${q.title}" for ${q.client?.displayName ?? "client"} ${expired ? "has expired" : "is expiring soon"}`,
      message: `Status: ${q.quoteStatus}. Valid until ${q.validUntil?.toISOString().slice(0, 10)}.`,
      dueAt: q.validUntil ? q.validUntil.toISOString() : null,
      entity: { type: "quote", id: q.id, label: q.title },
    };
  });
}

const severityRank: Record<NotificationSeverity, number> = { urgent: 0, warning: 1, info: 2 };

// get_attention_feed — read-only. By default, already-acknowledged items are
// hidden (the point of acknowledging is to stop them resurfacing); pass
// includeAcknowledged to see the full picture (e.g. for review/audit).
export async function getAttentionFeed(
  user: AuthedUser,
  options: { includeAcknowledged?: boolean } = {}
): Promise<AttentionItem[]> {
  const [followUps, overloads, expiringQuotes, dataQualityItems] = await Promise.all([
    buildFollowUpItems(user),
    buildOverloadItems(user),
    buildQuoteExpiryItems(user),
    buildDataQualityItems(user),
  ]);

  const items: AttentionItemBase[] = [...followUps, ...overloads, ...expiringQuotes, ...dataQualityItems];

  const acks = await prisma.notificationAcknowledgement.findMany({
    where: { companyId: user.companyId },
  });
  const ackByKey = new Map(acks.map((a) => [a.notificationKey, a]));

  const withAckState = items.map((item) => {
    const ack = ackByKey.get(item.key);
    return {
      ...item,
      acknowledged: Boolean(ack),
      acknowledgedAt: ack ? ack.acknowledgedAt.toISOString() : null,
    };
  });

  const filtered = options.includeAcknowledged ? withAckState : withAckState.filter((i) => !i.acknowledged);

  filtered.sort((a, b) => {
    const rankDiff = severityRank[a.severity] - severityRank[b.severity];
    if (rankDiff !== 0) return rankDiff;
    if (a.dueAt && b.dueAt) return a.dueAt.localeCompare(b.dueAt);
    if (a.dueAt !== b.dueAt) return a.dueAt ? -1 : 1;
    return 0;
  });

  return filtered;
}

const acknowledgeSchema = z.object({ notification_key: z.string().min(1, "notification_key is required") });

// acknowledge_notification — records that the user has seen/handled a
// computed item, keyed by its deterministic notificationKey. This never
// touches the underlying business record (communication record, overload
// finding, or quote) — it only stops that item resurfacing in the feed.
// Idempotent: acknowledging an already-acknowledged key updates the
// timestamp/actor rather than erroring.
export async function acknowledgeNotification(user: AuthedUser, rawInput: unknown): Promise<ServiceResult<unknown>> {
  const parsed = acknowledgeSchema.safeParse(rawInput);
  if (!parsed.success) {
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: ACKNOWLEDGE_NOTIFICATION_ACTION.actionName,
      inputPayload: rawInput,
      riskLevel: ACKNOWLEDGE_NOTIFICATION_ACTION.riskLevel,
      confirmationRequired: ACKNOWLEDGE_NOTIFICATION_ACTION.confirmationRequired,
      result: "error",
      errorMessage: "VALIDATION_FAILED",
    });
    return fail(400, "VALIDATION_FAILED", parsed.error.message);
  }

  const record = await prisma.notificationAcknowledgement.upsert({
    where: {
      companyId_notificationKey: { companyId: user.companyId, notificationKey: parsed.data.notification_key },
    },
    create: {
      companyId: user.companyId,
      notificationKey: parsed.data.notification_key,
      acknowledgedBy: user.id,
    },
    update: {
      acknowledgedBy: user.id,
      acknowledgedAt: new Date(),
    },
  });

  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: ACKNOWLEDGE_NOTIFICATION_ACTION.actionName,
    inputPayload: parsed.data,
    dataAfter: record,
    riskLevel: ACKNOWLEDGE_NOTIFICATION_ACTION.riskLevel,
    confirmationRequired: ACKNOWLEDGE_NOTIFICATION_ACTION.confirmationRequired,
    result: "success",
  });

  return ok(200, record);
}

// unacknowledge_notification — fully reversible: deletes the acknowledgement
// row so the item resurfaces in the feed again. Idempotent (succeeds even if
// nothing was acknowledged), matching the Learning Engine's
// visible/editable/reversible standard for low-risk state.
export async function unacknowledgeNotification(user: AuthedUser, notificationKey: string): Promise<ServiceResult<unknown>> {
  const existing = await prisma.notificationAcknowledgement.findUnique({
    where: { companyId_notificationKey: { companyId: user.companyId, notificationKey } },
  });

  if (existing) {
    await prisma.notificationAcknowledgement.delete({ where: { id: existing.id } });
  }

  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: UNACKNOWLEDGE_NOTIFICATION_ACTION.actionName,
    inputPayload: { notification_key: notificationKey },
    dataBefore: existing,
    riskLevel: UNACKNOWLEDGE_NOTIFICATION_ACTION.riskLevel,
    confirmationRequired: UNACKNOWLEDGE_NOTIFICATION_ACTION.confirmationRequired,
    result: "success",
  });

  return ok(200, { notification_key: notificationKey, acknowledged: false });
}
