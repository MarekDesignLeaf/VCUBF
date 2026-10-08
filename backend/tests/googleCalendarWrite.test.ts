import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import request from "supertest";
import { prisma } from "../src/db.js";
import { createServer } from "../src/server.js";
import { encryptConnectorPayload } from "../src/connectors/connectorCrypto.js";
import { GOOGLE_CALENDAR_EVENTS_SCOPE, GOOGLE_CALENDAR_READONLY_SCOPE } from "../src/connectors/googleCalendarAdapter.js";
import { addDays, localDateTime, resolveSpokenDate, resolveSpokenTime, zonedInstant } from "../src/lib/spokenDate.js";
import { resetDb, seedCompanyAndAdmin, TEST_COMPANY_ID } from "./setup.js";

// Writing to Google Calendar: create, move and cancel one event.
//
// Every write is reviewed first. The day the person said ("zítra") is resolved
// in the calendar's time zone and read back with the time, length and any
// clashes; nothing reaches Google before the yes. The yes writes exactly what
// was reviewed: a new event carries the id chosen at review (so a retried yes
// cannot create a second one), and a move or cancellation carries the event's
// version (so an event changed in the meantime is left alone).

const app = createServer();
const originalFetch = globalThis.fetch;
const ZONE = "Europe/London";
const CALENDAR_ID = "owner@example.com";
const ENV_NAMES = ["GOOGLE_CALENDAR_OAUTH_CLIENT_ID", "GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET", "GOOGLE_CALENDAR_OAUTH_REDIRECT_URI", "CONNECTOR_ENCRYPTION_KEY"] as const;
const originalEnv = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));

let token = "";
let sourceId = "";
let calendarRecordId = "";

interface FakeEvent { id: string; etag: string; summary: string; status: string; start: Record<string, string>; end: Record<string, string>; recurrence?: string[]; attendees?: Array<{ email: string }> }
const store = new Map<string, FakeEvent>();
const writes: Array<{ method: string; url: URL; ifMatch?: string; body?: Record<string, unknown> }> = [];
let etagCounter = 0;
const nextEtag = () => `"etag-${++etagCounter}"`;

function tomorrow() { return addDays(localDateTime(new Date(), ZONE).date, 1); }

/** Google answers with the instant, as it does, not the wall-clock text it was sent. */
function asGoogleTime(value: Record<string, string>) {
  if (value.date) return { date: value.date };
  const [date, time] = value.dateTime.split("T");
  return { dateTime: zonedInstant(date, time.slice(0, 5), value.timeZone ?? ZONE).toISOString(), timeZone: value.timeZone ?? ZONE };
}

function stubGoogle() {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    if (!url.hostname.endsWith("googleapis.com")) return new Response("unexpected", { status: 500 });
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const match = url.pathname.match(/\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/);
    if (!match) return new Response("unexpected", { status: 500 });
    assert.equal(decodeURIComponent(match[1]), CALENDAR_ID);
    const eventId = match[2] ? decodeURIComponent(match[2]) : undefined;
    if (method !== "GET") writes.push({ method, url, ifMatch: headers.get("If-Match") ?? undefined, body });
    if (method === "POST") {
      if (store.has(body.id)) return Response.json({ error: { code: 409, message: "The requested identifier already exists." } }, { status: 409 });
      const event: FakeEvent = { id: body.id, etag: nextEtag(), summary: body.summary, status: "confirmed", start: asGoogleTime(body.start), end: asGoogleTime(body.end) };
      store.set(event.id, event);
      return Response.json({ ...event, htmlLink: `https://calendar.google.com/event?eid=${event.id}` });
    }
    const event = eventId ? store.get(eventId) : undefined;
    if (!event) return new Response("", { status: 404 });
    if (method === "GET") return Response.json(event);
    if (headers.get("If-Match") !== event.etag) return new Response("", { status: 412 });
    if (method === "PATCH") {
      Object.assign(event, { start: asGoogleTime(body.start), end: asGoogleTime(body.end), etag: nextEtag() });
      return Response.json(event);
    }
    if (method === "DELETE") { store.delete(event.id); return new Response(null, { status: 204 }); }
    return new Response("unexpected", { status: 500 });
  }) as typeof globalThis.fetch;
}

async function seedEvent(input: { id: string; summary: string; date: string; time: string; minutes: number; recurrence?: string[]; attendees?: Array<{ email: string }> }) {
  const start = zonedInstant(input.date, input.time, ZONE);
  const end = new Date(start.getTime() + input.minutes * 60_000);
  const event: FakeEvent = {
    id: input.id, etag: nextEtag(), summary: input.summary, status: "confirmed",
    start: { dateTime: start.toISOString(), timeZone: ZONE }, end: { dateTime: end.toISOString(), timeZone: ZONE },
    ...(input.recurrence ? { recurrence: input.recurrence } : {}), ...(input.attendees ? { attendees: input.attendees } : {}),
  };
  store.set(event.id, event);
  return prisma.externalCalendarEvent.create({
    data: {
      companyId: TEST_COMPANY_ID, connectorSourceId: sourceId, externalCalendarRecordId: calendarRecordId, externalEventId: event.id,
      sourceEtag: event.etag, status: "confirmed", summary: event.summary, startAt: start, endAt: end, timeZone: ZONE,
    },
  });
}

async function seedCredential(scopes: string[]) {
  await prisma.connectorCredential.deleteMany({ where: { sourceId } });
  await prisma.connectorCredential.create({
    data: {
      sourceId, companyId: TEST_COMPANY_ID, provider: "google_calendar",
      ...encryptConnectorPayload({ accessToken: "calendar-access", refreshToken: "calendar-refresh", scopes, tokenType: "Bearer", expiresAt: "2099-01-01T00:00:00.000Z" }, `${TEST_COMPANY_ID}:${sourceId}:google_calendar`),
    },
  });
}

const speak = (text: string) => request(app).post("/command/assistant").set("Authorization", `Bearer ${token}`).send({ text, input_method: "voice_transcript" });
const action = (name: string, parameters: Record<string, unknown>) => speak(`voice action ${name} ${JSON.stringify(parameters)}`);
const route = (path: string, body: Record<string, unknown>, bearer = token) =>
  request(app).post(`/connectors/calendar/events${path}`).set("Authorization", `Bearer ${bearer}`).send(body);

describe("Writing to Google Calendar after review", () => {
  before(async () => {
    process.env.GOOGLE_CALENDAR_OAUTH_CLIENT_ID = "calendar.apps.googleusercontent.com";
    process.env.GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET = "secret";
    process.env.GOOGLE_CALENDAR_OAUTH_REDIRECT_URI = "http://localhost:4000/connectors/google-calendar/oauth/callback";
    process.env.CONNECTOR_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    await resetDb();
    await seedCompanyAndAdmin();
    token = (await request(app).post("/auth/login").send({ email: "admin@test.local", password: "Password123!" })).body.token;
    const source = await request(app).post("/connectors/sources").set("Authorization", `Bearer ${token}`)
      .send({ connector_key: "google_calendar", display_name: "Owner calendar", configured_scopes: ["read:calendar", "write:events"] });
    assert.equal(source.status, 201, JSON.stringify(source.body));
    sourceId = source.body.id;
    await prisma.connectorSource.update({ where: { id: sourceId }, data: { isEnabled: true, connectionStatus: "enabled" } });
    const calendar = await prisma.externalCalendar.create({
      data: { companyId: TEST_COMPANY_ID, connectorSourceId: sourceId, externalCalendarId: CALENDAR_ID, summary: "Marek", timeZone: ZONE, accessRole: "owner", isPrimary: true },
    });
    calendarRecordId = calendar.id;
  });

  beforeEach(async () => {
    store.clear();
    writes.length = 0;
    etagCounter = 0;
    await prisma.voicePendingAction.deleteMany({});
    await prisma.externalCalendarEvent.deleteMany({});
    await prisma.connectorSource.update({ where: { id: sourceId }, data: { configuredScopes: ["read:calendar", "write:events"] } });
    await seedCredential([GOOGLE_CALENDAR_READONLY_SCOPE, GOOGLE_CALENDAR_EVENTS_SCOPE]);
    stubGoogle();
  });

  afterEach(() => { globalThis.fetch = originalFetch; });

  after(async () => {
    await resetDb();
    await prisma.$disconnect();
    for (const name of ENV_NAMES) {
      const value = originalEnv[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("reads back the resolved day, time, length and clashes, and the yes creates exactly that event once", async () => {
    const day = tomorrow();
    await seedEvent({ id: "existingcall0000000001", summary: "Telefon s dodavatelem", date: day, time: "08:30", minutes: 30 });

    const asked = await action("create_calendar_event", { title: "Prohlídka zahrady u Nováků", date: "zítra", time: "8:00" });
    assert.equal(asked.body.error, "CONFIRMATION_REQUIRED", JSON.stringify(asked.body));
    const preview = asked.body.data.preview;
    assert.equal(preview.date, day, "'zítra' is tomorrow in the calendar's own time zone");
    assert.equal(preview.start, "08:00");
    assert.equal(preview.end, "09:00");
    assert.equal(preview.durationMinutes, 60);
    assert.equal(preview.durationAssumed, true, "an hour is assumed only when no length was said, and the review says so");
    assert.equal(preview.othersNotified, false);
    assert.deepEqual(preview.clashes.map((clash: { title: string }) => clash.title), ["Telefon s dodavatelem"]);
    assert.equal(writes.length, 0, "nothing is written before the yes");

    const pending = await prisma.voicePendingAction.findFirstOrThrow({ where: { status: "pending" } });
    const waiting = (pending.payload as unknown as { parameters: Record<string, unknown> }).parameters;
    assert.equal(waiting.date, day, "the yes binds to the resolved date, not the word 'zítra'");
    assert.equal(waiting.time, "08:00");
    assert.equal(waiting.end_time, "09:00");
    assert.match(String(waiting.event_id), /^[a-v0-9]{20,64}$/);

    const confirmed = await speak("yes");
    assert.equal(confirmed.body.ok, true, JSON.stringify(confirmed.body));
    assert.equal(writes.length, 1);
    const written = writes[0];
    assert.equal(written.method, "POST");
    assert.equal(written.url.searchParams.get("sendUpdates"), "none", "nobody else is emailed");
    assert.equal(written.body?.id, waiting.event_id);
    assert.equal(written.body?.summary, "Prohlídka zahrady u Nováků");
    assert.deepEqual(written.body?.start, { dateTime: `${day}T08:00:00`, timeZone: ZONE });
    assert.deepEqual(written.body?.end, { dateTime: `${day}T09:00:00`, timeZone: ZONE });

    const staged = await prisma.externalCalendarEvent.findFirstOrThrow({ where: { externalEventId: String(waiting.event_id) } });
    assert.equal(staged.summary, "Prohlídka zahrady u Nováků", "the agenda shows the new event at once");
    assert.equal(staged.startAt?.toISOString(), zonedInstant(day, "08:00", ZONE).toISOString());

    // The same yes delivered twice (a lost answer, a retry) finds the event it made.
    const retried = await route("", { ...waiting, confirmed: true });
    assert.equal(retried.status, 200, JSON.stringify(retried.body));
    assert.equal(retried.body.alreadyCreated, true);
    assert.equal(store.size, 2, "still one new event besides the existing one");
  });

  it("writes an all-day event when no time was said, and a stated length", async () => {
    const day = tomorrow();
    const allDay = await route("", { title: "Dovolená", date: "zítra" });
    assert.equal(allDay.status, 409, JSON.stringify(allDay.body));
    assert.equal(allDay.body.preview.allDay, true);
    assert.deepEqual(allDay.body.confirmInput.date, day);

    const timed = await route("", { title: "Měření", date: "zítra", time: "14:30", duration_minutes: 90 });
    assert.equal(timed.body.preview.end, "16:00");
    assert.equal(timed.body.preview.durationAssumed, undefined);
  });

  it("refuses words it cannot read as a date, and days already past", async () => {
    const unreadable = await route("", { title: "Something", date: "někdy příště", time: "10:00" });
    assert.equal(unreadable.status, 400);
    assert.equal(unreadable.body.error, "CALENDAR_DATE_NOT_UNDERSTOOD");
    const past = await route("", { title: "Something", date: "2020-01-01", time: "10:00" });
    assert.equal(past.body.error, "CALENDAR_DATE_IN_PAST");
    const badTime = await route("", { title: "Something", date: "zítra", time: "25:00" });
    assert.equal(badTime.body.error, "CALENDAR_TIME_NOT_UNDERSTOOD");
    assert.equal(writes.length, 0);
  });

  it("refuses to write through a read-only calendar connection", async () => {
    await prisma.connectorSource.update({ where: { id: sourceId }, data: { configuredScopes: ["read:calendar"] } });
    const notConfigured = await route("", { title: "Something", date: "zítra", time: "10:00" });
    assert.equal(notConfigured.status, 409);
    assert.equal(notConfigured.body.error, "CALENDAR_WRITE_NOT_AUTHORIZED");

    await prisma.connectorSource.update({ where: { id: sourceId }, data: { configuredScopes: ["read:calendar", "write:events"] } });
    await seedCredential([GOOGLE_CALENDAR_READONLY_SCOPE]);
    const notGranted = await route("", { title: "Something", date: "zítra", time: "10:00" });
    assert.equal(notGranted.body.error, "CALENDAR_WRITE_NOT_AUTHORIZED", "configured is not enough: Google must have granted it");
    assert.equal(writes.length, 0);
  });

  it("moves an event, keeping its length, only after the yes", async () => {
    const day = tomorrow();
    await seedEvent({ id: "dvorakvisit0000000001", summary: "Návštěva u Dvořáků", date: day, time: "10:00", minutes: 90 });

    const asked = await action("move_calendar_event", { event: "Dvořák", new_time: "14:00" });
    assert.equal(asked.body.error, "CONFIRMATION_REQUIRED", JSON.stringify(asked.body));
    const preview = asked.body.data.preview;
    assert.equal(preview.title, "Návštěva u Dvořáků");
    assert.equal(preview.from.start, "10:00");
    assert.equal(preview.to.start, "14:00");
    assert.equal(preview.to.end, "15:30");
    assert.equal(preview.to.date, day);
    assert.equal(writes.length, 0);

    const confirmed = await speak("yes");
    assert.equal(confirmed.body.ok, true, JSON.stringify(confirmed.body));
    assert.equal(writes.length, 1);
    assert.equal(writes[0].method, "PATCH");
    assert.equal(writes[0].ifMatch, '"etag-1"', "the move is bound to the version that was reviewed");
    assert.deepEqual(writes[0].body?.start, { dateTime: `${day}T14:00:00`, timeZone: ZONE });
    assert.deepEqual(writes[0].body?.end, { dateTime: `${day}T15:30:00`, timeZone: ZONE });
    const staged = await prisma.externalCalendarEvent.findFirstOrThrow({ where: { externalEventId: "dvorakvisit0000000001" } });
    assert.equal(staged.startAt?.toISOString(), zonedInstant(day, "14:00", ZONE).toISOString());
  });

  it("leaves an event alone if it changed in Google after the review", async () => {
    const day = tomorrow();
    await seedEvent({ id: "changedevent000000001", summary: "Schůzka s architektem", date: day, time: "09:00", minutes: 60 });
    const asked = await route("/move", { event: "architekt", new_time: "11:00" });
    assert.equal(asked.status, 409);
    assert.equal(asked.body.error, "CONFIRMATION_REQUIRED");
    store.get("changedevent000000001")!.etag = '"changed-elsewhere"';
    const confirmed = await route("/move", { ...asked.body.confirmInput, confirmed: true });
    assert.equal(confirmed.status, 409);
    assert.equal(confirmed.body.error, "CALENDAR_EVENT_CHANGED");
    assert.equal(writes.length, 0, "nothing was written over the newer version");
  });

  it("cancels one event after the yes, and refuses a repeating one", async () => {
    const day = tomorrow();
    await seedEvent({ id: "cancelme0000000000001", summary: "Kontrola závlahy", date: day, time: "16:00", minutes: 30, attendees: [{ email: "client@example.com" }] });
    await seedEvent({ id: "weekly000000000000001", summary: "Týdenní porada", date: day, time: "07:30", minutes: 30, recurrence: ["RRULE:FREQ=WEEKLY"] });

    const asked = await action("cancel_calendar_event", { event: "závlaha", on_date: "zítra" });
    assert.equal(asked.body.error, "CONFIRMATION_REQUIRED", JSON.stringify(asked.body));
    assert.equal(asked.body.data.preview.title, "Kontrola závlahy");
    assert.equal(asked.body.data.preview.attendeeCount, 1);
    assert.equal(asked.body.data.preview.othersNotified, false);
    assert.equal(writes.length, 0);
    const confirmed = await speak("yes");
    assert.equal(confirmed.body.ok, true, JSON.stringify(confirmed.body));
    assert.deepEqual(writes.map((write) => write.method), ["DELETE"]);
    assert.equal(writes[0].url.searchParams.get("sendUpdates"), "none");
    const staged = await prisma.externalCalendarEvent.findFirstOrThrow({ where: { externalEventId: "cancelme0000000000001" } });
    assert.equal(staged.isDeleted, true);

    // The same confirmed cancellation sent again (a lost answer) is the outcome asked for, not "not found".
    const retried = await route("/cancel", { calendar_event_id: staged.id, etag: staged.sourceEtag ?? "\"x\"", confirmed: true });
    assert.equal(retried.status, 200, JSON.stringify(retried.body));
    assert.equal(retried.body.alreadyCancelled, true);
    assert.equal(writes.length, 1, "nothing more is written to Google");

    const repeating = await route("/cancel", { event: "porada" });
    assert.equal(repeating.status, 409);
    assert.equal(repeating.body.error, "CALENDAR_RECURRING_NOT_SUPPORTED");
    assert.equal(writes.length, 1);
  });

  it("counts an all-day event that started earlier and is still running as a clash", async () => {
    const day = tomorrow();
    // Three days, from the day before to the day after: Google's end date is the day after the last.
    await prisma.externalCalendarEvent.create({
      data: {
        companyId: TEST_COMPANY_ID, connectorSourceId: sourceId, externalCalendarRecordId: calendarRecordId, externalEventId: "holiday00000000000001",
        sourceEtag: nextEtag(), status: "confirmed", summary: "Dovolená", startDate: addDays(day, -1), endDate: addDays(day, 2), timeZone: ZONE,
      },
    });
    const asked = await action("create_calendar_event", { title: "Měření zahrady", date: "zítra", time: "10:00" });
    assert.equal(asked.body.error, "CONFIRMATION_REQUIRED", JSON.stringify(asked.body));
    assert.ok(asked.body.data.preview.clashes.some((clash: { title: string }) => clash.title === "Dovolená"), JSON.stringify(asked.body.data.preview.clashes));
    assert.match(asked.body.message, /Dovolená/);
    await prisma.voicePendingAction.deleteMany({});
    await prisma.externalCalendarEvent.deleteMany({ where: { externalEventId: "holiday00000000000001" } });
  });

  it("asks which event when the words fit more than one", async () => {
    const day = tomorrow();
    await seedEvent({ id: "meetingone00000000001", summary: "Schůzka Novák", date: day, time: "09:00", minutes: 60 });
    await seedEvent({ id: "meetingtwo00000000001", summary: "Schůzka Dvořák", date: addDays(day, 1), time: "09:00", minutes: 60 });
    const ambiguous = await route("/cancel", { event: "schůzka" });
    assert.equal(ambiguous.status, 409);
    assert.equal(ambiguous.body.error, "AMBIGUOUS_REFERENCE");
    const narrowed = await route("/cancel", { event: "schůzka", on_date: "zítra" });
    assert.equal(narrowed.body.error, "CONFIRMATION_REQUIRED", JSON.stringify(narrowed.body));
    assert.equal(narrowed.body.preview.title, "Schůzka Novák");
    assert.equal(writes.length, 0);
  });

  it("is refused to a user without the connector permission", async () => {
    const worker = await request(app).post("/auth/login").send({ email: "worker@test.local", password: "Password123!" });
    const refused = await route("", { title: "Something", date: "zítra", time: "10:00" }, worker.body.token);
    assert.equal(refused.status, 403);
    assert.equal(writes.length, 0);
  });
});

describe("Spoken dates and times", () => {
  it("resolves the days people say, in Czech, English and Polish, and refuses the rest", () => {
    const monday = "2026-10-05";
    const cases: Array<[string, string | undefined]> = [
      ["zítra", "2026-10-06"], ["dnes", "2026-10-05"], ["pozítří", "2026-10-07"], ["tomorrow", "2026-10-06"], ["jutro", "2026-10-06"],
      ["v pátek", "2026-10-09"], ["pondělí", "2026-10-12"], ["ve středu", "2026-10-07"], ["next friday", "2026-10-09"], ["w piątek", "2026-10-09"],
      ["6. 10.", "2026-10-06"], ["4.10.", "2027-10-04"], ["6.10.2026", "2026-10-06"], ["6. října", "2026-10-06"], ["12 November", "2026-11-12"],
      ["October 20th", "2026-10-20"], ["2026-12-01", "2026-12-01"], ["31.2.", undefined], ["někdy", undefined],
    ];
    for (const [spoken, expected] of cases) assert.equal(resolveSpokenDate(spoken, monday), expected, spoken);
  });

  it("reads 24-hour times only", () => {
    assert.equal(resolveSpokenTime("8"), "08:00");
    assert.equal(resolveSpokenTime("v 14.15"), "14:15");
    assert.equal(resolveSpokenTime("8:30"), "08:30");
    assert.equal(resolveSpokenTime("25"), undefined);
  });

  it("places a wall-clock time in the right instant across summer and winter time", () => {
    assert.equal(zonedInstant("2026-10-06", "08:00", ZONE).toISOString(), "2026-10-06T07:00:00.000Z");
    assert.equal(zonedInstant("2026-12-06", "08:00", ZONE).toISOString(), "2026-12-06T08:00:00.000Z");
  });
});
