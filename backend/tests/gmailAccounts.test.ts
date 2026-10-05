import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import request from "supertest";
import { gmailProviderScopes } from "../src/connectors/gmailAdapter.js";
import { prisma } from "../src/db.js";
import { chooseGmailSendingAccount, matchGmailAccounts } from "../src/lib/gmailAccountChoice.js";
import { createServer } from "../src/server.js";
import { resetDb, seedCompanyAndAdmin } from "./setup.js";

// Two Gmail accounts side by side: a company mailbox and a personal one.
//
// Each source records the Google account it was authorised as (read from the
// Gmail profile, never typed), the same mailbox cannot be connected twice,
// and one account is the default sender. A message goes from the account the
// owner names, otherwise from the default; the review says which, and the yes
// is bound to that exact account.

const app = createServer();
const originalFetch = globalThis.fetch;
const ENV_NAMES = ["OPENAI_API_KEY", "GMAIL_OAUTH_CLIENT_ID", "GMAIL_OAUTH_CLIENT_SECRET", "GMAIL_OAUTH_REDIRECT_URI", "CONNECTOR_ENCRYPTION_KEY", "FRONTEND_URL"] as const;
const originalEnv = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
const SCOPES = ["read:messages", "send:messages"];

let token = "";
let businessId = "";
let personalId = "";
let sentWith: string[] = [];

function url(input: string | URL | Request) {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

function stubGoogle(options: { accessToken?: string; profileEmail?: string } = {}) {
  sentWith = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const target = url(input);
    if (target === "https://oauth2.googleapis.com/token") {
      return Response.json({
        access_token: options.accessToken ?? "access-token",
        refresh_token: `refresh-${options.accessToken ?? "token"}`,
        expires_in: 3600,
        scope: gmailProviderScopes(SCOPES).join(" "),
        token_type: "Bearer",
      });
    }
    if (target.endsWith("/users/me/profile")) return Response.json({ emailAddress: options.profileEmail, historyId: "1" });
    if (target.includes("api.openai.com")) return Response.json({ output_text: "Quote\n\n<<<BODY>>>\n\nHello, the quote is attached." });
    if (target.endsWith("/users/me/messages/send")) {
      sentWith.push(new Headers(init?.headers).get("authorization") ?? "");
      return Response.json({ id: `sent-${sentWith.length}`, threadId: "thread-1" });
    }
    return new Response("unexpected call", { status: 500 });
  }) as typeof globalThis.fetch;
}

async function authorise(sourceId: string, accessToken: string, profileEmail: string) {
  const start = await request(app).post(`/connectors/sources/${sourceId}/oauth/start`).set("Authorization", `Bearer ${token}`).send({});
  assert.equal(start.status, 200, JSON.stringify(start.body));
  const authorizationUrl = new URL(start.body.authorizationUrl);
  assert.equal(authorizationUrl.searchParams.get("prompt"), "consent select_account", "Google always offers the account chooser");
  stubGoogle({ accessToken, profileEmail });
  return request(app).get("/connectors/gmail/oauth/callback").query({ state: authorizationUrl.searchParams.get("state"), code: `code-${accessToken}` });
}

const speak = (text: string) =>
  request(app).post("/command/assistant").set("Authorization", `Bearer ${token}`).send({ text, input_method: "voice_transcript" });
const sendEmail = (parameters: Record<string, unknown>) =>
  speak(`voice action send_email ${JSON.stringify({ to: ["jan@example.com"], subject: "Nabídka", body: "Dobrý den, posílám nabídku.", ...parameters })}`);

describe("Two Gmail accounts", () => {
  before(async () => {
    process.env.OPENAI_API_KEY = "test-openai-key";
    process.env.GMAIL_OAUTH_CLIENT_ID = "test-client.apps.googleusercontent.com";
    process.env.GMAIL_OAUTH_CLIENT_SECRET = "test-client-secret";
    process.env.GMAIL_OAUTH_REDIRECT_URI = "http://localhost:4000/connectors/gmail/oauth/callback";
    process.env.CONNECTOR_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
    process.env.FRONTEND_URL = "http://localhost:5173";
    await resetDb();
    await seedCompanyAndAdmin();
    token = (await request(app).post("/auth/login").send({ email: "admin@test.local", password: "Password123!" })).body.token;
    for (const name of ["Business Gmail", "Osobní Gmail"]) {
      const created = await request(app).post("/connectors/sources").set("Authorization", `Bearer ${token}`)
        .send({ connector_key: "gmail", display_name: name, configured_scopes: SCOPES });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      if (name === "Business Gmail") businessId = created.body.id; else personalId = created.body.id;
    }
  });

  beforeEach(async () => {
    await prisma.voicePendingAction.deleteMany({});
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

  it("records the authorised account, makes the first one the default sender and refuses the same mailbox twice", async () => {
    const business = await authorise(businessId, "access-business", "Marek@DesignLeaf.co.uk");
    assert.equal(business.status, 303, JSON.stringify(business.body));
    let source = await prisma.connectorSource.findUniqueOrThrow({ where: { id: businessId } });
    assert.equal(source.accountEmail, "marek@designleaf.co.uk", "the address comes from the Gmail profile");
    assert.equal(source.isDefaultSender, true, "the first connected account sends by default");

    const twice = await authorise(personalId, "access-duplicate", "marek@designleaf.co.uk");
    assert.equal(twice.status, 409);
    assert.equal(twice.body.error, "GMAIL_ACCOUNT_ALREADY_CONNECTED");
    assert.equal(await prisma.connectorCredential.count({ where: { sourceId: personalId } }), 0, "no tokens are kept for a duplicate mailbox");

    const personal = await authorise(personalId, "access-personal", "marek.private@gmail.com");
    assert.equal(personal.status, 303, JSON.stringify(personal.body));
    source = await prisma.connectorSource.findUniqueOrThrow({ where: { id: personalId } });
    assert.equal(source.accountEmail, "marek.private@gmail.com");
    assert.equal(source.isDefaultSender, false, "a second account never takes over the default silently");

    await prisma.connectorSource.updateMany({ where: { id: { in: [businessId, personalId] } }, data: { isEnabled: true, connectionStatus: "enabled" } });
    const listed = await request(app).get("/connectors/sources").set("Authorization", `Bearer ${token}`);
    const shown = (listed.body as Array<{ id: string; accountEmail: string | null; isDefaultSender: boolean }>).filter((item) => [businessId, personalId].includes(item.id));
    assert.deepEqual(shown.map((item) => [item.accountEmail, item.isDefaultSender]).sort(), [["marek.private@gmail.com", false], ["marek@designleaf.co.uk", true]]);
  });

  it("sends from the default account, says so in the review, and the yes stays bound to that account", async () => {
    stubGoogle();
    const asked = await sendEmail({});
    assert.equal(asked.body.error, "CONFIRMATION_REQUIRED", JSON.stringify(asked.body));
    assert.equal(asked.body.data.preview.fromAccount, "marek@designleaf.co.uk");
    assert.match(asked.body.message, /from marek@designleaf\.co\.uk/);
    const pending = await prisma.voicePendingAction.findFirstOrThrow({ where: { status: "pending" } });
    assert.equal((pending.payload as { parameters: Record<string, unknown> }).parameters.from_source_id, businessId);

    // The default changes between the review and the yes: the reviewed
    // account still sends, never the new default.
    const changed = await request(app).post(`/connectors/sources/${personalId}/gmail/default-sender`).set("Authorization", `Bearer ${token}`).send({});
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    stubGoogle();
    const confirmed = await speak("ano");
    assert.equal(confirmed.body.ok, true, JSON.stringify(confirmed.body));
    assert.deepEqual(sentWith, ["Bearer access-business"]);
  });

  it("sends from the account the owner names, in Czech word forms", async () => {
    await request(app).post(`/connectors/sources/${businessId}/gmail/default-sender`).set("Authorization", `Bearer ${token}`).send({});
    stubGoogle();
    const asked = await sendEmail({ from: "z osobního účtu" });
    assert.equal(asked.body.error, "CONFIRMATION_REQUIRED", JSON.stringify(asked.body));
    assert.equal(asked.body.data.preview.fromAccount, "marek.private@gmail.com");
    stubGoogle();
    const confirmed = await speak("ano");
    assert.equal(confirmed.body.ok, true, JSON.stringify(confirmed.body));
    assert.deepEqual(sentWith, ["Bearer access-personal"]);
  });

  it("asks which account when none is named and there is no default, and lists what is connected", async () => {
    await prisma.connectorSource.updateMany({ where: { id: { in: [businessId, personalId] } }, data: { isDefaultSender: false } });
    stubGoogle();
    const ambiguous = await sendEmail({});
    assert.equal(ambiguous.body.error, "AMBIGUOUS_GMAIL_SOURCE", JSON.stringify(ambiguous.body));
    assert.match(ambiguous.body.message, /marek@designleaf\.co\.uk/);
    assert.match(ambiguous.body.message, /marek\.private@gmail\.com/);
    const unknown = await sendEmail({ from: "z účtu Xyz" });
    assert.equal(unknown.body.error, "GMAIL_ACCOUNT_NOT_FOUND", JSON.stringify(unknown.body));
    assert.deepEqual(sentWith, [], "nothing is sent while the account is unclear");
    assert.equal(await prisma.voicePendingAction.count({ where: { status: "pending" } }), 0);
  });

  it("changes the default sender by voice and audits the previous default", async () => {
    await prisma.connectorSource.update({ where: { id: personalId }, data: { isDefaultSender: true } });
    const said = await speak(`voice action set_default_email_account ${JSON.stringify({ account: "firemní" })}`);
    assert.equal(said.body.ok, true, JSON.stringify(said.body));
    assert.match(said.body.message, /marek@designleaf\.co\.uk/);
    const [business, personal] = await Promise.all([
      prisma.connectorSource.findUniqueOrThrow({ where: { id: businessId } }),
      prisma.connectorSource.findUniqueOrThrow({ where: { id: personalId } }),
    ]);
    assert.equal(business.isDefaultSender, true);
    assert.equal(personal.isDefaultSender, false, "only one default sender");
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { actionName: "set_default_gmail_sender", result: "success" }, orderBy: { createdAt: "desc" } });
    assert.deepEqual(audit.dataBefore, { defaultSourceId: personalId });
  });
});

describe("Choosing the sending account", () => {
  const business = { id: "b", displayName: "Business Gmail", accountEmail: "marek@designleaf.co.uk", isDefaultSender: true };
  const personal = { id: "p", displayName: "Osobní Gmail", accountEmail: "marek.private@gmail.com", isDefaultSender: false };

  it("understands the account by purpose, address or name, in either language", () => {
    for (const [spoken, expected] of [
      ["z firemního účtu", "b"], ["pracovní", "b"], ["designleaf", "b"], ["MAREK@designleaf.co.uk", "b"],
      ["z osobního", "p"], ["soukromého mailu", "p"], ["from my personal account", "p"], ["Osobní Gmail", "p"],
    ] as const) {
      const choice = chooseGmailSendingAccount([business, personal], spoken);
      assert.ok(choice.ok && choice.source.id === expected, `${spoken} → ${expected}`);
    }
  });

  it("does not mistake an address ending for a name", () => {
    assert.deepEqual(matchGmailAccounts([{ ...personal, displayName: "Home" }], "company"), [], "“company” is not the “.com” of an address");
  });

  it("uses the only account, else the default, else asks", () => {
    const only = chooseGmailSendingAccount([personal]);
    assert.ok(only.ok && only.reason === "only");
    const byDefault = chooseGmailSendingAccount([business, personal]);
    assert.ok(byDefault.ok && byDefault.source.id === "b" && byDefault.reason === "default");
    assert.equal(chooseGmailSendingAccount([{ ...business, isDefaultSender: false }, personal]).ok, false);
    const both = chooseGmailSendingAccount([business, personal], "gmail");
    assert.ok(!both.ok && both.error === "AMBIGUOUS_GMAIL_SOURCE", "a word both accounts share is not a choice");
  });
});
