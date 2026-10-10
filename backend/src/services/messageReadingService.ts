/**
 * Reading received messages aloud, one sender at a time.
 *
 * "Přečti zprávy na WhatsAppu" used to read the five newest messages whoever
 * sent them, so one person who had written ten times filled the whole answer
 * and nobody else was heard. Marek (10. 10.): "když řeknu přeskoč ho, musí
 * začít číst zprávy od dalšího uživatele".
 *
 * Messages are grouped by sender, the sender who wrote last first. Each answer
 * reads one sender — their newest few messages and how many older ones remain —
 * and names who is next. "Přeskoč ho" / "další" moves to the next sender,
 * "starší zprávy" reads more from the same one.
 *
 * Where the reading is kept: in this process's memory, per user, for a quarter
 * of an hour. It is a place in a list being read out, not a business fact; a
 * restart forgets it and "přeskoč" then says nothing is being read, and the
 * list can be asked for again.
 */

import { prisma } from "../db.js";
import type { AuthedUser } from "../middleware/auth.js";

export type MessageChannel = "email" | "whatsapp";

export interface ReadMessage {
  id: string;
  text: string;
  receivedAt: Date;
  /**
   * WhatsApp: whether Secretary answered it. E-mail: true only when the answer
   * left from Secretary — it may have been answered straight from Gmail, so
   * nothing is claimed otherwise.
   */
  replied?: boolean;
}

export interface SenderGroup {
  /** What identifies the sender: phone for WhatsApp, address for e-mail, else the name. */
  key: string;
  sender: string;
  /** Newest first. */
  messages: ReadMessage[];
}

/** One answer: one sender's messages, and who comes next. */
export interface ReadingTurn {
  channel: MessageChannel;
  /** Present on the first answer only: who has written, and how much. */
  overview?: { senders: Array<{ sender: string; count: number }>; unansweredToday: number };
  sender?: { name: string; total: number; messages: ReadMessage[]; /** read before this answer */ alreadyRead: number; /** older ones not read yet */ olderLeft: number };
  next?: { sender: string; count: number };
  /** Nothing left after this answer. */
  done: boolean;
}

/** How many of one sender's messages are read in one answer. */
export const MESSAGES_PER_TURN = 3;
/** How far back the reading looks. */
export const MESSAGES_CONSIDERED = 60;
const READING_KEPT_MS = 15 * 60 * 1000;

interface IntakeRow {
  id: string;
  senderName: string | null;
  senderEmail: string | null;
  senderPhone: string | null;
  messageText: string;
  receivedAt: Date;
  sourceMetadata: unknown;
}

function answered(metadata: unknown) {
  const replies = metadata && typeof metadata === "object" && !Array.isArray(metadata) ? (metadata as { replies?: unknown }).replies : undefined;
  return Array.isArray(replies) && replies.length > 0;
}

/** Messages grouped by who sent them, the sender who wrote last first; within a sender, newest first. */
export function groupBySender(rows: IntakeRow[], channel: MessageChannel): SenderGroup[] {
  const groups = new Map<string, SenderGroup>();
  const sorted = [...rows].sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime());
  for (const row of sorted) {
    const identity = channel === "whatsapp" ? row.senderPhone ?? row.senderName : row.senderEmail?.toLowerCase() ?? row.senderName;
    const key = identity?.trim() || "unknown";
    const sender = row.senderName?.trim() || row.senderEmail || row.senderPhone || "Unknown sender";
    const message: ReadMessage = {
      id: row.id,
      text: row.messageText,
      receivedAt: row.receivedAt,
      ...(channel === "whatsapp" ? { replied: answered(row.sourceMetadata) } : answered(row.sourceMetadata) ? { replied: true } : {}),
    };
    const group = groups.get(key);
    if (group) group.messages.push(message);
    else groups.set(key, { key, sender, messages: [message] });
  }
  return [...groups.values()];
}

/** Where a reading is: the order the senders were announced in, who is being read, and how much of them. */
export interface ReadingPlace {
  channel: MessageChannel;
  order: string[];
  index: number;
  shown: number;
}

/**
 * The answer at a place in the reading. Senders announced earlier keep their
 * order even if one of them writes again meanwhile; one that has disappeared
 * (deleted) is passed over.
 */
export function turnAt(groups: SenderGroup[], place: ReadingPlace): { turn: ReadingTurn; place: ReadingPlace } {
  const byKey = new Map(groups.map((group) => [group.key, group]));
  // Someone who wrote for the first time after the reading began goes last.
  const order = [...place.order, ...groups.map((group) => group.key).filter((key) => !place.order.includes(key))];
  let index = place.index;
  let shown = place.shown;
  while (index < order.length && !byKey.has(order[index])) { index += 1; shown = 0; }
  const current = index < order.length ? byKey.get(order[index])! : undefined;
  if (!current) return { turn: { channel: place.channel, done: true }, place: { ...place, order, index, shown: 0 } };

  const messages = current.messages.slice(shown, shown + MESSAGES_PER_TURN);
  const read = shown + messages.length;
  const olderLeft = Math.max(0, current.messages.length - read);
  let nextIndex = index + 1;
  while (nextIndex < order.length && !byKey.has(order[nextIndex])) nextIndex += 1;
  const following = nextIndex < order.length ? byKey.get(order[nextIndex]) : undefined;
  return {
    turn: {
      channel: place.channel,
      sender: { name: current.sender, total: current.messages.length, messages, alreadyRead: shown, olderLeft },
      ...(following ? { next: { sender: following.sender, count: following.messages.length } } : {}),
      done: !following && olderLeft === 0,
    },
    place: { channel: place.channel, order, index, shown: read },
  };
}

const readings = new Map<string, ReadingPlace & { expiresAt: number }>();

function readingKey(user: AuthedUser) {
  return `${user.companyId}:${user.id}`;
}

function remember(user: AuthedUser, place: ReadingPlace, done: boolean) {
  const now = Date.now();
  for (const [key, kept] of readings) if (kept.expiresAt < now) readings.delete(key);
  if (done) readings.delete(readingKey(user));
  else readings.set(readingKey(user), { ...place, expiresAt: now + READING_KEPT_MS });
}

function current(user: AuthedUser) {
  const place = readings.get(readingKey(user));
  if (!place) return undefined;
  if (place.expiresAt < Date.now()) {
    readings.delete(readingKey(user));
    return undefined;
  }
  return place;
}

/** Whether messages are being read to this user, so "přeskoč" and "další" mean something. */
export function hasActiveReading(user: AuthedUser): boolean {
  return current(user) !== undefined;
}

async function loadGroups(user: AuthedUser, channel: MessageChannel): Promise<SenderGroup[]> {
  const rows = await prisma.communicationIntake.findMany({
    where: { companyId: user.companyId, channel },
    orderBy: { receivedAt: "desc" },
    take: MESSAGES_CONSIDERED,
    select: { id: true, senderName: true, senderEmail: true, senderPhone: true, messageText: true, receivedAt: true, sourceMetadata: true },
  });
  return groupBySender(rows, channel);
}

/**
 * "Přečti zprávy na WhatsAppu": who has written, then the first sender.
 *
 * `remember: false` reads without becoming the user's reading: the agent
 * looking at messages while it plans must not move the user's place in a
 * reading they are listening to.
 */
export async function startReading(user: AuthedUser, channel: MessageChannel, options: { remember?: boolean } = {}): Promise<ReadingTurn> {
  const groups = await loadGroups(user, channel);
  let unansweredToday = 0;
  if (channel === "whatsapp") {
    const lastDay = await prisma.communicationIntake.findMany({
      where: { companyId: user.companyId, channel, receivedAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
      select: { sourceMetadata: true },
    });
    unansweredToday = lastDay.filter((intake) => !answered(intake.sourceMetadata)).length;
  }
  const { turn, place } = turnAt(groups, { channel, order: groups.map((group) => group.key), index: 0, shown: 0 });
  if (options.remember !== false) remember(user, place, turn.done);
  return { ...turn, overview: { senders: groups.map((group) => ({ sender: group.sender, count: group.messages.length })), unansweredToday } };
}

/** "Přeskoč ho": the next sender. Undefined when nothing is being read. */
export async function readNextSender(user: AuthedUser): Promise<ReadingTurn | undefined> {
  const place = current(user);
  if (!place) return undefined;
  const { turn, place: next } = turnAt(await loadGroups(user, place.channel), { ...place, index: place.index + 1, shown: 0 });
  remember(user, next, turn.done);
  return turn;
}

/** "Starší zprávy": more from the same sender. Undefined when nothing is being read. */
export async function readOlderFromSender(user: AuthedUser): Promise<ReadingTurn | undefined> {
  const place = current(user);
  if (!place) return undefined;
  const { turn, place: next } = turnAt(await loadGroups(user, place.channel), place);
  remember(user, next, turn.done);
  return turn;
}

/** Forget a reading (tests, and a new list replaces the old one anyway). */
export function forgetReading(user: AuthedUser) {
  readings.delete(readingKey(user));
}
