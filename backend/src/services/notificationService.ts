import { z } from "zod";
import { prisma } from "../db.js";
import { recordAudit } from "../lib/audit.js";
import {
  ACKNOWLEDGE_NOTIFICATION_ACTION,
  DELETE_ALL_NOTIFICATIONS_ACTION,
  UNACKNOWLEDGE_NOTIFICATION_ACTION,
  JOB_STATUS_COMPLETED,
  CHANGE_JOB_STATUS_ACTION,
  type NotificationSeverity,
  type NotificationType,
} from "../lib/actionContracts.js";
import type { AuthedUser } from "../middleware/auth.js";
import { fail, ok, type ServiceResult } from "./result.js";
import { listFollowUpsDue, listUnresolvedIntakeEnquiries } from "./communicationService.js";
import { detectUpcomingOverload } from "./calendarService.js";
import { buildDataQualityItems } from "./dataQualityService.js";

// Notification and Escalation Module — see VCUF master documentation and the
// vcubf-programmer-skill module list. This module stores no duplicate
// business facts: every item in the feed is computed fresh, on read, from
// real data already owned by other modules —
//   - Communication Log Module: follow-ups that are overdue or never had a
//     date entered (communicationService.listFollowUpsDue).
//   - Communication Intelligence Module: preserved inbound intakes whose
//     explicit resolutionNeeded flag remains true before CRM conversion.
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
//   - Portfolio and Photo Intelligence Module: completed jobs (Job.jobStatus
//     === "dokonceno") that have zero linked PortfolioPhoto records — a
//     structural, count-based "you finished this job and never logged any
//     photos for it" gap. This never judges photo quality and never flags a
//     job that already has at least one photo logged.
//   - Lead Intake Module: leads still open (leadStatus not "converted" and
//     not "lost") whose Lead.createdAt is older than
//     STALE_LEAD_THRESHOLD_DAYS — a real, count-of-days signal that a lead
//     has not been progressed, never a guess about why.
//   - Job Allocation and Capacity Management Module: jobs not in a terminal
//     status ("dokonceno"/"zruseno") whose status has not changed in more
//     than STUCK_JOB_THRESHOLD_DAYS. This deliberately queries the AuditLog
//     for the job's most recent "change_job_status" entry rather than using
//     Job.updatedAt, because updatedAt is a generic Prisma @updatedAt
//     timestamp bumped by any field write (e.g. assign_job re-assigning the
//     job) — using it directly would under-report "stuck" jobs whenever an
//     unrelated field changed more recently than the actual status. A job
//     that has never had a change_job_status audit entry is measured from
//     Job.createdAt instead (it has been sitting in its initial status
//     since creation, which is exactly the same "stuck" signal).
//   - Task Management: unfinished Secretary tasks whose real dueAt timestamp
//     is in the past. Completed/cancelled tasks never appear.
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

// Lead Intake Module — a lead still open (not converted, not lost) this many
// days after creation is considered stale and surfaced for attention. A
// fixed, documented constant, matching the convention already used for
// QUOTE_EXPIRY_WARNING_WINDOW_DAYS and PATTERN_DETECTION_WINDOW_DAYS.
const STALE_LEAD_THRESHOLD_DAYS = 14;
const OPEN_LEAD_STATUSES = ["new", "contacted", "qualified"] as const;

// Job Allocation and Capacity Management Module — a non-terminal job whose
// status has not changed in this many days is considered stuck. See the
// module-level comment above for why this is measured from the AuditLog
// change_job_status trail rather than Job.updatedAt.
const STUCK_JOB_THRESHOLD_DAYS = 10;
const TERMINAL_JOB_STATUSES = ["dokonceno", "zruseno"] as const;

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

async function buildUnresolvedEnquiryItems(user: AuthedUser): Promise<AttentionItemBase[]> {
  const enquiries = await listUnresolvedIntakeEnquiries(user);
  return enquiries.map((enquiry) => ({
    key: `unresolved_enquiry:${enquiry.sourceId}`,
    type: "unresolved_enquiry",
    // No deadline/SLA is stored for a raw intake, so urgency must not be
    // fabricated from age alone. The explicit unresolved state warrants a
    // warning; only records with real overdue dates can become urgent.
    severity: "warning",
    title: `Unresolved enquiry from ${enquiry.senderLabel}`,
    message: `Inbound ${enquiry.channel.replace(/_/g, " ")} enquiry is still marked as needing resolution. No response deadline is recorded.`,
    dueAt: null,
    entity: { type: "communication_intake", id: enquiry.sourceId, label: enquiry.senderLabel },
  }));
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

async function buildOverdueInvoiceItems(user: AuthedUser): Promise<AttentionItemBase[]> {
  const now=new Date(); const rows=await prisma.invoice.findMany({where:{companyId:user.companyId,invoiceStatus:"issued",dueDate:{lt:now}},include:{client:{select:{displayName:true}},items:true,payments:true}});
  return rows.flatMap(x=>{const total=x.items.reduce((s,i)=>s+i.quantity*Number(i.unitPrice),0),paid=x.payments.reduce((s,p)=>s+Number(p.amount),0),balance=Math.max(0,total-paid);if(balance===0)return [];return [{key:`invoice_overdue:${x.id}`,type:"invoice_overdue" as const,severity:"urgent" as const,title:`Invoice ${x.invoiceNumber} is overdue`,message:`${x.client.displayName} has an outstanding balance of £${balance.toFixed(2)}. Due ${x.dueDate!.toISOString().slice(0,10)}.`,dueAt:x.dueDate!.toISOString(),entity:{type:"invoice",id:x.id,label:x.invoiceNumber}}];});
}
async function buildResourceReadinessItems(user:AuthedUser):Promise<AttentionItemBase[]>{const now=new Date(),end=new Date(now.getTime()+3*86400000);const jobs=await prisma.job.findMany({where:{companyId:user.companyId,plannedStartAt:{gte:now,lte:end},resourceRequirements:{some:{requirementStatus:{not:"ready"}}}},include:{resourceRequirements:true}});return jobs.map(j=>{const n=j.resourceRequirements.filter(x=>x.requirementStatus!=="ready").length;return{key:`resource_not_ready:${j.id}`,type:"resource_not_ready" as const,severity:"urgent" as const,title:`Resources not ready for ${j.jobTitle}`,message:`${n} recorded requirement(s) are not ready before the planned start.`,dueAt:j.plannedStartAt!.toISOString(),entity:{type:"job",id:j.id,label:j.jobTitle}}})}

// Portfolio marketing-readiness gap — completed jobs (Job.jobStatus ===
// JOB_STATUS_COMPLETED, i.e. "dokonceno") that have zero linked
// PortfolioPhoto rows. This is a real, structural, count-based signal only:
// "job finished, zero photos logged" — never a judgement about photo
// quality, and a job with at least one photo logged never appears here,
// regardless of that photo's usableForMarketing/approval status. Matches
// the "buildXItems" source-function pattern used by every other feed
// source in this module.
async function buildPortfolioGapItems(user: AuthedUser): Promise<AttentionItemBase[]> {
  const completedJobsWithoutPhotos = await prisma.job.findMany({
    where: {
      companyId: user.companyId,
      jobStatus: JOB_STATUS_COMPLETED,
      portfolioPhotos: { none: {} },
    },
    include: { client: { select: { id: true, displayName: true } } },
  });

  return completedJobsWithoutPhotos.map((j) => ({
    key: `portfolio_gap:${j.id}`,
    type: "portfolio_gap",
    severity: "info",
    title: `No portfolio photos logged for completed job "${j.jobTitle}"`,
    message: `Job for ${j.client?.displayName ?? "client"} is marked complete but has no PortfolioPhoto records — it cannot be used for marketing or case studies until photos are logged.`,
    dueAt: null,
    entity: { type: "job", id: j.id, label: j.jobTitle },
  }));
}

// Stale lead — a lead still open (leadStatus not "converted" and not
// "lost") whose Lead.createdAt is older than STALE_LEAD_THRESHOLD_DAYS.
// Matches the "buildXItems" source-function pattern used by every other
// feed source in this module. Real data only: no invented "reason it went
// stale", just the real elapsed days since creation.
async function buildStaleLeadItems(user: AuthedUser): Promise<AttentionItemBase[]> {
  const now = new Date();
  const threshold = new Date(now.getTime() - STALE_LEAD_THRESHOLD_DAYS * 24 * 60 * 60 * 1000);

  const staleLeads = await prisma.lead.findMany({
    where: {
      companyId: user.companyId,
      leadStatus: { in: [...OPEN_LEAD_STATUSES] },
      createdAt: { lte: threshold },
    },
  });

  return staleLeads.map((l) => {
    const ageDays = Math.floor(daysBetween(now, l.createdAt));
    const severity: NotificationSeverity = ageDays >= STALE_LEAD_THRESHOLD_DAYS * 2 ? "urgent" : "warning";
    return {
      key: `stale_lead:${l.id}`,
      type: "stale_lead",
      severity,
      title: `Lead "${l.name}" has been open for ${ageDays} days`,
      message: `Status is still "${l.leadStatus}" — created ${l.createdAt.toISOString().slice(0, 10)} and never converted or marked lost.`,
      dueAt: null,
      entity: { type: "lead", id: l.id, label: l.name },
    };
  });
}

// Stuck job — a job not in a terminal status whose status has not changed in
// more than STUCK_JOB_THRESHOLD_DAYS, using the AuditLog change_job_status
// trail (see module-level comment for why, not Job.updatedAt). The AuditLog
// does not have a jobId column — the job id lives inside the JSON
// inputPayload written by jobService.changeJobStatus — so this reads every
// successful change_job_status entry for the company once and reduces it to
// "latest status-change timestamp per job id" in memory, which is cheap at
// this data scale and avoids a second, duplicated business-fact store.
async function buildStuckJobItems(user: AuthedUser): Promise<AttentionItemBase[]> {
  const now = new Date();

  const activeJobs = await prisma.job.findMany({
    where: {
      companyId: user.companyId,
      jobStatus: { notIn: [...TERMINAL_JOB_STATUSES] },
    },
    include: { client: { select: { id: true, displayName: true } } },
  });
  if (activeJobs.length === 0) return [];

  const statusChangeAudits = await prisma.auditLog.findMany({
    where: {
      companyId: user.companyId,
      actionName: CHANGE_JOB_STATUS_ACTION.actionName,
      result: "success",
    },
    select: { inputPayload: true, createdAt: true },
  });

  const lastStatusChangeByJobId = new Map<string, Date>();
  for (const audit of statusChangeAudits) {
    const payload = audit.inputPayload as { jobId?: unknown } | null;
    const jobId = payload && typeof payload.jobId === "string" ? payload.jobId : null;
    if (!jobId) continue;
    const existing = lastStatusChangeByJobId.get(jobId);
    if (!existing || audit.createdAt > existing) {
      lastStatusChangeByJobId.set(jobId, audit.createdAt);
    }
  }

  const stuckJobs: AttentionItemBase[] = [];
  for (const j of activeJobs) {
    const lastChangeAt = lastStatusChangeByJobId.get(j.id) ?? j.createdAt;
    const daysSinceChange = daysBetween(now, lastChangeAt);
    if (daysSinceChange < STUCK_JOB_THRESHOLD_DAYS) continue;

    const roundedDays = Math.floor(daysSinceChange);
    const severity: NotificationSeverity = daysSinceChange >= STUCK_JOB_THRESHOLD_DAYS * 2 ? "urgent" : "warning";
    stuckJobs.push({
      key: `stuck_job:${j.id}`,
      type: "stuck_job",
      severity,
      title: `Job "${j.jobTitle}" has been "${j.jobStatus}" for ${roundedDays} days`,
      message: `No change_job_status action recorded in the last ${roundedDays} days for ${j.client?.displayName ?? "client"}'s job — status is still "${j.jobStatus}".`,
      dueAt: null,
      entity: { type: "job", id: j.id, label: j.jobTitle },
    });
  }
  return stuckJobs;
}

async function buildOverdueTaskItems(user: AuthedUser): Promise<AttentionItemBase[]> {
  const now = new Date();
  const tasks = await prisma.task.findMany({
    where: {
      companyId: user.companyId,
      taskStatus: { notIn: ["completed", "cancelled"] },
      dueAt: { lt: now },
    },
    include: { assignedUser: { select: { id: true, displayName: true } } },
  });
  return tasks.map((task) => {
    const overdueDays = task.dueAt ? daysBetween(now, task.dueAt) : 0;
    const severity: NotificationSeverity = overdueDays > 2 ? "urgent" : "warning";
    return {
      key: `overdue_task:${task.id}`,
      type: "overdue_task",
      severity,
      title: `Task overdue: ${task.title}`,
      message: `Due ${task.dueAt?.toISOString().slice(0, 10)}${
        task.assignedUser ? ` — assigned to ${task.assignedUser.displayName}` : " — unassigned"
      }. Status is still "${task.taskStatus}".`,
      dueAt: task.dueAt?.toISOString() ?? null,
      entity: { type: "task", id: task.id, label: task.title },
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
  const [unresolvedEnquiries, followUps, overloads, expiringQuotes, overdueInvoices, resourceReadiness, dataQualityItems, portfolioGapItems, staleLeads, stuckJobs, overdueTasks] =
    await Promise.all([
      buildUnresolvedEnquiryItems(user),
      buildFollowUpItems(user),
      buildOverloadItems(user),
      buildQuoteExpiryItems(user),
      buildOverdueInvoiceItems(user),
      buildResourceReadinessItems(user),
      buildDataQualityItems(user),
      buildPortfolioGapItems(user),
      buildStaleLeadItems(user),
      buildStuckJobItems(user),
      buildOverdueTaskItems(user),
    ]);

  const items: AttentionItemBase[] = [
    ...unresolvedEnquiries,
    ...followUps,
    ...overloads,
    ...expiringQuotes,
    ...overdueInvoices,
    ...resourceReadiness,
    ...dataQualityItems,
    ...portfolioGapItems,
    ...staleLeads,
    ...stuckJobs,
    ...overdueTasks,
  ];

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

const deleteAllSchema = z.object({ confirmed: z.literal(true) });

export async function deleteNotificationsByKeys(
  user: AuthedUser,
  notificationKeys: string[],
  confirmed: boolean
): Promise<ServiceResult<unknown>> {
  const keys = [...new Set(notificationKeys.map((key) => key.trim()).filter(Boolean))];
  if (!confirmed) {
    return fail(409, "CONFIRMATION_REQUIRED", "Confirm before deleting all notifications.", {
      confirmationRequired: true,
      preview: { count: keys.length },
    });
  }
  if (keys.length === 0) {
    return ok(200, { deletedCount: 0, underlyingRecordsChanged: false, reversible: true, message: "There are no notifications to delete." });
  }

  const acknowledgedAt = new Date();
  await prisma.$transaction(
    keys.map((notificationKey) =>
      prisma.notificationAcknowledgement.upsert({
        where: { companyId_notificationKey: { companyId: user.companyId, notificationKey } },
        create: { companyId: user.companyId, notificationKey, acknowledgedBy: user.id, acknowledgedAt },
        update: { acknowledgedBy: user.id, acknowledgedAt },
      })
    )
  );

  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: DELETE_ALL_NOTIFICATIONS_ACTION.actionName,
    inputPayload: { notificationCount: keys.length },
    dataAfter: { hiddenNotificationKeys: keys, underlyingRecordsChanged: false, reversible: true },
    riskLevel: DELETE_ALL_NOTIFICATIONS_ACTION.riskLevel,
    confirmationRequired: true,
    confirmed: true,
    result: "success",
  });

  return ok(200, {
    deletedCount: keys.length,
    underlyingRecordsChanged: false,
    reversible: true,
    message: `${keys.length} notification${keys.length === 1 ? " was" : "s were"} deleted from the feed. Source records were not changed.`,
  });
}

export async function deleteAllNotifications(user: AuthedUser, rawInput: unknown): Promise<ServiceResult<unknown>> {
  const feed = await getAttentionFeed(user);
  const parsed = deleteAllSchema.safeParse(rawInput);
  if (!parsed.success) {
    return fail(409, "CONFIRMATION_REQUIRED", "Confirm before deleting all notifications.", {
      confirmationRequired: true,
      preview: {
        count: feed.length,
        severities: feed.reduce<Record<string, number>>((counts, item) => {
          counts[item.severity] = (counts[item.severity] ?? 0) + 1;
          return counts;
        }, {}),
      },
    });
  }
  return deleteNotificationsByKeys(user, feed.map((item) => item.key), parsed.data.confirmed);
}
