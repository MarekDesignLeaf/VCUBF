import crypto from "node:crypto";
import { prisma } from "../db.js";

/**
 * "You already sent exactly this a few minutes ago."
 *
 * A voice request that gets no answer in time may still have been carried out
 * (section 44, unknown outcomes). The owner is told to check before saying it
 * again; this is the check, done for him. When a message is put up for review,
 * a send of the same text to the same recipients shortly before is found and
 * said in the review, so the yes is given knowing it would be a second copy.
 *
 * It only informs. The yes still sends, because sending the same words twice
 * on purpose is a legitimate thing to do.
 */

/** How far back an identical message counts as just sent. */
export const REPEAT_WINDOW_MS = 30 * 60 * 1000;

export interface AlreadySent {
  sentAt: string;
  /** Whole minutes, so the review can say "3 minutes ago". */
  minutesAgo: number;
}

function words(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

/**
 * A keyed hash of who a message goes to and what it says. It is what the audit
 * keeps, never the words: an audit record holds no message text, and without
 * the server's key the hash cannot be matched against guessed messages.
 */
export function sendFingerprint(message: { recipients: string[]; subject?: string | null; body: string }): string {
  const key = process.env.JWT_SECRET ?? "dev-secret-change-me";
  const recipients = message.recipients.map((recipient) => words(recipient).toLowerCase()).sort();
  return crypto.createHmac("sha256", `repeated-send:${key}`)
    .update(JSON.stringify([recipients, words(message.subject), words(message.body)]))
    .digest("hex");
}

function alreadySent(sentAt: Date, now: number): AlreadySent {
  return { sentAt: sentAt.toISOString(), minutesAgo: Math.max(0, Math.floor((now - sentAt.getTime()) / 60_000)) };
}

/**
 * The latest successful audited send of exactly this message within the
 * window. Matched in the database, so every send in the window is searched,
 * however many there were.
 */
export async function recentAuditedSend(companyId: string, actionName: string, fingerprint: string, now = Date.now()): Promise<AlreadySent | null> {
  const match = await prisma.auditLog.findFirst({
    where: {
      companyId,
      actionName,
      result: "success",
      createdAt: { gte: new Date(now - REPEAT_WINDOW_MS) },
      dataAfter: { path: ["contentFingerprint"], equals: fingerprint },
    },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  return match ? alreadySent(match.createdAt, now) : null;
}

/**
 * An email's recipients with their role kept: the same addresses moved between
 * To, Cc and Bcc is a different email, because who sees whom changes.
 */
export function emailRecipients(message: { to: string[]; cc: string[]; bcc: string[] }): string[] {
  return [
    ...message.to.map((address) => `to:${address.trim()}`),
    ...message.cc.map((address) => `cc:${address.trim()}`),
    ...message.bcc.map((address) => `bcc:${address.trim()}`),
  ];
}

/** A reply is "the same" when it answers the same received message with the same words. */
export function replyFingerprint(intakeId: string, body: string): string {
  return sendFingerprint({ recipients: [`reply-to:${intakeId}`], body });
}

/**
 * The same for a reply: the replies already sent are kept on the received
 * message they answer, with their text, so they are compared there.
 */
export function recentReply(sourceMetadata: unknown, body: string, now = Date.now()): AlreadySent | null {
  const metadata = sourceMetadata && typeof sourceMetadata === "object" && !Array.isArray(sourceMetadata)
    ? sourceMetadata as Record<string, unknown>
    : {};
  const replies = Array.isArray(metadata.replies) ? metadata.replies : [];
  const text = words(body);
  let latest: Date | null = null;
  for (const reply of replies) {
    if (!reply || typeof reply !== "object") continue;
    const { body: sentBody, sentAt } = reply as { body?: unknown; sentAt?: unknown };
    const at = typeof sentAt === "string" ? new Date(sentAt) : null;
    if (!at || Number.isNaN(at.getTime()) || now - at.getTime() > REPEAT_WINDOW_MS) continue;
    if (words(sentBody) !== text) continue;
    if (!latest || at > latest) latest = at;
  }
  return latest ? alreadySent(latest, now) : null;
}

/**
 * A reply already sent: from the replies kept on the message it answers, or,
 * if keeping that note failed after the reply left, from the audit, which
 * records every successful reply with its fingerprint.
 */
export async function recentReplyOrAudited(companyId: string, actionName: string, intake: { id: string; sourceMetadata: unknown }, body: string, now = Date.now()): Promise<AlreadySent | null> {
  // Both are read: an older reply may be noted on the message while a newer
  // one's note failed, and the review must name the latest.
  const noted = recentReply(intake.sourceMetadata, body, now);
  const audited = await recentAuditedSend(companyId, actionName, replyFingerprint(intake.id, body), now);
  if (!noted || !audited) return noted ?? audited;
  return Date.parse(noted.sentAt) >= Date.parse(audited.sentAt) ? noted : audited;
}

/** The review's note, spread into a preview: present only when there is something to say. */
export function repeatNote(repeat: AlreadySent | null): { alreadySent?: AlreadySent } {
  return repeat ? { alreadySent: repeat } : {};
}
