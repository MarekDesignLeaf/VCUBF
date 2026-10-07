import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import request from "supertest";
import { buildGmailMimeMessage, compactReferences, gmailProviderScopes, mailboxCount, parseGmailMessage } from "../src/connectors/gmailAdapter.js";
import { prisma } from "../src/db.js";
import { createServer } from "../src/server.js";
import { resetDb, seedCompanyAndAdmin } from "./setup.js";

// Answering a received email by voice: "odpověz Novákovi na e-mail, že…".
//
// The reply goes to the sender of that one email, from the mailbox it arrived
// in, in the same conversation; nothing spoken can change any of the three. It
// is written in English unless another language is named, read back before the
// yes, and the yes sends exactly the reviewed text once.

const app = createServer();
const originalFetch = globalThis.fetch;
const ENV_NAMES = ["OPENAI_API_KEY", "GMAIL_OAUTH_CLIENT_ID", "GMAIL_OAUTH_CLIENT_SECRET", "GMAIL_OAUTH_REDIRECT_URI", "CONNECTOR_ENCRYPTION_KEY", "FRONTEND_URL"] as const;
const originalEnv = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));

const TRANSLATED = "We will come on Monday at eight.";

let token = "";
let adminId = "";
let workerToken = "";
let businessId = "";
let personalId = "";
let readOnlyId = "";
let sent: Array<{ authorization: string; raw: string; threadId?: string }> = [];
let translationRequests = 0;
let originalReads = 0;

function url(input: string | URL | Request) {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

/** Google and OpenAI as the reply needs them; every send is recorded. */
function stubProviders(options: { accessToken?: string; profileEmail?: string; scopes?: string[]; translation?: string; originalGone?: boolean; originalFrom?: string } = {}) {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const target = url(input);
    if (target === "https://oauth2.googleapis.com/token") {
      return Response.json({
        access_token: options.accessToken ?? "access-token",
        refresh_token: `refresh-${options.accessToken ?? "token"}`,
        expires_in: 3600,
        scope: gmailProviderScopes(options.scopes ?? ["read:messages", "send:messages"]).join(" "),
        token_type: "Bearer",
      });
    }
    if (target.endsWith("/users/me/profile")) return Response.json({ emailAddress: options.profileEmail, historyId: "1" });
    if (target.includes("api.openai.com")) {
      translationRequests += 1;
      return Response.json({ output_text: options.translation ?? TRANSLATED });
    }
    if (target.endsWith("/users/me/messages/send")) {
      const body = JSON.parse(String(init?.body));
      sent.push({ authorization: new Headers(init?.headers).get("authorization") ?? "", raw: Buffer.from(body.raw, "base64url").toString("utf8"), threadId: body.threadId });
      return Response.json({ id: `sent-${sent.length}`, threadId: body.threadId ?? "new-thread" });
    }
    if (/\/users\/me\/messages\/gm-/.test(target)) {
      originalReads += 1;
      if (options.originalGone) return new Response("not found", { status: 404 });
      return Response.json({
        id: "gm-jan-2",
        threadId: "thread-jan",
        payload: { headers: [
          { name: "Message-ID", value: "<orig-2@mail.example.com>" },
          { name: "References", value: "<orig-1@mail.example.com>" },
          { name: "Subject", value: "Nabídka na plot" },
          { name: "From", value: options.originalFrom ?? "\"Novák, Jan\" <jan@example.com>" },
        ] },
      });
    }
    return new Response("unexpected call", { status: 500 });
  }) as typeof globalThis.fetch;
}

async function authorise(sourceId: string, accessToken: string, profileEmail: string, scopes?: string[]) {
  const start = await request(app).post(`/connectors/sources/${sourceId}/oauth/start`).set("Authorization", `Bearer ${token}`).send({});
  assert.equal(start.status, 200, JSON.stringify(start.body));
  const authorizationUrl = new URL(start.body.authorizationUrl);
  stubProviders({ accessToken, profileEmail, scopes });
  const callback = await request(app).get("/connectors/gmail/oauth/callback").query({ state: authorizationUrl.searchParams.get("state"), code: `code-${accessToken}` });
  assert.equal(callback.status, 303, JSON.stringify(callback.body));
}

async function source(name: string, scopes: string[], accessToken: string, profileEmail: string) {
  const created = await request(app).post("/connectors/sources").set("Authorization", `Bearer ${token}`)
    .send({ connector_key: "gmail", display_name: name, configured_scopes: scopes });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  await authorise(created.body.id, accessToken, profileEmail, scopes);
  await prisma.connectorSource.update({ where: { id: created.body.id }, data: { isEnabled: true, connectionStatus: "enabled" } });
  return created.body.id as string;
}

async function received(input: { sourceId: string; id: string; thread: string; name: string | null; email: string; subject: string; text: string; hoursAgo: number; companyId?: string; kept?: Record<string, unknown> }) {
  const company = await prisma.user.findUniqueOrThrow({ where: { id: adminId }, select: { companyId: true } });
  return prisma.communicationIntake.create({
    data: {
      companyId: input.companyId ?? company.companyId,
      connectorSourceId: input.sourceId,
      externalMessageId: input.id,
      externalThreadId: input.thread,
      channel: "email",
      senderName: input.name,
      senderEmail: input.email,
      messageText: `Subject: ${input.subject}\n\n${input.text}`,
      receivedAt: new Date(Date.now() - input.hoursAgo * 60 * 60 * 1000),
      sourceReference: `gmail:${input.sourceId}:${input.id}`,
      // Without "kept", as an email imported before the import kept its reply headers.
      sourceMetadata: { provider: "gmail", labelIds: ["INBOX"], ...input.kept },
      createdBy: adminId,
    },
  });
}

const speak = (text: string) =>
  request(app).post("/command/assistant").set("Authorization", `Bearer ${token}`).send({ text, input_method: "voice_transcript" });
const replyAction = (parameters: Record<string, unknown>) => speak(`voice action reply_email ${JSON.stringify(parameters)}`);

describe("Replying to a received email", () => {
  before(async () => {
    process.env.OPENAI_API_KEY = "test-openai-key";
    process.env.GMAIL_OAUTH_CLIENT_ID = "test-client.apps.googleusercontent.com";
    process.env.GMAIL_OAUTH_CLIENT_SECRET = "test-client-secret";
    process.env.GMAIL_OAUTH_REDIRECT_URI = "http://localhost:4000/connectors/gmail/oauth/callback";
    process.env.CONNECTOR_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    process.env.FRONTEND_URL = "http://localhost:5173";
    await resetDb();
    const { admin, worker } = await seedCompanyAndAdmin();
    adminId = admin.id;
    token = (await request(app).post("/auth/login").send({ email: "admin@test.local", password: "Password123!" })).body.token;
    workerToken = (await request(app).post("/auth/login").send({ email: worker.email, password: "Password123!" })).body.token;
    businessId = await source("Business Gmail", ["read:messages", "send:messages"], "access-business", "marek@designleaf.co.uk");
    personalId = await source("Osobní Gmail", ["read:messages", "send:messages"], "access-personal", "marek.private@gmail.com");
    readOnlyId = await source("Archive Gmail", ["read:messages"], "access-archive", "archive@designleaf.co.uk");
  });

  beforeEach(async () => {
    await prisma.voicePendingAction.deleteMany({});
    await prisma.communicationIntake.deleteMany({});
    sent = [];
    translationRequests = 0;
    originalReads = 0;
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

  it("answers the sender's latest email from the mailbox it arrived in, in its conversation, after the review", async () => {
    await received({ sourceId: businessId, id: "gm-jan-1", thread: "thread-old", name: "Jan Novák", email: "jan@example.com", subject: "Dotaz", text: "Older question.", hoursAgo: 30 });
    const latest = await received({ sourceId: personalId, id: "gm-jan-2", thread: "thread-jan", name: "Jan Novák", email: "jan@example.com", subject: "Nabídka na plot", text: "Dobrý den, kdy můžete přijet?", hoursAgo: 2 });
    await received({ sourceId: businessId, id: "gm-petra", thread: "thread-petra", name: "Petra Dvořáková", email: "petra@example.com", subject: "Faktura", text: "Děkuji.", hoursAgo: 1 });

    stubProviders();
    const asked = await replyAction({ sender_or_message: "Jan", body: "Přijedeme v pondělí v osm." });
    assert.equal(asked.body.error, "CONFIRMATION_REQUIRED", JSON.stringify(asked.body));
    const preview = asked.body.data.preview;
    assert.equal(preview.intakeId, latest.id, "the sender's latest email");
    assert.equal(preview.fromAccount, "marek.private@gmail.com", "from the mailbox it arrived in, not the default sender");
    assert.deepEqual(preview.to, ["jan@example.com"]);
    assert.equal(preview.subject, "Re: Nabídka na plot");
    assert.equal(preview.body, TRANSLATED, "written in English by default");
    assert.equal(preview.dictated, "Přijedeme v pondělí v osm.");
    assert.equal(asked.body.message, `Reply to Jan Novák (jan@example.com) about “Nabídka na plot”, from marek.private@gmail.com. I will send in English: “${TRANSLATED}”. Shall I send it?`);
    assert.equal(sent.length, 0, "nothing leaves before the yes");

    const pending = await prisma.voicePendingAction.findFirstOrThrow({ where: { status: "pending" } });
    const waiting = (pending.payload as unknown as { action: string; parameters: Record<string, unknown> });
    assert.equal(waiting.action, "reply_email");
    assert.deepEqual(waiting.parameters, { intake_id: latest.id, body: TRANSLATED }, "the yes binds to one email and the reviewed text");

    stubProviders({ accessToken: "access-personal", translation: "THIS SECOND TRANSLATION MUST NEVER BE SENT" });
    translationRequests = 0;
    const confirmed = await speak("yes");
    assert.equal(confirmed.body.ok, true, JSON.stringify(confirmed.body));
    assert.equal(sent.length, 1, "exactly one email leaves");
    assert.equal(sent[0].authorization, "Bearer access-personal");
    assert.equal(sent[0].threadId, "thread-jan", "in the same Gmail conversation");
    assert.match(sent[0].raw, /^To: jan@example\.com\r\n/m);
    assert.match(sent[0].raw, /^Subject: =\?UTF-8\?B\?/m, "the Czech subject is encoded, not mangled");
    assert.match(sent[0].raw, /^In-Reply-To: <orig-2@mail\.example\.com>\r\n/m);
    assert.match(sent[0].raw, /^References: <orig-1@mail\.example\.com> <orig-2@mail\.example\.com>\r\n/m);
    assert.ok(sent[0].raw.endsWith(`\r\n\r\n${TRANSLATED}`), "the reviewed text, as reviewed");
    assert.equal(translationRequests, 0, "an approved reply is never translated again");

    const answered = await prisma.communicationIntake.findUniqueOrThrow({ where: { id: latest.id } });
    const replies = (answered.sourceMetadata as { replies?: Array<{ messageId: string }> }).replies ?? [];
    assert.deepEqual(replies.map((reply) => reply.messageId), ["sent-1"]);

    const audit = await prisma.auditLog.findFirstOrThrow({ where: { actionName: "reply_gmail_message", result: "success" } });
    assert.ok(!JSON.stringify(audit).includes(TRANSLATED), "the email text is not copied into the audit");
    const everyAudit = JSON.stringify(await prisma.auditLog.findMany({}));
    assert.ok(!everyAudit.includes("Přijedeme v pondělí"), "nor is the dictated text, in any audit record");
    assert.ok(!everyAudit.includes(TRANSLATED), "nor the English sent");

    const again = await speak("yes");
    assert.notEqual(again.body.ok, true, "a second yes must not send the reply again");
    assert.equal(sent.length, 1);
  });

  it("'last' answers the newest email from anyone; a name two senders share is refused", async () => {
    await received({ sourceId: businessId, id: "gm-1", thread: "t1", name: "Jan Novák", email: "jan@example.com", subject: "A", text: "First.", hoursAgo: 5 });
    await received({ sourceId: businessId, id: "gm-2", thread: "t2", name: "Jan Dvořák", email: "jan.dvorak@example.com", subject: "B", text: "Second.", hoursAgo: 4 });
    const newest = await received({ sourceId: businessId, id: "gm-3", thread: "t3", name: null, email: "orders@supplier.example", subject: "Dodávka", text: "Third.", hoursAgo: 1 });

    stubProviders();
    const last = await replyAction({ sender_or_message: "last", body: "Thank you." });
    assert.equal(last.body.data.preview.intakeId, newest.id);
    assert.deepEqual(last.body.data.preview.to, ["orders@supplier.example"]);

    await prisma.voicePendingAction.deleteMany({});
    const ambiguous = await replyAction({ sender_or_message: "Jan", body: "Thank you." });
    assert.equal(ambiguous.body.error, "AMBIGUOUS_REFERENCE", JSON.stringify(ambiguous.body));
    assert.match(ambiguous.body.message, /Jan Novák \(jan@example\.com\)/);
    assert.match(ambiguous.body.message, /Jan Dvořák \(jan\.dvorak@example\.com\)/);

    const byAddress = await replyAction({ sender_or_message: "jan.dvorak@example.com", body: "Thank you." });
    assert.deepEqual(byAddress.body.data.preview.to, ["jan.dvorak@example.com"], "an address picks exactly that sender");
    assert.equal(sent.length, 0);
  });

  it("finds a sender with no display name by the pieces of the address, and \"the last one from\" means theirs", async () => {
    const older = await received({ sourceId: businessId, id: "gm-p1", thread: "tp", name: null, email: "petra.dvorakova@example.com", subject: "Faktura", text: "Děkuji.", hoursAgo: 6 });
    await received({ sourceId: businessId, id: "gm-o", thread: "to", name: "Someone Else", email: "else@example.com", subject: "Other", text: "Hi.", hoursAgo: 1 });
    stubProviders();
    const asked = await replyAction({ sender_or_message: "last Petra", body: "Thank you." });
    assert.equal(asked.body.data?.preview?.intakeId, older.id, JSON.stringify(asked.body));
    assert.equal(asked.body.message.startsWith("Reply to petra.dvorakova@example.com about “Faktura”"), true, asked.body.message);
  });

  it("will not answer an email whose From line is not one valid address", async () => {
    await received({ sourceId: businessId, id: "gm-two", thread: "tt", name: "Jan Novák", email: "jan@example.com,boss@victim.example", subject: "A", text: "Hi.", hoursAgo: 1 });
    stubProviders();
    const refused = await replyAction({ sender_or_message: "Jan", body: "Thank you." });
    assert.equal(refused.body.error, "EMAIL_SENDER_ADDRESS_INVALID", JSON.stringify(refused.body));
    assert.equal(await prisma.voicePendingAction.count({ where: { status: "pending" } }), 0);
    assert.equal(sent.length, 0);
  });

  it("refuses, before the review, a reply that could not join the conversation", async () => {
    // Imported before the import kept the reply headers, and since deleted.
    const email = await received({ sourceId: businessId, id: "gm-gone", thread: "thread-gone", name: "Jan Novák", email: "jan@example.com", subject: "Plot", text: "Hi.", hoursAgo: 1 });
    stubProviders({ accessToken: "access-business", originalGone: true });
    const asked = await replyAction({ sender_or_message: "Jan", body: "Děkuji." });
    assert.equal(asked.body.error, "EMAIL_THREAD_UNAVAILABLE", JSON.stringify(asked.body));
    assert.equal(await prisma.voicePendingAction.count({ where: { status: "pending" } }), 0, "no yes is asked for");
    assert.equal(translationRequests, 0);

    const confirmed = await request(app).post("/connectors/gmail/messages/reply").set("Authorization", `Bearer ${token}`)
      .send({ intake_id: email.id, body: "Thank you.", confirmed: true });
    assert.equal(confirmed.status, 409, JSON.stringify(confirmed.body));
    assert.equal(confirmed.body.error, "EMAIL_THREAD_UNAVAILABLE");
    assert.equal(sent.length, 0, "never sent as a new email that looks like an answer");
    const refusal = await prisma.auditLog.findFirstOrThrow({ where: { actionName: "reply_gmail_message", errorMessage: "EMAIL_THREAD_UNAVAILABLE", confirmed: true } });
    assert.equal(refusal.result, "rejected");
  });

  it("answers from the headers kept at import, even after the original is gone", async () => {
    const email = await received({
      sourceId: businessId, id: "gm-kept", thread: "thread-kept", name: "Jan Novák", email: "jan@example.com", subject: "Plot", text: "Hi.", hoursAgo: 1,
      kept: { messageId: "<kept-2@mail.example.com>", references: "<kept-1@mail.example.com>", fromAddresses: 1 },
    });
    stubProviders({ accessToken: "access-business", originalGone: true });
    const done = await request(app).post("/connectors/gmail/messages/reply").set("Authorization", `Bearer ${token}`)
      .send({ intake_id: email.id, body: "Thank you.", confirmed: true });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(originalReads, 0, "nothing had to be read from Gmail");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].threadId, "thread-kept");
    assert.match(sent[0].raw, /^In-Reply-To: <kept-2@mail\.example\.com>\r\n/m);
    assert.match(sent[0].raw, /^References: <kept-1@mail\.example\.com> <kept-2@mail\.example\.com>\r\n/m);
  });

  it("will not answer a From line that named several addresses, though only the first was kept as the sender", async () => {
    // A real import keeps the first address as senderEmail and counts the rest.
    await received({
      sourceId: businessId, id: "gm-many", thread: "tm", name: null, email: "alice@example.com", subject: "A", text: "Hi.", hoursAgo: 2,
      kept: { messageId: "<many@mail.example.com>", references: null, fromAddresses: 2 },
    });
    stubProviders();
    const refused = await replyAction({ sender_or_message: "alice@example.com", body: "Thank you." });
    assert.equal(refused.body.error, "EMAIL_SENDER_ADDRESS_INVALID", JSON.stringify(refused.body));

    // An older import has no count; the original's From line is read instead.
    await prisma.communicationIntake.deleteMany({});
    await received({ sourceId: businessId, id: "gm-many-old", thread: "tmo", name: null, email: "alice@example.com", subject: "A", text: "Hi.", hoursAgo: 2 });
    stubProviders({ originalFrom: "Alice <alice@example.com>, Bob <bob@example.com>" });
    const old = await replyAction({ sender_or_message: "alice@example.com", body: "Thank you." });
    assert.equal(old.body.error, "EMAIL_SENDER_ADDRESS_INVALID", JSON.stringify(old.body));
    assert.equal(originalReads, 1);
    assert.equal(await prisma.voicePendingAction.count({ where: { status: "pending" } }), 0);
    assert.equal(sent.length, 0);
  });

  it("says in the review when exactly this reply already went to this email", async () => {
    const email = await received({
      sourceId: businessId, id: "gm-again", thread: "thread-again", name: "Jan Novák", email: "jan@example.com", subject: "Plot", text: "Hi.", hoursAgo: 1,
      kept: { messageId: "<again@mail.example.com>", references: null, fromAddresses: 1 },
    });
    stubProviders({ accessToken: "access-business" });
    const first = await request(app).post("/connectors/gmail/messages/reply").set("Authorization", `Bearer ${token}`)
      .send({ intake_id: email.id, body: TRANSLATED, confirmed: true });
    assert.equal(first.status, 200, JSON.stringify(first.body));

    const again = await replyAction({ sender_or_message: "Jan", body: "Přijedeme v pondělí v osm." });
    assert.equal(again.body.data.preview.alreadySent?.minutesAgo, 0, JSON.stringify(again.body.data?.preview));
    assert.match(again.body.message, /Note: I already sent exactly this a moment ago\. Shall I send it\?$/);

    await prisma.voicePendingAction.deleteMany({});
    stubProviders({ translation: "A different answer." });
    const different = await replyAction({ sender_or_message: "Jan", body: "Něco jiného." });
    assert.equal(different.body.data.preview.alreadySent, undefined);
    assert.equal(sent.length, 1, "a review sends nothing");
  });

  it("keeps companies apart and requires the connector permission", async () => {
    const other = await prisma.company.create({ data: { name: "Other company" } });
    const theirs = await received({ sourceId: businessId, id: "gm-theirs", thread: "tz", name: "Jan Novák", email: "jan@example.com", subject: "A", text: "Hi.", hoursAgo: 1, companyId: other.id });
    stubProviders();
    const foreign = await request(app).post("/connectors/gmail/messages/reply").set("Authorization", `Bearer ${token}`)
      .send({ intake_id: theirs.id, body: "Thank you.", confirmed: true });
    assert.equal(foreign.status, 404, JSON.stringify(foreign.body));
    const mine = await received({ sourceId: businessId, id: "gm-mine", thread: "tm", name: "Jan Novák", email: "jan@example.com", subject: "A", text: "Hi.", hoursAgo: 1 });
    const worker = await request(app).post("/connectors/gmail/messages/reply").set("Authorization", `Bearer ${workerToken}`)
      .send({ intake_id: mine.id, body: "Thank you.", confirmed: true });
    assert.equal(worker.status, 403);
    assert.equal(sent.length, 0);
  });

  it("refuses when the mailbox it arrived in cannot send, rather than sending from another account", async () => {
    await received({ sourceId: readOnlyId, id: "gm-archive", thread: "ta", name: "Eva Malá", email: "eva@example.com", subject: "Dotaz", text: "Kdy?", hoursAgo: 1 });
    stubProviders();
    const refused = await replyAction({ sender_or_message: "Eva", body: "Tomorrow." });
    assert.equal(refused.body.error, "CONNECTOR_SCOPE_REQUIRED", JSON.stringify(refused.body));
    assert.equal(await prisma.voicePendingAction.count({ where: { status: "pending" } }), 0, "nothing waits for a yes");
    assert.equal(sent.length, 0);
    assert.equal(translationRequests, 0, "nothing is translated for a reply that cannot leave");
  });

  it("says when no received email matches, and binds a confirmed reply to its email", async () => {
    await received({ sourceId: businessId, id: "gm-x", thread: "tx", name: "Jan Novák", email: "jan@example.com", subject: "A", text: "Hello.", hoursAgo: 1 });
    stubProviders();
    const missing = await replyAction({ sender_or_message: "Zdeněk", body: "Hello." });
    assert.equal(missing.body.error, "EMAIL_MESSAGE_NOT_FOUND", JSON.stringify(missing.body));

    const route = await request(app).post("/connectors/gmail/messages/reply").set("Authorization", `Bearer ${token}`)
      .send({ sender_or_message: "Jan", body: "Hello.", confirmed: true });
    assert.equal(route.status, 400, "a confirmed reply must name the exact email it answers");
    assert.equal(sent.length, 0);
  });
});

describe("What an import keeps for a later reply", () => {
  const imported = (from: string, extra: Array<{ name: string; value: string }> = []) => parseGmailMessage({
    id: "m1", threadId: "t1", payload: { mimeType: "text/plain", headers: [{ name: "From", value: from }, ...extra], body: { data: Buffer.from("Hi").toString("base64url") } },
  });

  it("counts every address on the From line, not only the one kept as the sender", () => {
    const two = imported("Alice <alice@example.com>, Bob <bob@example.com>");
    assert.equal(two.senderEmail, "alice@example.com");
    assert.equal(two.senderAddressCount, 2);
    assert.equal(imported("\"Novák, Jan (a@b)\" <jan@example.com>").senderAddressCount, 1, "a comma or @ inside a quoted name is not an address");
    assert.equal(imported("jan@example.com").senderAddressCount, 1);
    assert.equal(imported("undisclosed-recipients:;").senderAddressCount, 0);
    assert.equal(mailboxCount("a@x.example; b@y.example"), 2, "a semicolon some mail programs write counts too");
    assert.equal(mailboxCount("Alice (contact foo@example.com, (primary)) <alice@example.com>"), 1, "a nested comment is not an address");
    assert.equal(mailboxCount("Alice ((a@x.example), b@y.example) <alice@example.com>, bob@example.com"), 2);
  });

  it("reads the sender as it counts: never an address inside a comment or a quoted name", () => {
    // A reply goes to senderEmail. An address mentioned only in a comment or a
    // display name must not become it, or the reply would be disclosed there.
    const sender = (from: string) => { const parsed = imported(from); return [parsed.senderEmail, parsed.senderAddressCount]; };
    assert.deepEqual(sender("(contact foo@example.com , (primary)) alice@example.com"), ["alice@example.com", 1]);
    assert.deepEqual(sender("Alice (work, bob@evil.example) <alice@example.com>"), ["alice@example.com", 1]);
    assert.deepEqual(sender("\"foo@evil.example\" <alice@example.com>"), ["alice@example.com", 1]);
    assert.deepEqual(sender("\"x, foo@evil.example\" alice@example.com"), ["alice@example.com", 1]);
    assert.deepEqual(sender("Alice (unclosed alice@example.com"), [null, 0], "a broken line yields no sender, not a wrong one");
    assert.equal(imported("\"Jan (CZ)\" <jan@example.com>").senderName, "Jan (CZ)");
    // Malformed lines that name more than one address are refused.
    assert.equal(mailboxCount("b@evil.example alice@example.com"), 2);
    assert.equal(mailboxCount("foo@evil.example <alice@example.com>"), 2);
    assert.equal(mailboxCount("(a \"quote) b@evil.example\" ) alice@example.com"), 2, "a quote inside a comment is only a character");
  });

  it("keeps the Message-ID and a short References chain, and nothing that is not one", () => {
    const parsed = imported("jan@example.com", [
      { name: "Message-ID", value: " <m2@mail.example.com> " },
      { name: "References", value: "<m0@mail.example.com> junk\r\nBcc: evil@example.com <m1@mail.example.com>" },
    ]);
    assert.equal(parsed.messageIdHeader, "<m2@mail.example.com>");
    assert.equal(parsed.references, "<m0@mail.example.com> <m1@mail.example.com>");
    assert.equal(imported("jan@example.com", [{ name: "Message-ID", value: "x\r\nBcc: evil@example.com" }]).messageIdHeader, null);
    const long = Array.from({ length: 15 }, (_, index) => `<r${index}@mail.example.com>`).join(" ");
    assert.equal(compactReferences(long)?.split(" ").length, 10, "the first and the latest nine");
    assert.ok(compactReferences(long)?.startsWith("<r0@mail.example.com> <r6@mail.example.com>"));
  });
});

describe("Reply headers", () => {
  it("names the answered message and keeps the conversation, but writes no header from untrusted text", () => {
    const mime = buildGmailMimeMessage({
      to: ["jan@example.com"], subject: "Re: Plot", body: "Hello",
      reply: { threadId: "t1", messageId: "<b@example.com>", references: "<a@example.com> junk\r\nBcc: evil@example.com <b@example.com>" },
    });
    assert.match(mime, /^In-Reply-To: <b@example\.com>\r\n/m);
    assert.match(mime, /^References: <a@example\.com> <b@example\.com>\r\n/m);
    assert.doesNotMatch(mime, /evil@example\.com/);
    const forged = buildGmailMimeMessage({ to: ["jan@example.com"], subject: "Hi", body: "x", reply: { messageId: "x\r\nBcc: evil@example.com" } });
    assert.doesNotMatch(forged, /In-Reply-To|evil/);
  });
});
