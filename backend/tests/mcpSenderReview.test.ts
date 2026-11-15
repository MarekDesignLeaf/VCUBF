import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import bcrypt from "bcryptjs";
import request from "supertest";
import { createServer } from "../src/server.js";
import { prisma } from "../src/db.js";
import { MCP_READ_SCOPE, MCP_WRITE_SCOPE } from "../src/modules/mcp/oauth.js";
import { MCP_TOOLSET_REVISION } from "../src/modules/mcp/routes.js";
import { MCP_CANCEL_TOOL, MCP_CONFIRM_TOOL, MCP_WRITE_TOOLS } from "../src/modules/mcp/writeTools.js";
import { resetDb, seedCompanyAndAdmin, TEST_COMPANY_ID } from "./setup.js";

// Issue #74: the WhatsApp sender review (PR #73) and guarded permanent contact
// deletion, through the authenticated MCP gateway alone: OAuth 2.1 tokens,
// no Secretary web session, no browser.

const app = createServer();
const BASE = "https://secretary.test";
const RESOURCE = `${BASE}/mcp`;
const REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect";
const BOTH = `${MCP_READ_SCOPE} ${MCP_WRITE_SCOPE}`;
const ENV_KEYS = [
  "MCP_GATEWAY_ENABLED", "MCP_WRITE_ENABLED", "MCP_PUBLIC_URL", "WHATSAPP_GRAPH_API_VERSION", "WHATSAPP_PHONE_NUMBER_ID",
  "WHATSAPP_BUSINESS_ACCOUNT_ID", "WHATSAPP_ACCESS_TOKEN", "WHATSAPP_WEBHOOK_VERIFY_TOKEN", "META_APP_SECRET",
] as const;
const saved = Object.fromEntries(ENV_KEYS.map((name) => [name, process.env[name]]));

type Json = Record<string, any>;

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}


let messageCounter = 0;
async function inbound(from: string, name: string, body: string) {
  const waId = from.replace(/^\+/, "");
  messageCounter += 1;
  const raw = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{ changes: [{ field: "messages", value: {
      metadata: { phone_number_id: "123456789" },
      contacts: [{ wa_id: waId, profile: { name } }],
      messages: [{ id: `wamid.mcp-${messageCounter}`, from: waId, timestamp: String(1767225600 + messageCounter), type: "text", text: { body } }],
    } }] }],
  });
  const signature = "sha256=" + createHmac("sha256", "test-app-secret").update(raw).digest("hex");
  const res = await request(app).post("/connectors/whatsapp/webhook").set("Content-Type", "application/json").set("X-Hub-Signature-256", signature).send(raw);
  assert.equal(res.status, 200, res.text);
}

describe("MCP: WhatsApp sender review and permanent contact deletion without a web session", () => {
  let sourceId: string;
  let otherCompanyId: string;
  let writeToken: string;
  let readToken: string;
  let readerWriteToken: string;
  let workerToken: string;
  let otherToken: string;
  let foreignSenderId: string;

  const register = async () => (await request(app).post("/oauth/register").send({ client_name: "ChatGPT", redirect_uris: [REDIRECT] })).body.client_id as string;

  async function connect(email: string, decision = "approve_write") {
    const clientId = await register();
    const { verifier, challenge } = pkce();
    const consent = await request(app).post("/oauth/authorize").type("form").send({
      client_id: clientId, redirect_uri: REDIRECT, response_type: "code", code_challenge: challenge,
      code_challenge_method: "S256", state: "s-1", scope: BOTH, resource: RESOURCE,
      email, password: "Password123!", decision, ...(decision === "approve_write" ? { allow_write: "yes" } : {}),
    });
    assert.equal(consent.status, 302, consent.text);
    const code = new URL(consent.headers.location).searchParams.get("code")!;
    const token = await request(app).post("/oauth/token").type("form")
      .send({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier, resource: RESOURCE });
    assert.equal(token.status, 200, JSON.stringify(token.body));
    return token.body.access_token as string;
  }

  const rpc = (token: string, body: Json) => request(app).post("/mcp").set("Authorization", `Bearer ${token}`).send(body);
  const call = (token: string, name: string, args: unknown) =>
    rpc(token, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  const result = (res: request.Response) => {
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.result, JSON.stringify(res.body));
    return { isError: res.body.result.isError as boolean, body: JSON.parse(res.body.result.content[0].text) as Json };
  };
  const tools = async (token: string) => (await rpc(token, { jsonrpc: "2.0", id: 2, method: "tools/list" })).body.result.tools as Json[];
  const names = async (token: string) => (await tools(token)).map((tool) => tool.name as string);

  const senderByPhone = (phone: string) => prisma.externalContact.findFirstOrThrow({ where: { companyId: TEST_COMPANY_ID, phone } });
  const intakeSnapshot = () => prisma.communicationIntake.findMany({ where: { channel: "whatsapp" }, orderBy: { id: "asc" } });

  before(async () => {
    process.env.WHATSAPP_GRAPH_API_VERSION = "v99.0";
    process.env.WHATSAPP_PHONE_NUMBER_ID = "123456789";
    process.env.WHATSAPP_BUSINESS_ACCOUNT_ID = "987654321";
    process.env.WHATSAPP_ACCESS_TOKEN = "test-access-token";
    process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = "test-verify-token";
    process.env.META_APP_SECRET = "test-app-secret";
    process.env.MCP_GATEWAY_ENABLED = "true";
    process.env.MCP_WRITE_ENABLED = "true";
    process.env.MCP_PUBLIC_URL = BASE;

    await resetDb();
    await seedCompanyAndAdmin();
    const hash = await bcrypt.hash("Password123!", 10);
    await prisma.user.create({
      data: { companyId: TEST_COMPANY_ID, email: "reader@test.local", passwordHash: hash, displayName: "Reader", role: "office", permissions: ["crm.read"] },
    });
    const other = await prisma.company.create({ data: { name: "Other Sender Co" } });
    otherCompanyId = other.id;
    await prisma.user.create({
      data: { companyId: other.id, email: "other-admin@test.local", passwordHash: hash, displayName: "Other Admin", role: "administrator", permissions: ["crm.read", "crm.manage"] },
    });

    // The WhatsApp source is set up once through the web API, as in production;
    // everything after that goes through /mcp only.
    const login = await request(app).post("/auth/login").send({ email: "admin@test.local", password: "Password123!" });
    const auth = { Authorization: `Bearer ${login.body.token}` };
    const source = await request(app).post("/connectors/sources").set(auth)
      .send({ connector_key: "whatsapp_business", display_name: "Company WhatsApp", configured_scopes: ["read:messages", "send:messages"] });
    assert.equal(source.status, 201, JSON.stringify(source.body));
    sourceId = source.body.id;
    assert.equal((await request(app).post(`/connectors/sources/${sourceId}/enable`).set(auth).send({ confirmed: true })).status, 200);

    await inbound("+447700900601", "Jane Customer", "Hello, could you quote for a garden fence and patio installation?");
    await inbound("+447700900602", "Mum", "Dinner on Sunday?");
    await inbound("+447700900603", "Tom Maybe", "Hi");
    await inbound("+447700900604", "Old Import", "About the hedge trimming quote");

    // A legacy record from before the review existed: the sender was imported
    // automatically into CRM and is still pending review.
    const legacySender = await senderByPhone("+447700900604");
    const legacyContact = await prisma.contact.create({
      data: { companyId: TEST_COMPANY_ID, displayName: "Old Import", phone: "+447700900604", source: "whatsapp_business", preferredChannel: "whatsapp" },
    });
    await prisma.externalContact.update({ where: { id: legacySender.id }, data: { importedContactId: legacyContact.id } });

    // A sender in another company.
    const foreignSource = await prisma.connectorSource.create({
      data: { companyId: other.id, connectorKey: "whatsapp_business", serviceType: "messaging", displayName: "Other WhatsApp", isEnabled: true },
    });
    foreignSenderId = (await prisma.externalContact.create({
      data: { companyId: other.id, connectorSourceId: foreignSource.id, externalResourceName: "wa_id:447700900999", displayName: "Foreign", phone: "+447700900999" },
    })).id;

    writeToken = await connect("admin@test.local");
    readToken = await connect("admin@test.local", "approve");
    readerWriteToken = await connect("reader@test.local");
    workerToken = await connect("worker@test.local");
    otherToken = await connect("other-admin@test.local");
  });

  beforeEach(() => {
    process.env.MCP_GATEWAY_ENABLED = "true";
    process.env.MCP_WRITE_ENABLED = "true";
  });

  afterEach(async () => {
    await prisma.company.update({ where: { id: TEST_COMPANY_ID }, data: { safeModeSince: null, emmaDisabledCapabilities: [] } });
  });

  after(async () => {
    for (const name of ENV_KEYS) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    await resetDb();
    await prisma.$disconnect();
  });

  // ------------------------------------------------------------------------
  // Discovery.

  it("lists the review and deletion tools by scope and permission, and tells clients the tool set changed", async () => {
    const init = await rpc(writeToken, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    assert.match(init.body.result.serverInfo.version, new RegExp(`\\+${MCP_TOOLSET_REVISION.replace(/\./g, "\\.")}$`));
    assert.match(init.body.result.instructions, /delete_contact_permanently/);

    const write = await names(writeToken);
    for (const name of [
      "list_whatsapp_senders", "get_whatsapp_sender", "approve_whatsapp_sender", "reject_whatsapp_sender",
      "reopen_whatsapp_sender", "defer_whatsapp_sender", "delete_contact_permanently", "archive_contact", MCP_CONFIRM_TOOL, MCP_CANCEL_TOOL,
    ]) assert.ok(write.includes(name), name);

    const read = await names(readToken);
    assert.ok(read.includes("list_whatsapp_senders") && read.includes("get_whatsapp_sender"));
    assert.ok(!read.includes("approve_whatsapp_sender") && !read.includes("delete_contact_permanently"));

    // crm.read with a write grant: can look, cannot decide or delete.
    const reader = await names(readerWriteToken);
    assert.ok(reader.includes("list_whatsapp_senders"));
    assert.ok(!reader.includes("reject_whatsapp_sender") && !reader.includes("delete_contact_permanently"));

    const listed = await tools(writeToken);
    const deletion = listed.find((tool) => tool.name === "delete_contact_permanently")!;
    assert.equal(deletion.annotations.destructiveHint, true);
    const confirm = listed.find((tool) => tool.name === MCP_CONFIRM_TOOL)!;
    assert.ok(confirm.inputSchema.properties.confirm_display_name, "confirm_action takes the typed name");
    const list = listed.find((tool) => tool.name === "list_whatsapp_senders")!;
    assert.equal(list.annotations.readOnlyHint, true);
  });

  it("refuses without valid MCP authorization: no token, a garbage token, or the gateway off", async () => {
    const none = await request(app).post("/mcp").send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_whatsapp_senders", arguments: {} } });
    assert.equal(none.status, 401);
    assert.match(none.headers["www-authenticate"], /Bearer/);
    const garbage = await call("not-a-token", "delete_contact_permanently", { contact_id: randomUUID() });
    assert.equal(garbage.status, 401);
    process.env.MCP_GATEWAY_ENABLED = "false";
    assert.equal((await call(writeToken, "list_whatsapp_senders", {})).status, 404);
  });

  // ------------------------------------------------------------------------
  // Reading the queue.

  it("lists the pending queue for the caller's company only, without changing anything", async () => {
    const before = await intakeSnapshot();
    const { isError, body } = result(await call(readToken, "list_whatsapp_senders", {}));
    assert.equal(isError, false, JSON.stringify(body));
    assert.equal(body.data.source.id, sourceId);
    const phones = body.data.items.map((item: Json) => item.phone);
    assert.deepEqual([...phones].sort(), ["+447700900601", "+447700900602", "+447700900603", "+447700900604"]);
    assert.equal(body.data.counts.pending, 4);
    assert.ok(!JSON.stringify(body).includes("Foreign"));
    const jane = body.data.items.find((item: Json) => item.phone === "+447700900601");
    assert.equal(jane.signal.level, "work_related_candidate");
    assert.equal(jane.messageCount, 1);
    assert.deepEqual(await intakeSnapshot(), before);
    assert.ok(await prisma.auditLog.findFirst({ where: { actionName: "mcp_read_tool", inputPayload: { path: ["tool"], equals: "list_whatsapp_senders" } } }));
  });

  it("shows one sender with its messages and possible decisions; another company's sender is not found", async () => {
    const jane = await senderByPhone("+447700900601");
    const { body } = result(await call(readToken, "get_whatsapp_sender", { sender_id: jane.id }));
    assert.equal(body.data.displayName, "Jane Customer");
    assert.match(body.data.messages[0].text, /garden fence/);
    assert.ok(body.data.allowedDecisions.includes("approve_customer"));
    assert.ok(body.data.allowedDecisions.includes("reject"));

    const foreign = result(await call(writeToken, "get_whatsapp_sender", { sender_id: foreignSenderId }));
    assert.equal(foreign.isError, true);
    assert.equal(foreign.body.error, "WHATSAPP_SENDER_NOT_FOUND");
    const invalid = result(await call(writeToken, "get_whatsapp_sender", { sender_id: "jane" }));
    assert.equal(invalid.body.error, "VALIDATION_FAILED");
  });

  it("respects the administrator's switch for reading WhatsApp messages", async () => {
    await prisma.company.update({ where: { id: TEST_COMPANY_ID }, data: { emmaDisabledCapabilities: ["command.list_channel_messages"] } });
    const { isError, body } = result(await call(writeToken, "list_whatsapp_senders", {}));
    assert.equal(isError, true);
    assert.equal(body.error, "NOT_ALLOWED");
  });

  // ------------------------------------------------------------------------
  // Deciding.

  it("refuses decisions with a read token (insufficient scope) and for an account without crm.manage", async () => {
    const mum = await senderByPhone("+447700900602");
    const scoped = await call(readToken, "reject_whatsapp_sender", { sender_id: mum.id, classification: "personal" });
    assert.equal(scoped.status, 403);
    assert.match(scoped.headers["www-authenticate"], /insufficient_scope/);
    for (const token of [readerWriteToken, workerToken]) {
      const { isError, body } = result(await call(token, "reject_whatsapp_sender", { sender_id: mum.id, classification: "personal" }));
      assert.equal(isError, true);
      assert.equal(body.error, "MISSING_PERMISSION");
    }
    assert.equal((await senderByPhone("+447700900602")).reviewStatus, "pending");
  });

  it("approves a real customer only after the preview and confirm_action, once", async () => {
    const jane = await senderByPhone("+447700900601");
    const intakesBefore = await intakeSnapshot();
    const contactsBefore = await prisma.contact.count();
    const prepared = result(await call(writeToken, "approve_whatsapp_sender", { sender_id: jane.id, import_as: "contact_and_client", note: "Owner confirmed customer" }));
    assert.equal(prepared.isError, false, JSON.stringify(prepared.body));
    assert.equal(prepared.body.status, "confirmation_required");
    assert.equal(prepared.body.preview.contact.action, "create");
    assert.equal(prepared.body.preview.client.action, "create");
    assert.equal(prepared.body.preview.sender.phone, "+447700900601");
    assert.equal(await prisma.contact.count(), contactsBefore, "the preview changes nothing");
    assert.equal((await senderByPhone("+447700900601")).reviewStatus, "pending");

    const confirmed = result(await call(writeToken, MCP_CONFIRM_TOOL, { confirmation_id: prepared.body.confirmation_id }));
    assert.equal(confirmed.isError, false, JSON.stringify(confirmed.body));
    assert.equal(confirmed.body.data.reviewStatus, "approved");
    const contact = await prisma.contact.findUniqueOrThrow({ where: { id: confirmed.body.data.contactId } });
    assert.equal(contact.companyId, TEST_COMPANY_ID);
    assert.equal(contact.phone, "+447700900601");
    assert.ok(contact.clientId);
    const sender = await senderByPhone("+447700900601");
    assert.equal(sender.reviewStatus, "approved");
    assert.equal(sender.importedContactId, contact.id);

    const again = result(await call(writeToken, MCP_CONFIRM_TOOL, { confirmation_id: prepared.body.confirmation_id }));
    assert.equal(again.body.replayed, true, "a repeated yes gets the first answer back");
    assert.equal(await prisma.contact.count({ where: { phone: "+447700900601" } }), 1, "no duplicate contact");
    const reprepared = result(await call(writeToken, "approve_whatsapp_sender", { sender_id: jane.id }));
    assert.equal(reprepared.body.error, "ALREADY_APPROVED");

    assert.deepEqual(await intakeSnapshot(), intakesBefore, "WhatsApp messages are untouched");
    const audit = await prisma.auditLog.findFirst({ where: { actionName: "review_whatsapp_sender", result: "success", confirmed: true } });
    assert.equal(audit?.companyId, TEST_COMPANY_ID);
    assert.ok(await prisma.auditLog.findFirst({ where: { actionName: "mcp_write_tool", interpretedIntent: MCP_CONFIRM_TOOL, result: "success" } }));
  });

  it("refuses a stale approval: a new message after the preview", async () => {
    const tom = await senderByPhone("+447700900603");
    const prepared = result(await call(writeToken, "approve_whatsapp_sender", { sender_id: tom.id }));
    assert.equal(prepared.isError, false, JSON.stringify(prepared.body));
    // The sender changes after the person saw the preview.
    await prisma.externalContact.update({ where: { id: tom.id }, data: { displayName: "Tom Changed" } });
    const stale = result(await call(writeToken, MCP_CONFIRM_TOOL, { confirmation_id: prepared.body.confirmation_id }));
    assert.equal(stale.isError, true);
    assert.equal(stale.body.error, "PREVIEW_CHANGED");
    assert.equal((await senderByPhone("+447700900603")).reviewStatus, "pending");
    assert.equal(await prisma.contact.count({ where: { phone: "+447700900603" } }), 0);
  });

  it("rejects a personal sender after a preview, keeps their messages, and reopens on request", async () => {
    const mum = await senderByPhone("+447700900602");
    const intakesBefore = await intakeSnapshot();
    const prepared = result(await call(writeToken, "reject_whatsapp_sender", { sender_id: mum.id, classification: "personal", note: "Family" }));
    assert.equal(prepared.isError, false, JSON.stringify(prepared.body));
    assert.equal(prepared.body.preview.statusAfter, "rejected");
    assert.equal(prepared.body.preview.classificationAfter, "personal");
    assert.equal((await senderByPhone("+447700900602")).reviewStatus, "pending", "nothing before the yes");

    // cancel_action withdraws it; a new preview is needed.
    assert.equal(result(await call(writeToken, MCP_CANCEL_TOOL, { confirmation_id: prepared.body.confirmation_id })).body.cancelled, true);
    assert.equal(result(await call(writeToken, MCP_CONFIRM_TOOL, { confirmation_id: prepared.body.confirmation_id })).body.error, "CONFIRMATION_ALREADY_USED");

    const again = result(await call(writeToken, "reject_whatsapp_sender", { sender_id: mum.id, classification: "personal", note: "Family" }));
    const done = result(await call(writeToken, MCP_CONFIRM_TOOL, { confirmation_id: again.body.confirmation_id }));
    assert.equal(done.isError, false, JSON.stringify(done.body));
    let sender = await senderByPhone("+447700900602");
    assert.equal(sender.reviewStatus, "rejected");
    assert.equal(sender.reviewClassification, "personal");
    assert.equal(await prisma.contact.count({ where: { phone: "+447700900602" } }), 0);
    assert.deepEqual(await intakeSnapshot(), intakesBefore);

    // A new message from a rejected sender is stored and imports nothing.
    await inbound("+447700900602", "Mum", "Bring the cake");
    assert.equal((await senderByPhone("+447700900602")).reviewStatus, "rejected");
    assert.equal(await prisma.contact.count({ where: { phone: "+447700900602" } }), 0);

    // Approval is refused while rejected; reopening is previewed and confirmed.
    const blocked = result(await call(writeToken, "approve_whatsapp_sender", { sender_id: mum.id }));
    assert.equal(blocked.body.error, "WHATSAPP_SENDER_SUPPRESSED");
    const reopenPreview = result(await call(writeToken, "reopen_whatsapp_sender", { sender_id: mum.id, note: "Wrong classification" }));
    assert.equal(reopenPreview.isError, false, JSON.stringify(reopenPreview.body));
    assert.equal(reopenPreview.body.preview.statusBefore, "rejected");
    assert.equal(reopenPreview.body.preview.statusAfter, "pending");
    assert.equal((await senderByPhone("+447700900602")).reviewStatus, "rejected", "nothing before the yes");
    const reopened = result(await call(writeToken, MCP_CONFIRM_TOOL, { confirmation_id: reopenPreview.body.confirmation_id }));
    assert.equal(reopened.isError, false, JSON.stringify(reopened.body));
    sender = await senderByPhone("+447700900602");
    assert.equal(sender.reviewStatus, "pending");
    assert.equal(sender.reviewClassification, null);
    const replay = result(await call(writeToken, MCP_CONFIRM_TOOL, { confirmation_id: reopenPreview.body.confirmation_id }));
    assert.equal(replay.body.replayed, true);
    // Nothing to reopen any more: refused at the preview, nothing waits.
    const invalid = result(await call(writeToken, "reopen_whatsapp_sender", { sender_id: mum.id }));
    assert.equal(invalid.body.error, "INVALID_REVIEW_TRANSITION");
    assert.equal(invalid.body.confirmation_id, undefined);
  });

  it("defers a sender for later review", async () => {
    const tom = await senderByPhone("+447700900603");
    const prepared = result(await call(writeToken, "defer_whatsapp_sender", { sender_id: tom.id }));
    assert.equal(prepared.isError, false, JSON.stringify(prepared.body));
    const deferred = result(await call(writeToken, MCP_CONFIRM_TOOL, { confirmation_id: prepared.body.confirmation_id }));
    assert.equal(deferred.isError, false, JSON.stringify(deferred.body));
    assert.equal((await senderByPhone("+447700900603")).reviewStatus, "review_needed");
  });

  it("refuses a decision during the emergency stop", async () => {
    const tom = await senderByPhone("+447700900603");
    const prepared = result(await call(writeToken, "reject_whatsapp_sender", { sender_id: tom.id, classification: "other" }));
    await prisma.company.update({ where: { id: TEST_COMPANY_ID }, data: { safeModeSince: new Date() } });
    const refused = await call(writeToken, MCP_CONFIRM_TOOL, { confirmation_id: prepared.body.confirmation_id });
    assert.notEqual(refused.status, 200);
    assert.equal((await senderByPhone("+447700900603")).reviewStatus, "review_needed");
  });

  it("cannot decide about another company's sender", async () => {
    const jane = await senderByPhone("+447700900601");
    const foreign = result(await call(otherToken, "reject_whatsapp_sender", { sender_id: jane.id, classification: "personal" }));
    assert.equal(foreign.body.error, "WHATSAPP_SENDER_NOT_FOUND");
    const reopen = result(await call(otherToken, "reopen_whatsapp_sender", { sender_id: jane.id }));
    assert.equal(reopen.body.error, "WHATSAPP_SENDER_NOT_FOUND");
    assert.equal((await senderByPhone("+447700900601")).reviewStatus, "approved");
  });

  // ------------------------------------------------------------------------
  // Archive vs permanent deletion.

  it("rejecting a legacy auto-imported sender keeps the existing CRM contact", async () => {
    const legacy = await senderByPhone("+447700900604");
    const prepared = result(await call(writeToken, "reject_whatsapp_sender", { sender_id: legacy.id, classification: "supplier" }));
    assert.equal(prepared.body.preview.linkedContact.displayName, "Old Import");
    assert.match(prepared.body.preview.effect, /is kept/);
    result(await call(writeToken, MCP_CONFIRM_TOOL, { confirmation_id: prepared.body.confirmation_id }));
    const contact = await prisma.contact.findFirstOrThrow({ where: { phone: "+447700900604" } });
    assert.equal(contact.isActive, true);
  });

  it("archive stays reversible and separate: archiving does not delete", async () => {
    const contact = await prisma.contact.create({ data: { companyId: TEST_COMPANY_ID, displayName: "Archive Me", phone: "+447700900701", source: "manual" } });
    const prepared = result(await call(writeToken, "archive_contact", { contact_id: contact.id }));
    result(await call(writeToken, MCP_CONFIRM_TOOL, { confirmation_id: prepared.body.confirmation_id }));
    const kept = await prisma.contact.findUniqueOrThrow({ where: { id: contact.id } });
    assert.equal(kept.isActive, false, "archived, not deleted");
  });

  it("deletes a contact permanently only with the preview, an explicit yes and the exact typed name", async () => {
    const legacy = await senderByPhone("+447700900604");
    const contact = await prisma.contact.findFirstOrThrow({ where: { phone: "+447700900604" } });
    const intakesBefore = await intakeSnapshot();

    const prepared = result(await call(writeToken, "delete_contact_permanently", { contact_id: contact.id }));
    assert.equal(prepared.isError, false, JSON.stringify(prepared.body));
    assert.equal(prepared.body.reason, "permanent");
    assert.equal(prepared.body.confirm_display_name_required, "Old Import");
    assert.equal(prepared.body.preview.displayName, "Old Import");
    assert.equal(prepared.body.preview.externalLinks.length, 1);
    assert.match(prepared.body.preview.digest, /^[a-f0-9]{64}$/);
    assert.ok(await prisma.contact.findUnique({ where: { id: contact.id } }), "the preview deletes nothing");

    // No name, or a wrong one: refused, nothing consumed, nothing deleted.
    for (const typed of [undefined, "old import", "Old"]) {
      const refused = result(await call(writeToken, MCP_CONFIRM_TOOL, { confirmation_id: prepared.body.confirmation_id, ...(typed === undefined ? {} : { confirm_display_name: typed }) }));
      assert.equal(refused.body.error, "CONFIRMATION_TEXT_MISMATCH", String(typed));
    }
    assert.ok(await prisma.contact.findUnique({ where: { id: contact.id } }));

    const deleted = result(await call(writeToken, MCP_CONFIRM_TOOL, { confirmation_id: prepared.body.confirmation_id, confirm_display_name: "Old Import" }));
    assert.equal(deleted.isError, false, JSON.stringify(deleted.body));
    assert.equal(deleted.body.data.deleted, true);
    assert.equal(await prisma.contact.findUnique({ where: { id: contact.id } }), null);

    // The staged sender stays as evidence, unlinked and kept out of CRM.
    const sender = await prisma.externalContact.findUniqueOrThrow({ where: { id: legacy.id } });
    assert.equal(sender.importedContactId, null);
    assert.equal(sender.reviewStatus, "deleted_from_crm");
    assert.deepEqual(await intakeSnapshot(), intakesBefore, "messages are kept unchanged");

    const audit = await prisma.auditLog.findFirst({ where: { actionName: "delete_contact_permanently", result: "success" } });
    assert.equal(audit?.companyId, TEST_COMPANY_ID);
    assert.equal(audit?.confirmed, true);

    // A repeated yes is answered from the first one; nothing runs twice.
    const again = result(await call(writeToken, MCP_CONFIRM_TOOL, { confirmation_id: prepared.body.confirmation_id, confirm_display_name: "Old Import" }));
    assert.equal(again.body.replayed, true);
    assert.equal(await prisma.auditLog.count({ where: { actionName: "delete_contact_permanently", result: "success" } }), 1);
  });

  it("refuses a stale deletion preview: the contact changed after it was shown", async () => {
    const contact = await prisma.contact.create({ data: { companyId: TEST_COMPANY_ID, displayName: "Stale Person", phone: "+447700900702", source: "manual" } });
    const prepared = result(await call(writeToken, "delete_contact_permanently", { contact_id: contact.id }));
    await prisma.contact.update({ where: { id: contact.id }, data: { email: "stale@example.test" } });
    const stale = result(await call(writeToken, MCP_CONFIRM_TOOL, { confirmation_id: prepared.body.confirmation_id, confirm_display_name: "Stale Person" }));
    assert.equal(stale.isError, true);
    assert.equal(stale.body.error, "PREVIEW_CHANGED");
    assert.ok(await prisma.contact.findUnique({ where: { id: contact.id } }));
  });

  it("refuses permanent deletion across companies, without crm.manage, and with a read token", async () => {
    const contact = await prisma.contact.create({ data: { companyId: TEST_COMPANY_ID, displayName: "Protected Person", phone: "+447700900703", source: "manual" } });
    const foreign = result(await call(otherToken, "delete_contact_permanently", { contact_id: contact.id }));
    assert.equal(foreign.body.error, "CONTACT_NOT_FOUND");
    const worker = result(await call(workerToken, "delete_contact_permanently", { contact_id: contact.id }));
    assert.equal(worker.body.error, "MISSING_PERMISSION");
    const scoped = await call(readToken, "delete_contact_permanently", { contact_id: contact.id });
    assert.equal(scoped.status, 403);
    // Another person's confirmation id cannot be used, even with the right name.
    const prepared = result(await call(writeToken, "delete_contact_permanently", { contact_id: contact.id }));
    const hijack = result(await call(otherToken, MCP_CONFIRM_TOOL, { confirmation_id: prepared.body.confirmation_id, confirm_display_name: "Protected Person" }));
    assert.equal(hijack.body.error, "CONFIRMATION_NOT_FOUND");
    assert.ok(await prisma.contact.findUnique({ where: { id: contact.id } }));
    assert.equal(await prisma.contact.count({ where: { companyId: otherCompanyId } }), 0);
  });

  it("keeps the registry honest: every sender decision and the deletion are reviewed, and deletion needs a typed name", () => {
    const byName = new Map(MCP_WRITE_TOOLS.map((tool) => [tool.name, tool]));
    assert.equal(byName.get("approve_whatsapp_sender")?.kind, "reviewed");
    assert.equal(byName.get("reject_whatsapp_sender")?.kind, "reviewed");
    assert.equal(byName.get("delete_contact_permanently")?.kind, "reviewed");
    assert.ok(byName.get("delete_contact_permanently")?.typedConfirmation);
    assert.equal(byName.get("reopen_whatsapp_sender")?.kind, "reviewed");
    assert.equal(byName.get("defer_whatsapp_sender")?.kind, "reviewed");
    assert.ok(!byName.has("delete_client_permanently"), "client deletion stays in the web UI");
  });
});
