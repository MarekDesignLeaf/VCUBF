// Writing to the owner's Google calendar: create, move and cancel one event.
//
// Every write is reviewed before it happens. The date and time words the
// person said are resolved here, in the calendar's own time zone, and read
// back together with any events they would clash with. The yes then writes
// exactly what was reviewed (section 41):
// - a new event carries an id chosen at review, so a retried confirmation
//   finds the event it already created instead of creating a second one;
// - a move or cancellation carries the event's etag from review, so an event
//   someone changed in the meantime is refused rather than overwritten.
// Recurring events are refused: moving or deleting one would change a series
// the person did not review. Nobody else is emailed by these writes.

import { randomBytes } from "node:crypto";
import { z } from "zod";
import { prisma } from "../db.js";
import { decryptConnectorPayload } from "../connectors/connectorCrypto.js";
import {
  deleteGoogleCalendarEvent,
  getGoogleCalendarEvent,
  GOOGLE_CALENDAR_EVENTS_SCOPE,
  GoogleCalendarAdapterError,
  insertGoogleCalendarEvent,
  patchGoogleCalendarEvent,
  type EventDateTime,
  type GoogleCalendarEvent,
  type StoredGoogleCalendarCredential,
} from "../connectors/googleCalendarAdapter.js";
import {
  CANCEL_GOOGLE_CALENDAR_EVENT_ACTION,
  CREATE_GOOGLE_CALENDAR_EVENT_ACTION,
  MOVE_GOOGLE_CALENDAR_EVENT_ACTION,
  type ActionContract,
} from "../lib/actionContracts.js";
import { recordAudit } from "../lib/audit.js";
import { addDays, addMinutesToLocal, localDateTime, resolveSpokenDate, resolveSpokenTime, zonedInstant } from "../lib/spokenDate.js";
import type { AuthedUser } from "../middleware/auth.js";
import { providerError, usable, type Source } from "./googleCalendarConnectorService.js";
import { fail, ok, type ServiceResult } from "./result.js";

const DEFAULT_DURATION_MINUTES = 60;
const LOOKUP_DAYS = 60;
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{2}:\d{2}$/;
const BASE32HEX = "0123456789abcdefghijklmnopqrstuv";

const createSchema = z.object({
  title: z.string().trim().min(1).max(300),
  date: z.string().trim().min(1).max(60),
  time: z.string().trim().min(1).max(20).optional(),
  end_time: z.string().trim().min(1).max(20).optional(),
  duration_minutes: z.coerce.number().int().min(5).max(24 * 60).optional(),
  location: z.string().trim().min(1).max(500).optional(),
  description: z.string().trim().min(1).max(4000).optional(),
  /** Chosen at review and carried by the confirmation. */
  event_id: z.string().regex(/^[a-v0-9]{20,64}$/).optional(),
  confirmed: z.boolean().optional(),
}).strict();

const referenceFields = {
  /** Words from the event's title as spoken. */
  event: z.string().trim().min(1).max(300).optional(),
  /** The day the event is on, as spoken; narrows the search. */
  on_date: z.string().trim().min(1).max(60).optional(),
  /** Exact event and version reviewed; carried by the confirmation. */
  calendar_event_id: z.string().uuid().optional(),
  etag: z.string().min(1).max(200).optional(),
  confirmed: z.boolean().optional(),
};
const moveSchema = z.object({
  ...referenceFields,
  new_date: z.string().trim().min(1).max(60).optional(),
  new_time: z.string().trim().min(1).max(20).optional(),
}).strict();
const cancelSchema = z.object(referenceFields).strict();

const context = (companyId: string, sourceId: string) => `${companyId}:${sourceId}:google_calendar`;

function newEventId() {
  const bytes = randomBytes(26);
  return [...bytes].map((byte) => BASE32HEX[byte % 32]).join("");
}

/**
 * Czech and Polish change word endings ("závlaha" / "Kontrola závlahy",
 * "Dvořák" / "u Dvořáků"), so a spoken word matches a title word that shares
 * all but its last two letters.
 */
function sameWord(spoken: string, title: string) {
  if (title.startsWith(spoken) || spoken.startsWith(title)) return true;
  if (spoken.length < 5 || title.length < 5) return false;
  let common = 0;
  while (common < spoken.length && common < title.length && spoken[common] === title[common]) common++;
  return common >= Math.min(spoken.length, title.length) - 2;
}

function plainText(value: unknown) {
  return String(value ?? "").normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase("en").replace(/\s+/g, " ").trim();
}

interface WriteTarget {
  source: Source;
  calendar: { id: string; externalCalendarId: string; summary: string; timeZone: string };
}

/** The one enabled Google Calendar source allowed to write, and its primary calendar. */
async function writeTarget(user: AuthedUser): Promise<ServiceResult<WriteTarget>> {
  const sources = await prisma.connectorSource.findMany({
    where: { companyId: user.companyId, connectorKey: "google_calendar", isActive: true },
    include: { credential: true },
    orderBy: { createdAt: "asc" },
  });
  const enabled = sources.filter((source) => source.isEnabled && source.credential);
  if (!enabled.length) return fail(409, "GOOGLE_CALENDAR_NOT_CONFIGURED", "Google Calendar is not connected and enabled.");
  const writable = enabled.filter((source) => source.configuredScopes.includes("write:events"));
  if (!writable.length) {
    return fail(409, "CALENDAR_WRITE_NOT_AUTHORIZED", "Google Calendar is connected read-only. On the Connectors page choose “Allow calendar writing” and approve it at Google.");
  }
  if (writable.length > 1) return fail(409, "AMBIGUOUS_CALENDAR_SOURCE", "More than one Google Calendar connection can write; keep one enabled.");
  const source = writable[0];
  const credential = decryptConnectorPayload<StoredGoogleCalendarCredential>(source.credential!, context(source.companyId, source.id));
  if (!credential.scopes?.includes(GOOGLE_CALENDAR_EVENTS_SCOPE)) {
    return fail(409, "CALENDAR_WRITE_NOT_AUTHORIZED", "Google has not granted calendar writing yet. On the Connectors page choose “Allow calendar writing” and approve it at Google.");
  }
  const calendar = await prisma.externalCalendar.findFirst({
    where: { companyId: user.companyId, connectorSourceId: source.id, isDeleted: false, isPrimary: true },
  });
  if (!calendar) return fail(409, "CALENDAR_SYNC_REQUIRED", "Synchronise Google Calendar first so Secretary knows the primary calendar.");
  if (!calendar.timeZone) return fail(409, "CALENDAR_TIME_ZONE_UNKNOWN", "The primary calendar has no time zone; synchronise Google Calendar again.");
  return ok(200, { source, calendar: { id: calendar.id, externalCalendarId: calendar.externalCalendarId, summary: calendar.summary, timeZone: calendar.timeZone } });
}

function weekdayName(dateKey: string, language: string) {
  const [year, month, day] = dateKey.split("-").map(Number);
  try {
    return new Intl.DateTimeFormat(language, { weekday: "long", timeZone: "UTC" }).format(new Date(Date.UTC(year, month - 1, day)));
  } catch {
    return new Intl.DateTimeFormat("en-GB", { weekday: "long", timeZone: "UTC" }).format(new Date(Date.UTC(year, month - 1, day)));
  }
}

interface Slot { allDay: boolean; date: string; time?: string; endDate: string; endTime?: string }

function slotToGoogle(slot: Slot, timeZone: string): { start: EventDateTime; end: EventDateTime } {
  if (slot.allDay) return { start: { date: slot.date }, end: { date: slot.endDate } };
  return {
    start: { dateTime: `${slot.date}T${slot.time}:00`, timeZone },
    end: { dateTime: `${slot.endDate}T${slot.endTime}:00`, timeZone },
  };
}

function slotFromGoogle(event: GoogleCalendarEvent, timeZone: string): Slot | undefined {
  if (event.start?.date && event.end?.date) return { allDay: true, date: event.start.date, endDate: event.end.date };
  if (!event.start?.dateTime || !event.end?.dateTime) return undefined;
  const start = new Date(event.start.dateTime);
  const end = new Date(event.end.dateTime);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return undefined;
  const zone = event.start.timeZone || timeZone;
  const from = localDateTime(start, zone);
  const to = localDateTime(end, zone);
  return { allDay: false, date: from.date, time: from.time, endDate: to.date, endTime: to.time };
}

function slotSummary(slot: Slot, language: string) {
  // An all-day event's end date is exclusive; the review names the last day it covers.
  const lastDate = slot.allDay ? addDays(slot.endDate, -1) : slot.endDate;
  return {
    allDay: slot.allDay,
    date: slot.date,
    weekday: weekdayName(slot.date, language),
    ...(slot.allDay
      ? (lastDate > slot.date ? { lastDate } : {})
      : { start: slot.time, end: slot.endTime, ...(slot.endDate !== slot.date ? { endDate: slot.endDate } : {}) }),
  };
}

function slotInstants(slot: Slot, timeZone: string) {
  if (slot.allDay) return { start: zonedInstant(slot.date, "00:00", timeZone), end: zonedInstant(slot.endDate, "00:00", timeZone) };
  return { start: zonedInstant(slot.date, slot.time!, timeZone), end: zonedInstant(slot.endDate, slot.endTime!, timeZone) };
}

/** Events already in the calendar that the slot would overlap. */
async function clashes(user: AuthedUser, target: WriteTarget, slot: Slot, excludeId?: string) {
  const { start, end } = slotInstants(slot, target.calendar.timeZone);
  const timed = await prisma.externalCalendarEvent.findMany({
    where: {
      companyId: user.companyId,
      connectorSourceId: target.source.id,
      isDeleted: false,
      ...(excludeId ? { id: { not: excludeId } } : {}),
      OR: [
        { startAt: { lt: end }, endAt: { gt: start } },
        // All-day events: one that starts within the slot's days, or one that
        // started earlier and is still running on its first day (Google's end
        // date is the day after the last).
        { startDate: { lt: slot.allDay ? slot.endDate : addDays(slot.endDate, 1), gte: slot.date } },
        { startDate: { lt: slot.date }, endDate: { gt: slot.date } },
      ],
    },
    orderBy: [{ startAt: "asc" }, { startDate: "asc" }],
    // Enough that the review can say how many there are, not only the first few.
    take: 50,
  });
  return timed.map((event) => ({
    title: event.summary || "Untitled event",
    ...(event.startAt ? { start: localDateTime(event.startAt, target.calendar.timeZone) } : { date: event.startDate }),
  }));
}

async function audit(user: AuthedUser, action: ActionContract, input: Record<string, unknown>, outcome: { result: "success" | "rejected" | "error"; error?: string; confirmed?: boolean; dataAfter?: Record<string, unknown> }) {
  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: action.actionName,
    inputPayload: input,
    ...(outcome.dataAfter ? { dataAfter: outcome.dataAfter } : {}),
    riskLevel: action.riskLevel,
    confirmationRequired: true,
    ...(outcome.confirmed ? { confirmed: true } : {}),
    result: outcome.result,
    ...(outcome.error ? { errorMessage: outcome.error } : {}),
  });
}

/** Keeps the local copy in step, so the agenda shows the change at once. */
async function stage(target: WriteTarget, event: GoogleCalendarEvent) {
  if (!event.id) return;
  const startAt = event.start?.dateTime ? new Date(event.start.dateTime) : null;
  const endAt = event.end?.dateTime ? new Date(event.end.dateTime) : null;
  const data = {
    sourceEtag: event.etag, status: event.status ?? "confirmed", summary: event.summary?.slice(0, 1000),
    description: event.description?.slice(0, 10000), location: event.location?.slice(0, 1000),
    startAt, endAt, startDate: event.start?.date ?? null, endDate: event.end?.date ?? null,
    timeZone: event.start?.timeZone ?? target.calendar.timeZone, htmlLink: event.htmlLink, isDeleted: false, syncedAt: new Date(),
  };
  try {
    await prisma.externalCalendarEvent.upsert({
      where: { externalCalendarRecordId_externalEventId: { externalCalendarRecordId: target.calendar.id, externalEventId: event.id } },
      create: { companyId: target.source.companyId, connectorSourceId: target.source.id, externalCalendarRecordId: target.calendar.id, externalEventId: event.id, ...data },
      update: data,
    });
  } catch {
    // Google already holds the change; the next synchronisation repairs the copy.
  }
}

export async function createCalendarEvent(user: AuthedUser, raw: unknown): Promise<ServiceResult<unknown>> {
  const parsed = createSchema.safeParse(raw);
  if (!parsed.success) return fail(400, "VALIDATION_FAILED", parsed.error.message);
  const input = parsed.data;
  if (input.confirmed && (!input.event_id || !DATE_KEY.test(input.date))) {
    return fail(400, "VALIDATION_FAILED", "Confirm the reviewed event; it carries the exact date and event id.");
  }
  const target = await writeTarget(user);
  if (!target.ok) return target;
  const timeZone = target.data.calendar.timeZone;
  const today = localDateTime(new Date(), timeZone).date;
  const date = resolveSpokenDate(input.date, today);
  if (!date) return fail(400, "CALENDAR_DATE_NOT_UNDERSTOOD", `The date '${input.date}' was not understood. Say it as a day name, “tomorrow” or a date like 6 October.`);
  if (date < today) return fail(409, "CALENDAR_DATE_IN_PAST", `${date} is in the past.`);

  let slot: Slot;
  let durationAssumed = false;
  if (input.time) {
    const time = resolveSpokenTime(input.time);
    if (!time) return fail(400, "CALENDAR_TIME_NOT_UNDERSTOOD", `The time '${input.time}' was not understood. Use the 24-hour clock, for example 14:30.`);
    let end: { date: string; time: string };
    if (input.end_time) {
      const endTime = resolveSpokenTime(input.end_time);
      if (!endTime) return fail(400, "CALENDAR_TIME_NOT_UNDERSTOOD", `The end time '${input.end_time}' was not understood.`);
      end = { date: endTime > time ? date : addDays(date, 1), time: endTime };
    } else {
      durationAssumed = input.duration_minutes === undefined;
      end = addMinutesToLocal(date, time, input.duration_minutes ?? DEFAULT_DURATION_MINUTES);
    }
    slot = { allDay: false, date, time, endDate: end.date, endTime: end.time };
  } else {
    slot = { allDay: true, date, endDate: addDays(date, 1) };
  }

  const eventId = input.event_id ?? newEventId();
  const body = {
    id: eventId,
    summary: input.title,
    ...(input.location ? { location: input.location } : {}),
    ...(input.description ? { description: input.description } : {}),
    ...slotToGoogle(slot, timeZone),
  };
  const auditInput = { sourceId: target.data.source.id, eventId, date: slot.date, allDay: slot.allDay, titleLength: input.title.length };

  if (!input.confirmed) {
    const preview = {
      provider: "google_calendar",
      calendar: target.data.calendar.summary,
      timeZone,
      title: input.title,
      ...slotSummary(slot, user.voiceLanguage),
      ...(slot.allDay ? {} : { durationMinutes: Math.round((slotInstants(slot, timeZone).end.getTime() - slotInstants(slot, timeZone).start.getTime()) / 60_000) }),
      ...(durationAssumed ? { durationAssumed: true } : {}),
      ...(input.location ? { location: input.location } : {}),
      clashes: await clashes(user, target.data, slot),
      othersNotified: false,
    };
    await audit(user, CREATE_GOOGLE_CALENDAR_EVENT_ACTION, { ...auditInput, confirmed: false }, { result: "rejected", error: "CONFIRMATION_REQUIRED" });
    return fail(409, "CONFIRMATION_REQUIRED", "Review the event and confirm to write it to the calendar.", {
      preview,
      confirmInput: {
        event_id: eventId,
        title: input.title,
        date: slot.date,
        ...(slot.allDay ? {} : { time: slot.time, end_time: slot.endTime }),
        ...(input.location ? { location: input.location } : {}),
        ...(input.description ? { description: input.description } : {}),
      },
    });
  }

  try {
    const auth = await usable(target.data.source);
    let created: GoogleCalendarEvent;
    let alreadyCreated = false;
    try {
      created = await insertGoogleCalendarEvent(auth.accessToken, target.data.calendar.externalCalendarId, body);
    } catch (error) {
      // The same reviewed event was already written by an earlier yes whose
      // answer was lost: report that event rather than creating another.
      if (!(error instanceof GoogleCalendarAdapterError) || error.code !== "CALENDAR_EVENT_ALREADY_EXISTS") throw error;
      created = await getGoogleCalendarEvent(auth.accessToken, target.data.calendar.externalCalendarId, eventId);
      if (created.summary !== input.title) throw error;
      alreadyCreated = true;
    }
    await stage(target.data, created);
    const result = { eventId: created.id, title: created.summary, ...slotSummary(slot, user.voiceLanguage), htmlLink: created.htmlLink, alreadyCreated };
    await audit(user, CREATE_GOOGLE_CALENDAR_EVENT_ACTION, { ...auditInput, confirmed: true }, { result: "success", confirmed: true, dataAfter: { eventId: created.id, alreadyCreated } });
    return ok(200, result);
  } catch (error) {
    const result = providerError(error);
    await audit(user, CREATE_GOOGLE_CALENDAR_EVENT_ACTION, { ...auditInput, confirmed: true }, { result: "error", confirmed: true, error: result.ok ? "CONNECTOR_INTERNAL_ERROR" : result.error });
    return result;
  }
}

type Reference = { event?: string; on_date?: string; calendar_event_id?: string };

/** Finds one upcoming event by title words and/or its day; refuses to guess between several. */
async function findEvent(user: AuthedUser, target: WriteTarget, reference: Reference) {
  if (reference.calendar_event_id) {
    const event = await prisma.externalCalendarEvent.findFirst({
      where: { id: reference.calendar_event_id, companyId: user.companyId, connectorSourceId: target.source.id, externalCalendarRecordId: target.calendar.id, isDeleted: false },
    });
    return event ? ok(200, event) : fail(404, "CALENDAR_EVENT_NOT_FOUND", "That calendar event was not found.");
  }
  if (!reference.event && !reference.on_date) return fail(400, "VALIDATION_FAILED", "Say which event: words from its title, its day, or both.");
  const timeZone = target.calendar.timeZone;
  const today = localDateTime(new Date(), timeZone).date;
  let day: string | undefined;
  if (reference.on_date) {
    day = resolveSpokenDate(reference.on_date, today);
    if (!day) return fail(400, "CALENDAR_DATE_NOT_UNDERSTOOD", `The date '${reference.on_date}' was not understood.`);
  }
  const from = day ?? today;
  const until = day ? addDays(day, 1) : addDays(today, LOOKUP_DAYS);
  const candidates = await prisma.externalCalendarEvent.findMany({
    where: {
      companyId: user.companyId,
      connectorSourceId: target.source.id,
      externalCalendarRecordId: target.calendar.id,
      isDeleted: false,
      OR: [
        { startAt: { gte: zonedInstant(from, "00:00", timeZone), lt: zonedInstant(until, "00:00", timeZone) } },
        { startDate: { gte: from, lt: until } },
      ],
    },
    orderBy: [{ startAt: "asc" }, { startDate: "asc" }],
    take: 500,
  });
  const needle = plainText(reference.event);
  const words = needle.split(" ").filter((word) => word.length >= 3);
  const matches = needle
    ? candidates.filter((event) => {
      const title = plainText(event.summary);
      const titleWords = title.split(" ");
      return title.includes(needle) || (words.length > 0 && words.every((word) => titleWords.some((titleWord) => sameWord(word, titleWord))));
    })
    : candidates;
  if (!matches.length) return fail(404, "CALENDAR_EVENT_NOT_FOUND", `No upcoming calendar event matches${reference.event ? ` '${reference.event}'` : ""}${day ? ` on ${day}` : ""}.`);
  if (matches.length > 1) {
    const listed = matches.slice(0, 5).map((event) => `${event.summary || "Untitled event"} (${event.startAt ? `${localDateTime(event.startAt, timeZone).date} ${localDateTime(event.startAt, timeZone).time}` : event.startDate})`);
    return fail(409, "AMBIGUOUS_REFERENCE", `More than one event matches: ${listed.join("; ")}. Say its day or more of its title.`, { candidates: listed });
  }
  return ok(200, matches[0]);
}

/** Fetches the live event and refuses one that is part of a recurring series. */
async function liveEvent(target: WriteTarget, externalEventId: string) {
  const auth = await usable(target.source);
  const live = await getGoogleCalendarEvent(auth.accessToken, target.calendar.externalCalendarId, externalEventId);
  if (live.status === "cancelled") throw new GoogleCalendarAdapterError("CALENDAR_EVENT_NOT_FOUND");
  return { auth, live, recurring: Boolean(live.recurrence?.length || live.recurringEventId) };
}

function recurringRefused() {
  return fail(409, "CALENDAR_RECURRING_NOT_SUPPORTED", "This event repeats. Changing it would change the whole series, which Secretary does not do yet; change it in Google Calendar.");
}

function changedSinceReview() {
  return fail(409, "CALENDAR_EVENT_CHANGED", "The event was changed in Google Calendar after you reviewed it, so nothing was changed. Ask again to see it as it is now.");
}

export async function moveCalendarEvent(user: AuthedUser, raw: unknown): Promise<ServiceResult<unknown>> {
  const parsed = moveSchema.safeParse(raw);
  if (!parsed.success) return fail(400, "VALIDATION_FAILED", parsed.error.message);
  const input = parsed.data;
  if (input.confirmed && (!input.calendar_event_id || !input.etag || !input.new_date || !DATE_KEY.test(input.new_date) || (input.new_time && !TIME.test(input.new_time)))) {
    return fail(400, "VALIDATION_FAILED", "Confirm the reviewed move; it carries the exact event, its version and the new time.");
  }
  if (!input.new_date && !input.new_time) return fail(400, "VALIDATION_FAILED", "Say the new day, the new time, or both.");
  const target = await writeTarget(user);
  if (!target.ok) return target;
  const timeZone = target.data.calendar.timeZone;
  const found = await findEvent(user, target.data, input);
  if (!found.ok) return found;
  const event = found.data;
  const auditInput = { sourceId: target.data.source.id, calendarEventId: event.id };

  try {
    const { auth, live, recurring } = await liveEvent(target.data, event.externalEventId);
    if (recurring) return recurringRefused();
    if (input.confirmed && live.etag !== input.etag) {
      await audit(user, MOVE_GOOGLE_CALENDAR_EVENT_ACTION, { ...auditInput, confirmed: true }, { result: "rejected", confirmed: true, error: "CALENDAR_EVENT_CHANGED" });
      return changedSinceReview();
    }
    const from = slotFromGoogle(live, timeZone);
    if (!from) return fail(502, "PROVIDER_RESPONSE_INVALID", "Google returned the event without a usable time.");
    const today = localDateTime(new Date(), timeZone).date;
    const newDate = input.new_date ? resolveSpokenDate(input.new_date, today) : from.date;
    if (!newDate) return fail(400, "CALENDAR_DATE_NOT_UNDERSTOOD", `The date '${input.new_date}' was not understood.`);
    if (newDate < today) return fail(409, "CALENDAR_DATE_IN_PAST", `${newDate} is in the past.`);
    let to: Slot;
    if (from.allDay && !input.new_time) {
      const days = Math.round((Date.parse(`${from.endDate}T00:00:00Z`) - Date.parse(`${from.date}T00:00:00Z`)) / 86_400_000);
      to = { allDay: true, date: newDate, endDate: addDays(newDate, Math.max(1, days)) };
    } else {
      const newTime = input.new_time ? resolveSpokenTime(input.new_time) : from.time;
      if (!newTime) return fail(400, "CALENDAR_TIME_NOT_UNDERSTOOD", `The time '${input.new_time}' was not understood. Use the 24-hour clock, for example 14:30.`);
      // The event keeps its length; an all-day event given a time becomes one hour.
      const minutes = from.allDay
        ? DEFAULT_DURATION_MINUTES
        : Math.round((slotInstants(from, timeZone).end.getTime() - slotInstants(from, timeZone).start.getTime()) / 60_000);
      const end = addMinutesToLocal(newDate, newTime, minutes);
      to = { allDay: false, date: newDate, time: newTime, endDate: end.date, endTime: end.time };
    }

    if (!input.confirmed) {
      const preview = {
        provider: "google_calendar",
        calendar: target.data.calendar.summary,
        timeZone,
        title: live.summary || "Untitled event",
        from: slotSummary(from, user.voiceLanguage),
        to: slotSummary(to, user.voiceLanguage),
        clashes: await clashes(user, target.data, to, event.id),
        attendeeCount: live.attendees?.length ?? 0,
        othersNotified: false,
      };
      await audit(user, MOVE_GOOGLE_CALENDAR_EVENT_ACTION, { ...auditInput, confirmed: false }, { result: "rejected", error: "CONFIRMATION_REQUIRED" });
      return fail(409, "CONFIRMATION_REQUIRED", "Review the move and confirm to change the calendar.", {
        preview,
        confirmInput: {
          calendar_event_id: event.id,
          etag: live.etag,
          new_date: to.date,
          ...(to.allDay ? {} : { new_time: to.time }),
        },
      });
    }

    const updated = await patchGoogleCalendarEvent(auth.accessToken, target.data.calendar.externalCalendarId, event.externalEventId, slotToGoogle(to, timeZone), input.etag!);
    await stage(target.data, updated);
    const result = { eventId: updated.id, title: updated.summary, from: slotSummary(from, user.voiceLanguage), to: slotSummary(to, user.voiceLanguage), htmlLink: updated.htmlLink };
    await audit(user, MOVE_GOOGLE_CALENDAR_EVENT_ACTION, { ...auditInput, confirmed: true }, { result: "success", confirmed: true, dataAfter: { eventId: updated.id, from: from.date, to: to.date } });
    return ok(200, result);
  } catch (error) {
    if (error instanceof GoogleCalendarAdapterError && error.code === "CALENDAR_EVENT_CHANGED") {
      await audit(user, MOVE_GOOGLE_CALENDAR_EVENT_ACTION, { ...auditInput, confirmed: true }, { result: "rejected", confirmed: true, error: "CALENDAR_EVENT_CHANGED" });
      return changedSinceReview();
    }
    const result = providerError(error);
    if (input.confirmed) await audit(user, MOVE_GOOGLE_CALENDAR_EVENT_ACTION, { ...auditInput, confirmed: true }, { result: "error", confirmed: true, error: result.ok ? "CONNECTOR_INTERNAL_ERROR" : result.error });
    return result;
  }
}

export async function cancelCalendarEvent(user: AuthedUser, raw: unknown): Promise<ServiceResult<unknown>> {
  const parsed = cancelSchema.safeParse(raw);
  if (!parsed.success) return fail(400, "VALIDATION_FAILED", parsed.error.message);
  const input = parsed.data;
  if (input.confirmed && (!input.calendar_event_id || !input.etag)) {
    return fail(400, "VALIDATION_FAILED", "Confirm the reviewed cancellation; it carries the exact event and its version.");
  }
  const target = await writeTarget(user);
  if (!target.ok) return target;
  const timeZone = target.data.calendar.timeZone;
  // A confirmed cancellation retried after it succeeded (a lost answer, a
  // repeated request) finds the event already cancelled: that is the outcome
  // asked for, not "not found".
  if (input.confirmed && input.calendar_event_id) {
    const done = await prisma.externalCalendarEvent.findFirst({
      where: { id: input.calendar_event_id, companyId: user.companyId, connectorSourceId: target.data.source.id, externalCalendarRecordId: target.data.calendar.id, isDeleted: true },
    });
    if (done) return ok(200, { eventId: done.externalEventId, title: done.summary, alreadyCancelled: true });
  }
  const found = await findEvent(user, target.data, input);
  if (!found.ok) return found;
  const event = found.data;
  const auditInput = { sourceId: target.data.source.id, calendarEventId: event.id };

  try {
    let auth: StoredGoogleCalendarCredential;
    let live: GoogleCalendarEvent;
    try {
      ({ auth, live } = await liveEvent(target.data, event.externalEventId).then((value) => {
        if (value.recurring) throw new RecurringEvent();
        return value;
      }));
    } catch (error) {
      if (error instanceof RecurringEvent) return recurringRefused();
      // Already gone at Google: after a yes that is the outcome that was asked for.
      if (input.confirmed && error instanceof GoogleCalendarAdapterError && error.code === "CALENDAR_EVENT_NOT_FOUND") {
        await prisma.externalCalendarEvent.update({ where: { id: event.id }, data: { isDeleted: true, status: "cancelled", syncedAt: new Date() } });
        await audit(user, CANCEL_GOOGLE_CALENDAR_EVENT_ACTION, { ...auditInput, confirmed: true }, { result: "success", confirmed: true, dataAfter: { eventId: event.externalEventId, alreadyCancelled: true } });
        return ok(200, { eventId: event.externalEventId, title: event.summary, alreadyCancelled: true });
      }
      throw error;
    }
    const slot = slotFromGoogle(live, timeZone);
    if (input.confirmed && live.etag !== input.etag) {
      await audit(user, CANCEL_GOOGLE_CALENDAR_EVENT_ACTION, { ...auditInput, confirmed: true }, { result: "rejected", confirmed: true, error: "CALENDAR_EVENT_CHANGED" });
      return changedSinceReview();
    }
    if (!input.confirmed) {
      const preview = {
        provider: "google_calendar",
        calendar: target.data.calendar.summary,
        timeZone,
        title: live.summary || "Untitled event",
        ...(slot ? { when: slotSummary(slot, user.voiceLanguage) } : {}),
        ...(live.location ? { location: live.location } : {}),
        attendeeCount: live.attendees?.length ?? 0,
        othersNotified: false,
      };
      await audit(user, CANCEL_GOOGLE_CALENDAR_EVENT_ACTION, { ...auditInput, confirmed: false }, { result: "rejected", error: "CONFIRMATION_REQUIRED" });
      return fail(409, "CONFIRMATION_REQUIRED", "Review which event will be cancelled and confirm.", {
        preview,
        confirmInput: { calendar_event_id: event.id, etag: live.etag },
      });
    }
    await deleteGoogleCalendarEvent(auth.accessToken, target.data.calendar.externalCalendarId, event.externalEventId, input.etag!);
    await prisma.externalCalendarEvent.update({ where: { id: event.id }, data: { isDeleted: true, status: "cancelled", syncedAt: new Date() } });
    const result = { eventId: event.externalEventId, title: live.summary, ...(slot ? { when: slotSummary(slot, user.voiceLanguage) } : {}), alreadyCancelled: false };
    await audit(user, CANCEL_GOOGLE_CALENDAR_EVENT_ACTION, { ...auditInput, confirmed: true }, { result: "success", confirmed: true, dataAfter: { eventId: event.externalEventId } });
    return ok(200, result);
  } catch (error) {
    if (error instanceof GoogleCalendarAdapterError && error.code === "CALENDAR_EVENT_CHANGED") {
      await audit(user, CANCEL_GOOGLE_CALENDAR_EVENT_ACTION, { ...auditInput, confirmed: true }, { result: "rejected", confirmed: true, error: "CALENDAR_EVENT_CHANGED" });
      return changedSinceReview();
    }
    const result = providerError(error);
    if (input.confirmed) await audit(user, CANCEL_GOOGLE_CALENDAR_EVENT_ACTION, { ...auditInput, confirmed: true }, { result: "error", confirmed: true, error: result.ok ? "CONNECTOR_INTERNAL_ERROR" : result.error });
    return result;
  }
}

class RecurringEvent extends Error {}
