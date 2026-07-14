import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import request from "supertest";
import { encryptConnectorPayload } from "../src/connectors/connectorCrypto.js";
import { prisma } from "../src/db.js";
import { createServer } from "../src/server.js";
import { resetDb, seedCompanyAndAdmin, TEST_COMPANY_ID } from "./setup.js";

const app = createServer();
const originalFetch = globalThis.fetch;
const originalEncryptionKey = process.env.CONNECTOR_ENCRYPTION_KEY;
const whatsappEnvironment = [
  "WHATSAPP_GRAPH_API_VERSION",
  "WHATSAPP_PHONE_NUMBER_ID",
  "WHATSAPP_BUSINESS_ACCOUNT_ID",
  "WHATSAPP_ACCESS_TOKEN",
  "WHATSAPP_WEBHOOK_VERIFY_TOKEN",
  "META_APP_SECRET",
] as const;
const originalWhatsAppEnvironment = Object.fromEntries(whatsappEnvironment.map((key) => [key, process.env[key]]));

function tomorrowDateKey() {
  const tomorrow = new Date(Date.now() + 86_400_000);
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(tomorrow);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}

describe("Emma connector commands", () => {
  let token: string;

  before(async () => {
    process.env.CONNECTOR_ENCRYPTION_KEY = Buffer.alloc(32, 12).toString("base64");
    process.env.WHATSAPP_GRAPH_API_VERSION = "v23.0";
    process.env.WHATSAPP_PHONE_NUMBER_ID = "123456789";
    process.env.WHATSAPP_BUSINESS_ACCOUNT_ID = "987654321";
    process.env.WHATSAPP_ACCESS_TOKEN = "test-whatsapp-token";
    process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = "test-verify-token";
    process.env.META_APP_SECRET = "test-app-secret";
    await resetDb();
    await seedCompanyAndAdmin();
    token = (await request(app).post("/auth/login").send({ email: "admin@test.local", password: "Password123!" })).body.token;

    const calendarSource = await request(app)
      .post("/connectors/sources")
      .set("Authorization", `Bearer ${token}`)
      .send({ connector_key: "google_calendar", display_name: "Voice calendar", configured_scopes: ["read:calendar"] });
    await prisma.connectorSource.update({ where: { id: calendarSource.body.id }, data: { isEnabled: true, connectionStatus: "enabled" } });
    await prisma.connectorCredential.create({
      data: {
        sourceId: calendarSource.body.id,
        companyId: TEST_COMPANY_ID,
        provider: "google_calendar",
        ...encryptConnectorPayload({ accessToken: "test", refreshToken: "test", expiresAt: "2099-01-01T00:00:00.000Z" }, `${TEST_COMPANY_ID}:${calendarSource.body.id}:google_calendar`),
      },
    });
    const calendar = await prisma.externalCalendar.create({
      data: {
        companyId: TEST_COMPANY_ID,
        connectorSourceId: calendarSource.body.id,
        externalCalendarId: "primary",
        summary: "Primary",
        timeZone: "Europe/London",
        isPrimary: true,
      },
    });
    const day = tomorrowDateKey();
    await prisma.externalCalendarEvent.create({
      data: {
        companyId: TEST_COMPANY_ID,
        connectorSourceId: calendarSource.body.id,
        externalCalendarRecordId: calendar.id,
        externalEventId: "tomorrow-event",
        summary: "Site visit",
        startDate: day,
        endDate: day,
      },
    });

    const whatsappSource = await request(app)
      .post("/connectors/sources")
      .set("Authorization", `Bearer ${token}`)
      .send({ connector_key: "whatsapp_business", display_name: "Voice WhatsApp", configured_scopes: ["read:messages", "send:messages"] });
    await prisma.connectorSource.update({ where: { id: whatsappSource.body.id }, data: { isEnabled: true, connectionStatus: "enabled" } });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  after(async () => {
    await resetDb();
    await prisma.$disconnect();
    if (originalEncryptionKey === undefined) delete process.env.CONNECTOR_ENCRYPTION_KEY;
    else process.env.CONNECTOR_ENCRYPTION_KEY = originalEncryptionKey;
    for (const key of whatsappEnvironment) {
      const value = originalWhatsAppEnvironment[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("reads tomorrow's staged Google Calendar events without an AI round trip", async () => {
    const response = await request(app)
      .post("/command/assistant")
      .set("Authorization", `Bearer ${token}`)
      .send({ text: "co mám zítra v kalendáři", input_method: "voice_transcript", language: "cs-CZ", history: [] });
    assert.equal(response.status, 200);
    assert.equal(response.body.intent, "list_calendar_events");
    assert.equal(response.body.data.items.length, 1);
    assert.equal(response.body.data.items[0].summary, "Site visit");
  });

  it("previews and explicitly confirms a Polish WhatsApp voice request", async () => {
    let sends = 0;
    globalThis.fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
      if (init?.method !== "POST") {
        assert.equal(url.pathname, "/v23.0/123456789");
        return Response.json({ id: "123456789", display_phone_number: "+44 7700 900123", verified_name: "VCUBF", quality_rating: "GREEN" });
      }
      assert.equal(url.pathname, "/v23.0/123456789/messages");
      const body = JSON.parse(String(init?.body));
      assert.equal(body.to, "447700900123");
      assert.equal(body.text.body, "Dzień dobry");
      sends += 1;
      return Response.json({ messages: [{ id: "wamid.test" }] });
    };
    const preview = await request(app)
      .post("/command/assistant")
      .set("Authorization", `Bearer ${token}`)
      .send({ text: "wyślij wiadomość na WhatsApp do +447700900123 wiadomość Dzień dobry", input_method: "voice_transcript", language: "pl-PL", history: [] });
    assert.equal(preview.status, 202);
    assert.equal(preview.body.intent, "prepare_whatsapp_message");
    assert.equal(preview.body.data.confirmationRequired, true);

    const confirmed = await request(app)
      .post("/command/assistant")
      .set("Authorization", `Bearer ${token}`)
      .send({ text: "potwierdzam", input_method: "voice_transcript", language: "pl-PL", history: [] });
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.body.intent, "confirm_whatsapp_message");
    assert.equal(confirmed.body.data.messageId, "wamid.test");
    assert.equal(sends, 1);
  });
});
