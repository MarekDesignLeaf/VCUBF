import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import request from "supertest";
import { prisma } from "../src/db.js";
import { createServer } from "../src/server.js";
import { resetDb, seedCompanyAndAdmin, TEST_COMPANY_ID } from "./setup.js";

// Replying to a received WhatsApp message.
//
// The reply is bound to one received message: it goes to that message's
// sender (never to a number taken from speech), it quotes that message in the
// customer's WhatsApp thread, and it is written in English unless another
// language is named. The English is made before approval, so the yes binds to
// the words that will be sent, and confirming sends exactly those words once.

const app = createServer();
const originalFetch = globalThis.fetch;
const ENV_NAMES = [
  "OPENAI_API_KEY",
  "WHATSAPP_GRAPH_API_VERSION",
  "WHATSAPP_PHONE_NUMBER_ID",
  "WHATSAPP_ACCESS_TOKEN",
  "WHATSAPP_BUSINESS_ACCOUNT_ID",
  "WHATSAPP_WEBHOOK_VERIFY_TOKEN",
  "META_APP_SECRET",
] as const;
const originalEnv = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));

const DICTATED = "Dobrý den, přijedeme v pondělí v osm ráno.";
const TRANSLATED = "Hello, we will arrive on Monday at eight in the morning.";
const HOUR = 60 * 60 * 1000;

let token = "";
let sourceId = "";
let sends: Array<{ to?: string; body?: string; context?: { message_id?: string } }> = [];
let translationRequests = 0;

function stubProviders(options: { translation?: string | null; graphError?: { status: number; code: number } } = {}) {
  const translation = options.translation === undefined ? TRANSLATED : options.translation;
  translationRequests = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("api.openai.com")) {
      translationRequests += 1;
      if (translation === null) return new Response("upstream down", { status: 503 });
      return new Response(JSON.stringify({ output_text: translation }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("graph.facebook.com")) {
      if (options.graphError) {
        return new Response(JSON.stringify({ error: { code: options.graphError.code, message: "provider refused" } }), {
          status: options.graphError.status,
          headers: { "content-type": "application/json" },
        });
      }
      const body = JSON.parse(String(init?.body ?? "{}"));
      sends.push({ to: body.to, body: body.text?.body, context: body.context });
      return new Response(JSON.stringify({ messages: [{ id: `wamid.SENT${sends.length}` }] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("unexpected call", { status: 500 });
  }) as typeof globalThis.fetch;
}

async function received(input: { phone: string; name: string; text: string; hoursAgo: number; wamid: string; companyId?: string; connectorSourceId?: string | null }) {
  return prisma.communicationIntake.create({
    data: {
      companyId: input.companyId ?? TEST_COMPANY_ID,
      connectorSourceId: input.connectorSourceId === undefined ? sourceId : input.connectorSourceId,
      externalMessageId: input.wamid,
      channel: "whatsapp",
      senderName: input.name,
      senderPhone: input.phone,
      messageText: input.text,
      receivedAt: new Date(Date.now() - input.hoursAgo * HOUR),
    },
  });
}

const speak = (text: string) =>
  request(app).post("/command/assistant").set("Authorization", `Bearer ${token}`).send({ text, input_method: "voice_transcript" });
const replyAction = (parameters: Record<string, unknown>) => speak(`voice action reply_whatsapp ${JSON.stringify(parameters)}`);
const replyRoute = (body: Record<string, unknown>) =>
  request(app).post(`/connectors/sources/${sourceId}/whatsapp/messages/reply`).set("Authorization", `Bearer ${token}`).send(body);

describe("Replying to a received WhatsApp message", () => {
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
      .send({ connector_key: "whatsapp_business", display_name: "Business number", configured_scopes: ["read:messages", "send:messages"] });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    sourceId = created.body.id;
    await prisma.connectorSource.update({ where: { id: sourceId }, data: { isEnabled: true, connectionStatus: "connected" } });
  });

  beforeEach(async () => {
    await prisma.voicePendingAction.deleteMany({});
    await prisma.communicationIntake.deleteMany({});
  });

  afterEach(() => { globalThis.fetch = originalFetch; sends = []; translationRequests = 0; });

  after(async () => {
    await resetDb();
    await prisma.$disconnect();
    for (const name of ENV_NAMES) {
      const value = originalEnv[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("answers the sender's latest message in English, and the yes sends exactly that reply once", async () => {
    await received({ phone: "+447700900111", name: "Honza Novák", text: "Can you come on Monday?", hoursAgo: 3, wamid: "wamid.HONZA1" });
    await received({ phone: "+447700900111", name: "Honza Novák", text: "What time will you arrive?", hoursAgo: 1, wamid: "wamid.HONZA2" });
    await received({ phone: "+447700900222", name: "Petra Dvořáková", text: "Thanks for the quote.", hoursAgo: 2, wamid: "wamid.PETRA" });
    stubProviders();

    const asked = await replyAction({ sender_or_message: "Honza", body: DICTATED });
    assert.equal(asked.body.error, "CONFIRMATION_REQUIRED", JSON.stringify(asked.body));
    const preview = asked.body.data.preview;
    assert.equal(preview.to, "+447700900111", "the reply goes to the sender of the message");
    assert.equal(preview.recipientName, "Honza Novák");
    assert.equal(preview.inReplyTo.text, "What time will you arrive?", "the sender's latest message is the one answered");
    assert.equal(preview.body, TRANSLATED, "English unless another language is named");
    assert.match(preview.sentIn, /English/);
    assert.equal(preview.dictated, DICTATED);
    assert.equal(sends.length, 0, "nothing may be sent before the yes");
    assert.equal(translationRequests, 1);

    const pending = await prisma.voicePendingAction.findFirstOrThrow({ where: { status: "pending" } });
    const waiting = pending.payload as unknown as { action: string; parameters: Record<string, unknown> };
    assert.equal(waiting.action, "reply_whatsapp");
    assert.equal(waiting.parameters.body, TRANSLATED);
    assert.equal(waiting.parameters.sender_or_message, undefined, "the yes binds to one exact message, not to a name");
    assert.equal(typeof waiting.parameters.intake_id, "string");

    stubProviders({ translation: "THIS SECOND TRANSLATION MUST NEVER BE SENT" });
    const confirmed = await speak("yes");
    assert.equal(confirmed.body.ok, true, JSON.stringify(confirmed.body));
    assert.equal(sends.length, 1, "exactly one message leaves");
    assert.equal(sends[0].to, "447700900111");
    assert.equal(sends[0].body, TRANSLATED);
    assert.equal(sends[0].context?.message_id, "wamid.HONZA2", "the reply quotes the message it answers");
    assert.equal(translationRequests, 0, "an approved reply is never translated again");

    const answered = await prisma.communicationIntake.findFirstOrThrow({ where: { externalMessageId: "wamid.HONZA2" } });
    const replies = (answered.sourceMetadata as { replies?: Array<{ messageId: string; body: string }> } | null)?.replies ?? [];
    assert.equal(replies.length, 1);
    assert.equal(replies[0].messageId, "wamid.SENT1");
    assert.equal(replies[0].body, TRANSLATED);

    const again = await speak("yes");
    assert.notEqual(again.body.ok, true, "a second yes must not send the reply again");
    assert.equal(sends.length, 1);

    // Dictating the same reply again is reviewed with a note that it already went.
    stubProviders();
    const dictatedAgain = await replyAction({ sender_or_message: "Honza", body: DICTATED });
    assert.equal(dictatedAgain.body.data.preview.alreadySent?.minutesAgo, 0, JSON.stringify(dictatedAgain.body.data?.preview));
    assert.match(dictatedAgain.body.message, /I already sent exactly this a moment ago/);
    await prisma.voicePendingAction.deleteMany({});
  });

  it("reads the newest WhatsApp messages aloud, newest first, saying which were answered", async () => {
    await received({ phone: "+447700900111", name: "Honza Novák", text: "Old question", hoursAgo: 30, wamid: "wamid.R1" });
    const answered = await received({ phone: "+447700900222", name: "Petra Dvořáková", text: "Newest question", hoursAgo: 1, wamid: "wamid.R2" });
    await prisma.communicationIntake.update({ where: { id: answered.id }, data: { sourceMetadata: { replies: [{ messageId: "wamid.SENT", sentAt: new Date().toISOString() }] } } });
    const heard = await speak("show whatsapp messages");
    assert.equal(heard.body.intent, "list_channel_messages", JSON.stringify(heard.body));
    assert.match(heard.body.message, /^Latest WhatsApp messages: 1\. Petra Dvořáková, an hour ago: „Newest question“\. Answered\. 2\. Honza Novák, yesterday: „Old question“\. Not answered\./);
    assert.equal(heard.body.data.items.length, 2);
  });

  it("'last' answers the most recent message from anyone", async () => {
    await received({ phone: "+447700900111", name: "Honza Novák", text: "Older message", hoursAgo: 5, wamid: "wamid.OLD" });
    await received({ phone: "+447700900222", name: "Petra Dvořáková", text: "Newest message", hoursAgo: 1, wamid: "wamid.NEW" });
    stubProviders();
    const asked = await replyAction({ sender_or_message: "last", body: DICTATED });
    assert.equal(asked.body.error, "CONFIRMATION_REQUIRED", JSON.stringify(asked.body));
    assert.equal(asked.body.data.preview.to, "+447700900222");
    assert.equal(asked.body.data.preview.inReplyTo.text, "Newest message");
  });

  it("finds the sender by the number as spoken", async () => {
    await received({ phone: "+447700900111", name: "Honza Novák", text: "Hello", hoursAgo: 1, wamid: "wamid.N1" });
    await received({ phone: "+447700900222", name: "Petra Dvořáková", text: "Hi", hoursAgo: 1, wamid: "wamid.N2" });
    stubProviders();
    const asked = await replyAction({ sender_or_message: "07700 900222", body: DICTATED });
    assert.equal(asked.body.error, "CONFIRMATION_REQUIRED", JSON.stringify(asked.body));
    assert.equal(asked.body.data.preview.to, "+447700900222");
  });

  it("refuses to guess between two senders", async () => {
    await received({ phone: "+447700900111", name: "Jan Novák", text: "Hello", hoursAgo: 1, wamid: "wamid.J1" });
    await received({ phone: "+447700900222", name: "Jan Dvořák", text: "Hi", hoursAgo: 1, wamid: "wamid.J2" });
    stubProviders();
    const asked = await replyAction({ sender_or_message: "Jan", body: DICTATED });
    assert.equal(asked.body.error, "AMBIGUOUS_REFERENCE", JSON.stringify(asked.body));
    assert.equal(translationRequests, 0);
    assert.equal(sends.length, 0);
    assert.equal(await prisma.voicePendingAction.count({ where: { status: "pending" } }), 0);
  });

  it("refuses a reply after the 24-hour WhatsApp window instead of failing after approval", async () => {
    await received({ phone: "+447700900333", name: "Old Customer", text: "Are you free next week?", hoursAgo: 25, wamid: "wamid.LATE" });
    stubProviders();
    const asked = await replyAction({ sender_or_message: "Old Customer", body: DICTATED });
    assert.equal(asked.body.error, "WHATSAPP_REPLY_WINDOW_CLOSED", JSON.stringify(asked.body));
    assert.equal(translationRequests, 0, "nothing is translated for a reply that cannot be sent");
    assert.equal(sends.length, 0);
  });

  it("reports Meta's closed-window refusal as such when the window closes after the preview", async () => {
    const intake = await received({ phone: "+447700900444", name: "Edge Case", text: "Hello", hoursAgo: 23, wamid: "wamid.EDGE" });
    stubProviders({ graphError: { status: 400, code: 131047 } });
    const sent = await replyRoute({ intake_id: intake.id, body: TRANSLATED, confirmed: true });
    assert.equal(sent.status, 409, JSON.stringify(sent.body));
    assert.equal(sent.body.error, "WHATSAPP_REPLY_WINDOW_CLOSED");
  });

  it("names another language only when asked, and never translates an approved reply", async () => {
    const intake = await received({ phone: "+447700900555", name: "Pavel", text: "Dobrý den", hoursAgo: 1, wamid: "wamid.CZ" });
    stubProviders({ translation: "Dobrý den, přijedeme v pondělí v osm ráno." });
    const asked = await replyRoute({ intake_id: intake.id, body: DICTATED, send_in: "česky" });
    assert.equal(asked.status, 409, JSON.stringify(asked.body));
    assert.match(asked.body.preview.sentIn, /Czech|čeština|Čeština/i);

    const translatedAgain = await replyRoute({ intake_id: intake.id, body: DICTATED, send_in: "anglicky", confirmed: true });
    assert.equal(translatedAgain.status, 400);
    assert.equal(translatedAgain.body.error, "TRANSLATION_AFTER_APPROVAL");

    const unbound = await replyRoute({ sender_or_message: "Pavel", body: TRANSLATED, confirmed: true });
    assert.equal(unbound.status, 400, "a confirmed reply must name the exact message reviewed");
    assert.equal(sends.length, 0);
  });

  it("never reaches another company's messages", async () => {
    const other = await prisma.company.create({ data: { name: "Other WhatsApp Co" } });
    const foreign = await received({ phone: "+447700900666", name: "Foreign Sender", text: "Hello", hoursAgo: 1, wamid: "wamid.FOREIGN", companyId: other.id, connectorSourceId: null });
    stubProviders();
    const byId = await replyRoute({ intake_id: foreign.id, body: TRANSLATED, confirmed: true });
    assert.equal(byId.status, 404, JSON.stringify(byId.body));
    assert.equal(byId.body.error, "WHATSAPP_MESSAGE_NOT_FOUND");
    const byName = await replyAction({ sender_or_message: "Foreign Sender", body: DICTATED });
    assert.equal(byName.body.error, "WHATSAPP_MESSAGE_NOT_FOUND", JSON.stringify(byName.body));
    assert.equal(sends.length, 0);
  });

  it("is refused to a user without the connector permission", async () => {
    const intake = await received({ phone: "+447700900777", name: "Somebody", text: "Hello", hoursAgo: 1, wamid: "wamid.PERM" });
    const worker = await request(app).post("/auth/login").send({ email: "worker@test.local", password: "Password123!" });
    stubProviders();
    const refused = await request(app).post(`/connectors/sources/${sourceId}/whatsapp/messages/reply`)
      .set("Authorization", `Bearer ${worker.body.token}`)
      .send({ intake_id: intake.id, body: TRANSLATED, confirmed: true });
    assert.equal(refused.status, 403, JSON.stringify(refused.body));
    assert.equal(sends.length, 0);
  });
});
