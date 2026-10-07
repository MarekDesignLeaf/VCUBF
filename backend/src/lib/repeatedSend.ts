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

/** The latest successful audited send of exactly this message within the window. */
export async function recentAuditedSend(companyId: string, actionName: string, fingerprint: string, now = Date.now()): Promise<AlreadySent | null> {
  const recent = await prisma.auditLog.findMany({
    where: { companyId, actionName, result: "success", createdAt: { gte: new Date(now - REPEAT_WINDOW_MS) } },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true, dataAfter: true },
    take: 50,
  });
  const match = recent.find((row) => {
    const after = row.dataAfter;
    return Boolean(after && typeof after === "object" && !Array.isArray(after)
      && (after as Record<string, unknown>).contentFingerprint === fingerprint);
  });
  return match ? alreadySent(match.createdAt, now) : null;
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

/** The review's note, spread into a preview: present only when there is something to say. */
export function repeatNote(repeat: AlreadySent | null): { alreadySent?: AlreadySent } {
  return repeat ? { alreadySent: repeat } : {};
}
