import { z } from "zod";
import { prisma } from "../db.js";
import { recordAudit } from "../lib/audit.js";
import { SEND_NOTIFICATION_DIGEST_ACTION, UPDATE_NOTIFICATION_DIGEST_PREFERENCES_ACTION } from "../lib/actionContracts.js";
import type { AuthedUser } from "../middleware/auth.js";
import { resolveSendableGmailSource, sendThroughGmailSource } from "./gmailConnectorService.js";
import { getAttentionFeed, type AttentionItem } from "./notificationService.js";
import { fail, ok, type ServiceResult } from "./result.js";

// Notification digest — the attention feed is otherwise pull-only. This is
// the smallest safe push: a plain-text summary of the user's *own* computed
// feed, sent to that user's *own* account email through the company's
// already authorised Gmail source.
//
// Deliberate boundaries:
//  - Opt-in per user; nothing is sent for a user who has not enabled it.
//  - The recipient is always the account email of the user the digest is
//    about. There is no typed-in recipient, so a digest can never reach a
//    client or any external address by mistake.
//  - Nothing is invented: every line is an item the feed already computed.
//  - A manual send shows the exact message and requires confirmation; the
//    scheduled sweep sends only the same content, once per day, for users who
//    turned it on themselves.

export const digestPreferencesSchema = z.object({
  enabled: z.boolean(),
  hour_utc: z.number().int().min(0).max(23),
}).strict();

export interface DigestContent {
  subject: string;
  body: string;
  itemCount: number;
  urgentCount: number;
}

function digestLine(item: AttentionItem) {
  const due = item.dueAt ? ` (due ${new Date(item.dueAt).toISOString().slice(0, 10)})` : "";
  return `- [${item.severity}] ${item.title}${due}: ${item.message}`;
}

/** Build the digest from the user's real feed. Returns null when there is nothing to report. */
export async function buildNotificationDigest(user: AuthedUser): Promise<DigestContent | null> {
  const items = await getAttentionFeed(user);
  const outstanding = items.filter((item) => !item.acknowledged);
  if (outstanding.length === 0) return null;
  const urgent = outstanding.filter((item) => item.severity === "urgent");
  const warnings = outstanding.filter((item) => item.severity === "warning");
  const info = outstanding.filter((item) => item.severity !== "urgent" && item.severity !== "warning");
  const sections = [
    urgent.length ? `Urgent (${urgent.length})\n${urgent.map(digestLine).join("\n")}` : "",
    warnings.length ? `Warnings (${warnings.length})\n${warnings.map(digestLine).join("\n")}` : "",
    info.length ? `For information (${info.length})\n${info.map(digestLine).join("\n")}` : "",
  ].filter(Boolean);
  return {
    subject: `Secretary digest: ${outstanding.length} item(s) need attention${urgent.length ? `, ${urgent.length} urgent` : ""}`,
    body: `${sections.join("\n\n")}\n\nThis digest lists what Secretary already computed from your own records. Open Notifications to acknowledge or act on an item.`,
    itemCount: outstanding.length,
    urgentCount: urgent.length,
  };
}

export async function getDigestPreferences(user: AuthedUser) {
  const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { email: true, digestEnabled: true, digestHourUtc: true, digestLastSentAt: true } });
  return {
    enabled: row.digestEnabled,
    hourUtc: row.digestHourUtc,
    recipient: row.email,
    lastSentAt: row.digestLastSentAt?.toISOString() ?? null,
  };
}

export async function updateDigestPreferences(user: AuthedUser, rawInput: unknown): Promise<ServiceResult<Awaited<ReturnType<typeof getDigestPreferences>>>> {
  const parsed = digestPreferencesSchema.safeParse(rawInput);
  if (!parsed.success) {
    await recordAudit({ companyId: user.companyId, userId: user.id, actionName: UPDATE_NOTIFICATION_DIGEST_PREFERENCES_ACTION.actionName, inputPayload: rawInput, riskLevel: UPDATE_NOTIFICATION_DIGEST_PREFERENCES_ACTION.riskLevel, result: "error", errorMessage: "VALIDATION_FAILED" });
    return fail(400, "VALIDATION_FAILED", parsed.error.message);
  }
  const before = await getDigestPreferences(user);
  await prisma.user.update({ where: { id: user.id }, data: { digestEnabled: parsed.data.enabled, digestHourUtc: parsed.data.hour_utc } });
  const after = await getDigestPreferences(user);
  await recordAudit({ companyId: user.companyId, userId: user.id, actionName: UPDATE_NOTIFICATION_DIGEST_PREFERENCES_ACTION.actionName, inputPayload: parsed.data, dataBefore: before, dataAfter: after, riskLevel: UPDATE_NOTIFICATION_DIGEST_PREFERENCES_ACTION.riskLevel, result: "success" });
  return ok(200, after);
}

interface SendOptions {
  /** Scheduled sends skip the interactive confirmation: the user's own opt-in is the authorisation. */
  scheduled?: boolean;
  confirmed?: boolean;
}

export async function sendNotificationDigest(user: AuthedUser, options: SendOptions = {}): Promise<ServiceResult<unknown>> {
  const audit = (extra: Record<string, unknown>) => recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: SEND_NOTIFICATION_DIGEST_ACTION.actionName,
    riskLevel: SEND_NOTIFICATION_DIGEST_ACTION.riskLevel,
    confirmationRequired: SEND_NOTIFICATION_DIGEST_ACTION.confirmationRequired,
    ...extra,
  } as Parameters<typeof recordAudit>[0]);

  const preferences = await getDigestPreferences(user);
  if (!preferences.enabled) {
    await audit({ inputPayload: { scheduled: Boolean(options.scheduled) }, result: "error", errorMessage: "DIGEST_DISABLED" });
    return fail(409, "DIGEST_DISABLED", "Turn the daily digest on for your account before sending it.");
  }
  const digest = await buildNotificationDigest(user);
  if (!digest) {
    await audit({ inputPayload: { scheduled: Boolean(options.scheduled) }, result: "error", errorMessage: "DIGEST_EMPTY" });
    return fail(409, "DIGEST_EMPTY", "Nothing currently needs attention, so there is no digest to send.");
  }
  const source = await resolveSendableGmailSource(user);
  if (!source.ok) {
    await audit({ inputPayload: { scheduled: Boolean(options.scheduled) }, result: "error", errorMessage: source.error });
    return source;
  }

  const preview = {
    to: [preferences.recipient],
    source: source.data,
    subject: digest.subject,
    body: digest.body,
    itemCount: digest.itemCount,
    urgentCount: digest.urgentCount,
  };
  if (!options.confirmed && !options.scheduled) {
    await audit({ inputPayload: { confirmed: false, itemCount: digest.itemCount }, result: "rejected", errorMessage: "CONFIRMATION_REQUIRED" });
    return fail(409, "CONFIRMATION_REQUIRED", "Review the digest, then confirm sending it to your own account email.", { preview });
  }

  const sent = await sendThroughGmailSource(user, source.data.id, { to: [preferences.recipient], subject: digest.subject, body: digest.body });
  if (!sent.ok) {
    await audit({ inputPayload: { confirmed: true, scheduled: Boolean(options.scheduled), itemCount: digest.itemCount }, result: "error", errorMessage: sent.error });
    return sent;
  }
  await prisma.user.update({ where: { id: user.id }, data: { digestLastSentAt: sent.data.sentAt } });
  await audit({
    inputPayload: { confirmed: true, scheduled: Boolean(options.scheduled), itemCount: digest.itemCount, urgentCount: digest.urgentCount, recipientCount: 1, subjectLength: digest.subject.length, bodyLength: digest.body.length },
    dataAfter: { messageId: sent.data.messageId, sentAt: sent.data.sentAt },
    confirmed: true,
    result: "success",
  });
  return ok(200, { ...sent.data, itemCount: digest.itemCount, urgentCount: digest.urgentCount, to: [preferences.recipient] });
}

export interface DigestSweepSummary {
  considered: number;
  sent: number;
  skipped: number;
  failed: number;
}

function alreadySentToday(lastSentAt: Date | null, now: Date) {
  return Boolean(lastSentAt && lastSentAt.toISOString().slice(0, 10) === now.toISOString().slice(0, 10));
}

/**
 * Scheduled sweep: sends each opted-in user's own digest once a day, at or
 * after their chosen UTC hour. A user who has already received today's digest,
 * has nothing to report, or whose company has no sendable Gmail source is
 * skipped silently — the failure is already recorded in that user's audit log.
 */
export async function runNotificationDigestSweep(now = new Date()): Promise<DigestSweepSummary> {
  const candidates = await prisma.user.findMany({
    where: { digestEnabled: true, isActive: true, digestHourUtc: { lte: now.getUTCHours() } },
  });
  const summary: DigestSweepSummary = { considered: candidates.length, sent: 0, skipped: 0, failed: 0 };
  for (const candidate of candidates) {
    if (alreadySentToday(candidate.digestLastSentAt, now)) { summary.skipped += 1; continue; }
    const actor: AuthedUser = {
      id: candidate.id,
      companyId: candidate.companyId,
      email: candidate.email,
      displayName: candidate.displayName,
      role: candidate.role,
      permissions: candidate.permissions,
      mustChangePassword: candidate.mustChangePassword,
      voiceWakeWord: candidate.voiceWakeWord,
      voiceContinuous: candidate.voiceContinuous,
      voiceLanguage: candidate.voiceLanguage,
      assistantName: candidate.assistantName,
      voiceSpeechRate: candidate.voiceSpeechRate,
    };
    try {
      const result = await sendNotificationDigest(actor, { scheduled: true });
      if (result.ok) summary.sent += 1;
      else if (result.error === "DIGEST_EMPTY") summary.skipped += 1;
      else summary.failed += 1;
    } catch {
      summary.failed += 1;
    }
  }
  return summary;
}
