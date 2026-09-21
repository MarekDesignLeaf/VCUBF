import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import request from "supertest";
import { prisma } from "../src/db.js";
import { createServer } from "../src/server.js";
import { resetDb, seedCompanyAndAdmin } from "./setup.js";

// Dictate in one language, send in another.
//
// The rule that matters is not that a translation happens, but when. The
// translation is made before the message is put up for approval, so the person
// approves the words that will actually leave the building, and confirming
// sends exactly those words (section 41). Translating again at send time could
// produce a different sentence, and the approval would then bind to something
// nobody read.

const app = createServer();
const originalFetch = globalThis.fetch;
const originalEnv = {
  openAiKey: process.env.OPENAI_API_KEY,
  graphApiVersion: process.env.WHATSAPP_GRAPH_API_VERSION,
  phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
  accessToken: process.env.WHATSAPP_ACCESS_TOKEN,
  businessAccountId: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID,
  webhookVerifyToken: process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN,
  appSecret: process.env.META_APP_SECRET,
};

const DICTATED = "Dobrý den, práce na zahradě začne v pondělí. Faktura 2026-114 je splatná 30. září.";
const TRANSLATED = "Hello, the garden work will start on Monday. Invoice 2026-114 is due on 30 September.";

let token = "";
let sourceId = "";
let sent: { to?: string; body?: string } | undefined;
let translationRequests = 0;

/** OpenAI answers with the English; Meta accepts the send and records what it was given. */
function stubProviders(translation: string | null = TRANSLATED) {
  translationRequests = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("api.openai.com")) {
      translationRequests += 1;
      if (translation === null) return new Response("upstream down", { status: 503 });
      return new Response(JSON.stringify({ output_text: translation }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("graph.facebook.com")) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      sent = { to: body.to, body: body.text?.body };
      return new Response(JSON.stringify({ messages: [{ id: "wamid.TEST" }] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("unexpected call", { status: 500 });
  }) as typeof globalThis.fetch;
}

const speak = (parameters: Record<string, unknown>) =>
  request(app).post("/command/assistant").set("Authorization", `Bearer ${token}`)
    .send({ text: `voice action send_whatsapp ${JSON.stringify(parameters)}`, input_method: "voice_transcript" });

describe("Dictated in Czech, sent in English", () => {
  before(async () => {
    process.env.OPENAI_API_KEY = "test-openai-key";
    process.env.WHATSAPP_GRAPH_API_VERSION = "v21.0";
    process.env.WHATSAPP_PHONE_NUMBER_ID = "123456789";
    process.env.WHATSAPP_ACCESS_TOKEN = "test-whatsapp-token";
    process.env.WHATSAPP_BUSINESS_ACCOUNT_ID = "987654321";
    process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = "test-verify-token";
    process.env.META_APP_SECRET = "test-app-secret";
    await resetDb();
    await seedCompanyAndAdmin();
    token = (await request(app).post("/auth/login").send({ email: "admin@test.local", password: "Password123!" })).body.token;
    const created = await request(app).post("/connectors/sources").set("Authorization", `Bearer ${token}`)
      .send({ connector_key: "whatsapp_business", display_name: "Business number", configured_scopes: ["send:messages"] });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    sourceId = created.body.id;
    await prisma.connectorSource.update({ where: { id: sourceId }, data: { isEnabled: true, connectionStatus: "connected" } });
  });

  afterEach(() => { globalThis.fetch = originalFetch; sent = undefined; translationRequests = 0; });

  after(async () => {
    await resetDb();
    await prisma.$disconnect();
    for (const [name, value] of Object.entries({
      OPENAI_API_KEY: originalEnv.openAiKey,
      WHATSAPP_GRAPH_API_VERSION: originalEnv.graphApiVersion,
      WHATSAPP_PHONE_NUMBER_ID: originalEnv.phoneNumberId,
      WHATSAPP_ACCESS_TOKEN: originalEnv.accessToken,
      WHATSAPP_BUSINESS_ACCOUNT_ID: originalEnv.businessAccountId,
      WHATSAPP_WEBHOOK_VERIFY_TOKEN: originalEnv.webhookVerifyToken,
      META_APP_SECRET: originalEnv.appSecret,
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("reads back the English, and confirming sends that English and nothing else", async () => {
    stubProviders();
    const asked = await speak({ to: "+447700900123", body: DICTATED, send_in: "anglicky" });
    assert.equal(asked.body.error, "CONFIRMATION_REQUIRED", JSON.stringify(asked.body));
    const preview = asked.body.data.preview;
    assert.equal(preview.body, TRANSLATED, "the preview must carry the English, not the Czech");
    assert.equal(preview.dictated, DICTATED, "what was said is kept beside what will be sent");
    assert.match(preview.sentIn, /English/);
    assert.equal(sent, undefined, "nothing may be sent before the yes");
    assert.equal(translationRequests, 1);

    // What is waiting for the yes is the reviewed English, not the spoken Czech.
    const pending = await prisma.voicePendingAction.findFirstOrThrow({ where: { status: "pending" } });
    const waiting = pending.payload as unknown as { parameters: Record<string, unknown> };
    assert.equal(waiting.parameters.body, TRANSLATED);
    assert.equal(waiting.parameters.send_in, undefined, "the instruction to translate must not survive the approval");

    stubProviders("THIS SECOND TRANSLATION MUST NEVER BE SENT");
    const confirmed = await request(app).post("/command/assistant").set("Authorization", `Bearer ${token}`)
      .send({ text: "ano", input_method: "voice_transcript" });
    assert.equal(confirmed.body.ok, true, JSON.stringify(confirmed.body));
    assert.equal(sent?.body, TRANSLATED, "the message sent must be the one that was approved");
    // WhatsApp addresses a number without the leading plus.
    assert.equal(sent?.to, "447700900123");
    assert.equal(translationRequests, 0, "an approved message is never translated again");
  });

  it("refuses to translate a message that has already been approved", async () => {
    stubProviders();
    const direct = await request(app).post(`/connectors/sources/${sourceId}/whatsapp/messages/send`)
      .set("Authorization", `Bearer ${token}`)
      .send({ to: "+447700900123", body: DICTATED, send_in: "anglicky", confirmed: true });
    assert.equal(direct.status, 400);
    assert.equal(direct.body.error, "TRANSLATION_AFTER_APPROVAL");
    assert.equal(sent, undefined);
  });

  it("sends nothing when the translation cannot be made", async () => {
    stubProviders(null);
    const asked = await request(app).post(`/connectors/sources/${sourceId}/whatsapp/messages/send`)
      .set("Authorization", `Bearer ${token}`)
      .send({ to: "+447700900123", body: DICTATED, send_in: "anglicky" });
    assert.equal(asked.status, 503);
    assert.equal(asked.body.error, "TRANSLATION_FAILED");
    // Not a lesser version of the request: sending the Czech to someone who was
    // promised English is the wrong outcome, not a partial one.
    assert.equal(sent, undefined);
  });

  it("refuses a language it does not know rather than guessing one", async () => {
    stubProviders();
    const asked = await request(app).post(`/connectors/sources/${sourceId}/whatsapp/messages/send`)
      .set("Authorization", `Bearer ${token}`)
      .send({ to: "+447700900123", body: DICTATED, send_in: "klingonsky" });
    assert.equal(asked.status, 503);
    assert.equal(asked.body.error, "TRANSLATION_LANGUAGE_UNKNOWN");
    assert.equal(translationRequests, 0, "an unknown language never reaches the model");
  });

  it("leaves a message without send_in exactly as it was dictated", async () => {
    stubProviders();
    const asked = await request(app).post(`/connectors/sources/${sourceId}/whatsapp/messages/send`)
      .set("Authorization", `Bearer ${token}`)
      .send({ to: "+447700900123", body: DICTATED });
    assert.equal(asked.status, 409);
    assert.equal(asked.body.error, "CONFIRMATION_REQUIRED");
    assert.equal(asked.body.preview.body, DICTATED);
    assert.equal(translationRequests, 0);
  });
});
