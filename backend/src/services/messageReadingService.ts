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
 * list can be asked for again. The reading looks at the newest
 * MESSAGES_CONSIDERED messages of the channel each time; a sender pushed out of
 * them by many newer messages meanwhile is passed over like a deleted one.
 */

import { prisma } from "../db.js";
import { namedIn } from "../lib/commandGrammar/shared.js";
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
  /**
   * Present on the first answer only: who has written, and how much. Each
   * sender's newest message rides along for a reader that is not listening —
   * the agent planning a reply sees every sender, not only the first.
   */
  overview?: { senders: Array<{ sender: string; count: number; latest?: ReadMessage }>; unansweredToday: number };
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

/** Messages grouped by who sent them, the sender who wrote last first; within a sender, newest first (ties by id, descending). */
export function groupBySender(rows: IntakeRow[], channel: MessageChannel): SenderGroup[] {
  const groups = new Map<string, SenderGroup>();
  const sorted = [...rows].sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
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

/** A message's place in one sender's list: newest first, ties by id. */
export interface MessageMark {
  at: number;
  id: string;
}

function markOf(message: ReadMessage): MessageMark {
  return { at: message.receivedAt.getTime(), id: message.id };
}

/** Whether a message comes after the mark in the sender's list — is older. */
function isOlder(message: ReadMessage, mark: MessageMark) {
  const at = message.receivedAt.getTime();
  return at < mark.at || (at === mark.at && message.id < mark.id);
}

/** Where a reading is: the order the senders were announced in, who is being read, and how far. */
export interface ReadingPlace {
  channel: MessageChannel;
  order: string[];
  index: number;
  /**
   * The oldest message read so far from the sender at `index`; absent before
   * the first. A position, not a count, so a message that arrives meanwhile
   * cannot make "starší" read one twice or step over one.
   */
  readTo?: MessageMark;
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
  let readTo = place.readTo;
  while (index < order.length && !byKey.has(order[index])) { index += 1; readTo = undefined; }
  const current = index < order.length ? byKey.get(order[index])! : undefined;
  if (!current) return { turn: { channel: place.channel, done: true }, place: { channel: place.channel, order, index } };

  const unread = readTo ? current.messages.filter((message) => isOlder(message, readTo!)) : current.messages;
  const messages = unread.slice(0, MESSAGES_PER_TURN);
  const olderLeft = unread.length - messages.length;
  let nextIndex = index + 1;
  while (nextIndex < order.length && !byKey.has(order[nextIndex])) nextIndex += 1;
  const following = nextIndex < order.length ? byKey.get(order[nextIndex]) : undefined;
  const reached = messages.length ? markOf(messages[messages.length - 1]) : readTo;
  return {
    turn: {
      channel: place.channel,
      sender: { name: current.sender, total: current.messages.length, messages, alreadyRead: current.messages.length - unread.length, olderLeft },
      ...(following ? { next: { sender: following.sender, count: following.messages.length } } : {}),
      done: !following && olderLeft === 0,
    },
    place: { channel: place.channel, order, index, ...(reached ? { readTo: reached } : {}) },
  };
}

interface KeptReading extends ReadingPlace {
  expiresAt: number;
  /** Who was just read and who was named as next, so "přeskoč Petru" can be heard as a name. */
  names: { current?: string; next?: string };
}

const readings = new Map<string, KeptReading>();

function readingKey(user: AuthedUser) {
  return `${user.companyId}:${user.id}`;
}

function remember(user: AuthedUser, place: ReadingPlace, turn: ReadingTurn) {
  const now = Date.now();
  for (const [key, kept] of readings) if (kept.expiresAt < now) readings.delete(key);
  if (turn.done) readings.delete(readingKey(user));
  else readings.set(readingKey(user), { ...place, expiresAt: now + READING_KEPT_MS, names: { current: turn.sender?.name, next: turn.next?.sender } });
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

/**
 * The reading in progress for this user, if any: who was just read and who is
 * next. While there is one, "přeskoč" and "další" mean something.
 */
export function activeReading(user: AuthedUser): { current?: string; next?: string } | undefined {
  return current(user)?.names;
}

async function loadGroups(user: AuthedUser, channel: MessageChannel): Promise<SenderGroup[]> {
  const rows = await prisma.communicationIntake.findMany({
    where: { companyId: user.companyId, channel },
    orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
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
  const { turn, place } = turnAt(groups, { channel, order: groups.map((group) => group.key), index: 0 });
  if (options.remember !== false) remember(user, place, turn);
  return {
    ...turn,
    overview: { senders: groups.map((group) => ({ sender: group.sender, count: group.messages.length, latest: group.messages[0] })), unansweredToday },
  };
}

/**
 * "Přeskoč ho": the next sender. Undefined when nothing is being read.
 *
 * `named` is the name said with it ("přeskoč Petru"). When it names the sender
 * announced as next rather than the one just read, that one is skipped too:
 * the user does not want to hear Petra.
 */
export async function readNextSender(user: AuthedUser, named?: string): Promise<ReadingTurn | undefined> {
  const place = current(user);
  if (!place) return undefined;
  const groups = await loadGroups(user, place.channel);
  const skipsNext = Boolean(named && place.names.next && namedIn(named, place.names.next) && !(place.names.current && namedIn(named, place.names.current)));
  let { turn, place: next } = turnAt(groups, { channel: place.channel, order: place.order, index: place.index + 1 });
  if (skipsNext && turn.sender) ({ turn, place: next } = turnAt(groups, { channel: place.channel, order: next.order, index: next.index + 1 }));
  remember(user, next, turn);
  return turn;
}

/** "Starší zprávy": more from the same sender. Undefined when nothing is being read. */
export async function readOlderFromSender(user: AuthedUser): Promise<ReadingTurn | undefined> {
  const place = current(user);
  if (!place) return undefined;
  const { turn, place: next } = turnAt(await loadGroups(user, place.channel), place);
  remember(user, next, turn);
  return turn;
}

/** Forget a reading (tests, and a new list replaces the old one anyway). */
export function forgetReading(user: AuthedUser) {
  readings.delete(readingKey(user));
}
