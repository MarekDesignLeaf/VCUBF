import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import bcrypt from "bcryptjs";
import request from "supertest";
import { createServer } from "../src/server.js";
import { prisma } from "../src/db.js";
import { signMcpAccessToken, type AuthedUser } from "../src/middleware/auth.js";
import { MCP_READ_SCOPE, MCP_WRITE_SCOPE } from "../src/modules/mcp/oauth.js";
import { mcpTools } from "../src/modules/mcp/routes.js";
import { MCP_CANCEL_TOOL, MCP_CONFIRM_TOOL, MCP_REVIEW, MCP_WRITE_TOOLS } from "../src/modules/mcp/writeTools.js";
import { confirmPendingEmmaAction } from "../src/services/emmaExecutableActionService.js";
import { addPayment, changeInvoiceStatus } from "../src/services/invoiceService.js";
import { convertLead } from "../src/services/leadService.js";
import { archiveContact } from "../src/services/contactService.js";
import { lockSafeModeSwitch, SafeModeActiveError, whileNotInSafeMode } from "../src/lib/safeMode.js";
import { resetDb, seedCompanyAndAdmin, TEST_COMPANY_ID } from "./setup.js";

// MCP gateway write access — voice assistant master document 1.1a, step P2c.

const app = createServer();
const BASE = "https://secretary.test";
const RESOURCE = `${BASE}/mcp`;
const REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect";
const BOTH = `${MCP_READ_SCOPE} ${MCP_WRITE_SCOPE}`;
const saved = { flag: process.env.MCP_GATEWAY_ENABLED, write: process.env.MCP_WRITE_ENABLED, url: process.env.MCP_PUBLIC_URL };

type Json = Record<string, any>;

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

const key = () => `k-${randomUUID()}`;

describe("MCP gateway write access", () => {
  let otherCompanyId: string;
  let adminClient: string;
  let workerClient: string;
  let otherClient: string;

  const register = async () => (await request(app).post("/oauth/register").send({ client_name: "ChatGPT", redirect_uris: [REDIRECT] })).body.client_id as string;

  const authorizeForm = (clientId: string, challenge: string, scope: string) => ({
    client_id: clientId, redirect_uri: REDIRECT, response_type: "code", code_challenge: challenge,
    code_challenge_method: "S256", state: "s-1", scope, resource: RESOURCE,
  });

  /** The whole OAuth flow: consent with the account password, then the code exchange. */
  async function connect(clientId: string, email: string, options: { scope?: string; decision?: string; tick?: boolean } = {}) {
    const { verifier, challenge } = pkce();
    const consent = await request(app).post("/oauth/authorize").type("form").send({
      ...authorizeForm(clientId, challenge, options.scope ?? BOTH),
      email, password: "Password123!", decision: options.decision ?? "approve_write",
      ...(options.tick === false ? {} : { allow_write: "yes" }),
    });
    assert.equal(consent.status, 302, consent.text);
    const code = new URL(consent.headers.location).searchParams.get("code")!;
    const token = await request(app).post("/oauth/token").type("form")
      .send({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier, resource: RESOURCE });
    assert.equal(token.status, 200, JSON.stringify(token.body));
    return token.body as { access_token: string; refresh_token: string; scope: string };
  }

  const rpc = (token: string, body: Json) =>
    request(app).post("/mcp").set("Authorization", `Bearer ${token}`).send(body);
  const call = (token: string, name: string, args: unknown) =>
    rpc(token, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  const result = (res: request.Response) => {
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return { isError: res.body.result.isError as boolean, body: JSON.parse(res.body.result.content[0].text) as Json };
  };
  const listNames = async (token: string) => ((await rpc(token, { jsonrpc: "2.0", id: 2, method: "tools/list" })).body.result.tools as Json[]).map((tool) => tool.name as string);

  let writeToken: string;

  before(async () => {
    await resetDb();
    await seedCompanyAndAdmin();
    const other = await prisma.company.create({ data: { name: "Other Write Co" } });
    otherCompanyId = other.id;
    await prisma.user.create({
      data: {
        companyId: other.id, email: "other-admin@test.local", passwordHash: await bcrypt.hash("Password123!", 10),
        displayName: "Other Admin", role: "administrator", permissions: ["crm.read", "crm.manage"],
      },
    });
    process.env.MCP_GATEWAY_ENABLED = "true";
    process.env.MCP_WRITE_ENABLED = "true";
    process.env.MCP_PUBLIC_URL = BASE;
    adminClient = await register();
    workerClient = await register();
    otherClient = await register();
    writeToken = (await connect(adminClient, "admin@test.local")).access_token;
  });

  beforeEach(() => {
    process.env.MCP_GATEWAY_ENABLED = "true";
    process.env.MCP_WRITE_ENABLED = "true";
    process.env.MCP_PUBLIC_URL = BASE;
  });

  afterEach(async () => {
    await prisma.company.update({ where: { id: TEST_COMPANY_ID }, data: { safeModeSince: null, emmaDisabledCapabilities: [] } });
  });

  after(async () => {
    for (const [name, value] of [["MCP_GATEWAY_ENABLED", saved.flag], ["MCP_WRITE_ENABLED", saved.write], ["MCP_PUBLIC_URL", saved.url]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await prisma.$disconnect();
  });

  // ------------------------------------------------------------------------
  // OAuth: two scopes, and writing only by its own approval.

  it("offers secretary.write only while the write switch is on", async () => {
    const on = await request(app).get("/.well-known/oauth-protected-resource/mcp");
    assert.deepEqual(on.body.scopes_supported, [MCP_READ_SCOPE, MCP_WRITE_SCOPE]);
    assert.deepEqual((await request(app).get("/.well-known/oauth-authorization-server")).body.scopes_supported, [MCP_READ_SCOPE, MCP_WRITE_SCOPE]);

    process.env.MCP_WRITE_ENABLED = "false";
    const off = await request(app).get("/.well-known/oauth-protected-resource/mcp");
    assert.deepEqual(off.body.scopes_supported, [MCP_READ_SCOPE]);
    const page = await request(app).get("/oauth/authorize").query(authorizeForm(adminClient, pkce().challenge, BOTH));
    assert.equal(page.status, 400, "write cannot even be asked for while it is off");
  });

  it("shows what writing means and needs a ticked box and its own button", async () => {
    const page = await request(app).get("/oauth/authorize").query(authorizeForm(adminClient, pkce().challenge, BOTH));
    assert.equal(page.status, 200);
    assert.match(page.text, /create and change/);
    assert.match(page.text, /name="allow_write"/);
    assert.match(page.text, /value="approve_write"/);
    assert.match(page.text, /chatgpt\.com/, "the return host is shown");

    const before = await prisma.mcpOAuthGrant.count();
    const unticked = await request(app).post("/oauth/authorize").type("form").send({
      ...authorizeForm(adminClient, pkce().challenge, BOTH), email: "admin@test.local", password: "Password123!", decision: "approve_write",
    });
    assert.equal(unticked.status, 400);
    assert.equal(unticked.headers.location, undefined);

    const notAsked = await request(app).post("/oauth/authorize").type("form").send({
      ...authorizeForm(adminClient, pkce().challenge, MCP_READ_SCOPE), email: "admin@test.local", password: "Password123!", decision: "approve_write", allow_write: "yes",
    });
    assert.equal(notAsked.status, 400, "write cannot be granted when it was not requested");
    assert.equal(await prisma.mcpOAuthGrant.count(), before);
  });

  it("grants read only when the person approves read only, even if write was asked for", async () => {
    const token = await connect(adminClient, "admin@test.local", { decision: "approve" });
    assert.equal(token.scope, MCP_READ_SCOPE);
    const names = await listNames(token.access_token);
    assert.ok(names.includes("run_read_command"));
    assert.ok(!names.includes("create_client"));
  });

  it("grants read and write with the box ticked, and audits both scopes", async () => {
    const token = await connect(adminClient, "admin@test.local");
    assert.equal(token.scope, BOTH);
    const audit = await prisma.auditLog.findFirst({ where: { actionName: "authorize_mcp_client" }, orderBy: { createdAt: "desc" } });
    assert.equal((audit?.inputPayload as Json).scope, BOTH);
    assert.equal(JSON.stringify(audit).includes("Password123!"), false);
  });

  it("never widens a grant on refresh", async () => {
    const read = await connect(adminClient, "admin@test.local", { decision: "approve" });
    const widened = await request(app).post("/oauth/token").type("form")
      .send({ grant_type: "refresh_token", refresh_token: read.refresh_token, client_id: adminClient, scope: BOTH });
    assert.equal(widened.status, 400);
    assert.equal(widened.body.error, "invalid_scope");
    const same = await request(app).post("/oauth/token").type("form")
      .send({ grant_type: "refresh_token", refresh_token: read.refresh_token, client_id: adminClient });
    assert.equal(same.status, 200, JSON.stringify(same.body));
    assert.equal(same.body.scope, MCP_READ_SCOPE);

    const write = await connect(adminClient, "admin@test.local");
    const narrowed = await request(app).post("/oauth/token").type("form")
      .send({ grant_type: "refresh_token", refresh_token: write.refresh_token, client_id: adminClient, scope: MCP_READ_SCOPE });
    assert.equal(narrowed.body.scope, MCP_READ_SCOPE, "a refresh may narrow");
  });

  it("drops write from a connection refreshed while writing is switched off", async () => {
    const write = await connect(adminClient, "admin@test.local");
    process.env.MCP_WRITE_ENABLED = "false";
    const refreshed = await request(app).post("/oauth/token").type("form")
      .send({ grant_type: "refresh_token", refresh_token: write.refresh_token, client_id: adminClient });
    assert.equal(refreshed.body.scope, MCP_READ_SCOPE);
    process.env.MCP_WRITE_ENABLED = "true";
    assert.ok(!(await listNames(refreshed.body.access_token)).includes("create_client"), "switching it back on needs a new approval");
  });

  // ------------------------------------------------------------------------
  // Refusals: read tokens, own token, the switch, roles, tenants.

  it("refuses a write with a read token: 403 insufficient_scope and nothing written", async () => {
    // A token exactly as the read-only gateway issued them before this change.
    const admin = await prisma.user.findUniqueOrThrow({ where: { email: "admin@test.local" } });
    const legacy = signMcpAccessToken({ sub: admin.id, authVersion: admin.authVersion, cid: adminClient, scope: MCP_READ_SCOPE }, RESOURCE, 600);
    const before = await prisma.client.count();
    const res = await call(legacy, "create_client", { idempotency_key: key(), client: { display_name: "Scope Test Ltd" } });
    assert.equal(res.status, 403);
    assert.match(res.headers["www-authenticate"], /error="insufficient_scope"/);
    assert.match(res.headers["www-authenticate"], /scope="secretary\.read secretary\.write"/);
    assert.match(res.headers["www-authenticate"], /resource_metadata="https:\/\/secretary\.test\/\.well-known\/oauth-protected-resource\/mcp"/);
    assert.equal(await prisma.client.count(), before);
    const audit = await prisma.auditLog.findFirst({ where: { actionName: "mcp_write_tool" }, orderBy: { createdAt: "desc" } });
    assert.equal(audit?.result, "rejected");
    assert.equal(audit?.errorMessage, "INSUFFICIENT_SCOPE");
    // Reading with it still works.
    assert.equal(result(await call(legacy, "run_read_command", { canonical_command: "list clients" })).isError, false);
  });

  it("keeps the owner's own Secretary token read only on the gateway", async () => {
    const login = await request(app).post("/auth/login").send({ email: "admin@test.local", password: "Password123!" });
    assert.ok(!(await listNames(login.body.token)).includes("create_client"));
    const res = await call(login.body.token, "create_client", { idempotency_key: key(), client: { display_name: "Own Token Ltd" } });
    assert.equal(res.status, 403);
  });

  it("writes nothing while the write switch is off, even with a write token", async () => {
    process.env.MCP_WRITE_ENABLED = "false";
    assert.ok(!(await listNames(writeToken)).includes("create_client"));
    const before = await prisma.client.count();
    const { isError, body } = result(await call(writeToken, "create_client", { idempotency_key: key(), client: { display_name: "Switched Off Ltd" } }));
    assert.equal(isError, true);
    assert.equal(body.error, "WRITE_DISABLED");
    assert.equal(await prisma.client.count(), before);
  });

  it("keeps the account's permissions: no crm.manage, no write tools and no writes", async () => {
    const worker = await connect(workerClient, "worker@test.local");
    assert.equal(worker.scope, BOTH, "the scope can be granted; the account still decides");
    assert.ok(!(await listNames(worker.access_token)).some((name) => MCP_WRITE_TOOLS.some((tool) => tool.name === name)));
    const before = await prisma.client.count();
    const { isError, body } = result(await call(worker.access_token, "create_client", { idempotency_key: key(), client: { display_name: "Worker Ltd" } }));
    assert.equal(isError, true);
    assert.equal(body.error, "MISSING_PERMISSION");
    assert.equal(await prisma.client.count(), before);
  });

  it("keeps the administrator's capability switch", async () => {
    await prisma.company.update({ where: { id: TEST_COMPANY_ID }, data: { emmaDisabledCapabilities: ["action.create_client"] } });
    const before = await prisma.client.count();
    const { isError, body } = result(await call(writeToken, "create_client", { idempotency_key: key(), client: { display_name: "Switched Ltd" } }));
    assert.equal(isError, true);
    assert.equal(body.error, "NOT_ALLOWED");
    assert.equal(await prisma.client.count(), before);
  });

  it("cannot reach another company's records", async () => {
    const mine = await prisma.client.create({ data: { companyId: TEST_COMPANY_ID, displayName: "Tenant A Client" } });
    const other = await connect(otherClient, "other-admin@test.local");
    const update = result(await call(other.access_token, "update_client", { idempotency_key: key(), client_id: mine.id, changes: { display_name: "Taken Over" } }));
    assert.equal(update.isError, true);
    assert.equal((await prisma.client.findUniqueOrThrow({ where: { id: mine.id } })).displayName, "Tenant A Client");

    const archive = result(await call(other.access_token, "archive_client", { client_id: mine.id }));
    assert.equal(archive.isError, true);
    assert.equal(archive.body.error, "CLIENT_NOT_FOUND");

    // A preview put up in company A cannot be confirmed from company B.
    const prepared = result(await call(writeToken, "archive_client", { client_id: mine.id }));
    const stolen = result(await call(other.access_token, MCP_CONFIRM_TOOL, { confirmation_id: prepared.body.confirmation_id }));
    assert.equal(stolen.body.error, "CONFIRMATION_NOT_FOUND");
    assert.equal((await prisma.client.findUniqueOrThrow({ where: { id: mine.id } })).isActive, true);
    result(await call(writeToken, MCP_CANCEL_TOOL, { confirmation_id: prepared.body.confirmation_id }));

    // A token naming company A's OAuth client but company B's user is refused at the door.
    const otherUser = await prisma.user.findUniqueOrThrow({ where: { email: "other-admin@test.local" } });
    const crossed = signMcpAccessToken({ sub: otherUser.id, authVersion: otherUser.authVersion, cid: adminClient, scope: BOTH }, RESOURCE, 600);
    assert.equal((await call(crossed, "create_client", { idempotency_key: key(), client: { display_name: "Crossed" } })).status, 401);
    assert.equal(await prisma.client.count({ where: { companyId: otherCompanyId } }), 0);
  });

  it("is closed during an emergency stop", async () => {
    await prisma.company.update({ where: { id: TEST_COMPANY_ID }, data: { safeModeSince: new Date() } });
    const before = await prisma.client.count();
    const res = await call(writeToken, "create_client", { idempotency_key: key(), client: { display_name: "Stopped Ltd" } });
    assert.equal(res.status, 423);
    assert.equal(await prisma.client.count(), before);
  });

  // ------------------------------------------------------------------------
  // Direct writes, once per key.

  it("lists the write tools for a write token and keeps list clients working", async () => {
    const tools = (await rpc(writeToken, { jsonrpc: "2.0", id: 3, method: "tools/list" })).body.result.tools as Json[];
    for (const name of ["run_read_command", "create_client", "update_task", "create_invoice_draft", MCP_CONFIRM_TOOL, MCP_CANCEL_TOOL]) {
      assert.ok(tools.some((tool) => tool.name === name), name);
    }
    for (const tool of tools.filter((entry) => MCP_WRITE_TOOLS.some((write) => write.name === entry.name))) {
      assert.equal(tool.annotations.readOnlyHint, false, tool.name);
      assert.equal(tool.inputSchema.type, "object", tool.name);
    }
    assert.ok(tools.find((tool) => tool.name === "create_client")!.inputSchema.required.includes("idempotency_key"));
    assert.equal(tools.find((tool) => tool.name === "archive_client")!.annotations.destructiveHint, true);

    await prisma.client.create({ data: { companyId: TEST_COMPANY_ID, displayName: "Listed Client Ltd" } });
    const listed = result(await call(writeToken, "run_read_command", { canonical_command: "list clients" }));
    assert.equal(listed.isError, false);
    assert.ok(JSON.stringify(listed.body).includes("Listed Client Ltd"));
    const init = await rpc(writeToken, { jsonrpc: "2.0", id: 4, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    assert.match(init.body.result.instructions, /confirm_action/);
  });

  it("creates a client once per idempotency key and audits it without its contents", async () => {
    const idempotencyKey = key();
    const args = { idempotency_key: idempotencyKey, client: { display_name: "Idempotent Gardens Ltd", email_primary: "idem@test.local" } };
    const first = result(await call(writeToken, "create_client", args));
    assert.equal(first.isError, false, JSON.stringify(first.body));
    assert.equal(first.body.data.displayName, "Idempotent Gardens Ltd");

    const again = result(await call(writeToken, "create_client", args));
    assert.equal(again.isError, false);
    assert.equal(again.body.replayed, true);
    assert.equal(again.body.data.id, first.body.data.id);
    assert.equal(await prisma.client.count({ where: { displayName: "Idempotent Gardens Ltd" } }), 1);

    const reused = result(await call(writeToken, "create_client", { idempotency_key: idempotencyKey, client: { display_name: "Something Else Ltd" } }));
    assert.equal(reused.body.error, "IDEMPOTENCY_KEY_REUSED");
    assert.equal(await prisma.client.count({ where: { displayName: "Something Else Ltd" } }), 0);

    const missing = result(await call(writeToken, "create_client", { client: { display_name: "No Key Ltd" } }));
    assert.equal(missing.body.error, "VALIDATION_FAILED");
    const extra = result(await call(writeToken, "create_client", { idempotency_key: key(), client: { display_name: "X" }, company_id: otherCompanyId }));
    assert.equal(extra.body.error, "VALIDATION_FAILED", "unknown arguments are refused, not ignored");

    const wrappers = await prisma.auditLog.findMany({ where: { actionName: "mcp_write_tool", interpretedIntent: "create_client", result: "success" } });
    assert.ok(wrappers.length >= 2);
    assert.ok(wrappers.some((entry) => (entry.inputPayload as Json).replayed === true));
    for (const entry of wrappers) {
      assert.equal(JSON.stringify(entry).includes("Idempotent Gardens"), false, "the wrapper never stores the record");
      assert.equal((entry.inputPayload as Json).oauthClientId, adminClient);
    }
    assert.equal(await prisma.auditLog.count({ where: { actionName: "create_client", result: "success", inputPayload: { path: ["display_name"], equals: "Idempotent Gardens Ltd" } } }), 1, "the owning service audits the change once");
  });

  it("validates through the owning service's own schema", async () => {
    const bad = result(await call(writeToken, "create_client", { idempotency_key: key(), client: { display_name: "Bad Mail Ltd", email_primary: "not-an-email" } }));
    assert.equal(bad.isError, true);
    assert.equal(bad.body.error, "VALIDATION_FAILED");
    assert.equal(await prisma.client.count({ where: { displayName: "Bad Mail Ltd" } }), 0);
  });

  it("creates and changes contacts, leads, jobs, tasks, quotes and draft invoices", async () => {
    const write = async (name: string, args: Json) => {
      const outcome = result(await call(writeToken, name, { idempotency_key: key(), ...args }));
      assert.equal(outcome.isError, false, `${name}: ${JSON.stringify(outcome.body)}`);
      return outcome.body.data as Json;
    };
    const client = await write("create_client", { client: { display_name: "Full Cycle Ltd", email_primary: "cycle@test.local" } });
    await write("update_client", { client_id: client.id, changes: { billing_city: "Didcot" } });
    assert.equal((await prisma.client.findUniqueOrThrow({ where: { id: client.id } })).billingCity, "Didcot");

    const contact = await write("create_contact", { contact: { display_name: "Jana Cycle", email: "jana@test.local", client_id: client.id } });
    await write("update_contact", { contact_id: contact.id, changes: { job_title: "Owner" } });

    const lead = await write("create_lead", { lead: { name: "Lead Cycle", email: "lead-cycle@test.local" } });
    await write("update_lead", { lead_id: lead.id, changes: { lead_status: "qualified" } });
    assert.equal((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).leadStatus, "qualified");

    const job = await write("create_job", { job: { client_id: client.id, job_title: "Hedge cutting" } });
    await write("change_job_status", { job_id: job.id, change: { job_status: "prijato" } });
    assert.equal((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).jobStatus, "prijato");

    const task = (await write("create_task", { task: { title: "Order hedge trimmer blades", client_id: client.id, job_id: job.id } })).task as Json;
    await write("update_task", { task_id: task.id, changes: { task_status: "completed" } });
    assert.equal((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).taskStatus, "completed");

    const quote = await write("create_quote", { quote: { client_id: client.id, title: "Hedge quote", items: [{ description: "Hedge cutting", quantity: 2, unit_price: 50 }] } });
    await write("update_quote", { quote_id: quote.id, changes: { notes: "Price as agreed on site" } });
    await write("change_quote_status", { quote_id: quote.id, change: { quote_status: "accepted" } });
    assert.equal((await prisma.quote.findUniqueOrThrow({ where: { id: quote.id } })).quoteStatus, "accepted");

    const invoice = await write("create_invoice_draft", { invoice: { client_id: client.id, invoice_number: "MCP-001", title: "Hedge cutting", items: [{ description: "Hedge cutting", unit_price: 100 }] } });
    assert.equal(invoice.invoiceStatus, "draft");
    await write("update_invoice_draft", { invoice_id: invoice.id, changes: { notes: "Thank you" } });
    assert.equal((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).notes, "Thank you");
  });

  // ------------------------------------------------------------------------
  // Reviewed writes: exact preview, explicit confirmation, once.

  it("archives a client only after a preview and its confirmation, once", async () => {
    const client = await prisma.client.create({ data: { companyId: TEST_COMPANY_ID, displayName: "Archive Me Ltd" } });
    const prepared = result(await call(writeToken, "archive_client", { client_id: client.id }));
    assert.equal(prepared.isError, false, JSON.stringify(prepared.body));
    assert.equal(prepared.body.status, "confirmation_required");
    assert.equal(prepared.body.preview.displayName, "Archive Me Ltd");
    assert.match(prepared.body.confirmation_id, /^[0-9a-f-]{36}$/);
    assert.equal((await prisma.client.findUniqueOrThrow({ where: { id: client.id } })).isActive, true, "a preview changes nothing");

    const confirmed = result(await call(writeToken, MCP_CONFIRM_TOOL, { confirmation_id: prepared.body.confirmation_id }));
    assert.equal(confirmed.isError, false, JSON.stringify(confirmed.body));
    assert.equal((await prisma.client.findUniqueOrThrow({ where: { id: client.id } })).isActive, false);

    const replay = result(await call(writeToken, MCP_CONFIRM_TOOL, { confirmation_id: prepared.body.confirmation_id }));
    assert.equal(replay.body.replayed, true, "a repeated yes gets the first answer and does nothing again");
    assert.equal(await prisma.auditLog.count({ where: { actionName: "archive_client", result: "success", inputPayload: { path: ["id"], equals: client.id } } }), 1);
    const audit = await prisma.auditLog.findFirst({ where: { actionName: "mcp_write_tool", interpretedIntent: MCP_CONFIRM_TOOL, result: "success" }, orderBy: { createdAt: "asc" } });
    assert.equal(audit?.confirmed, true);
    assert.equal((audit?.inputPayload as Json).contract, "archive_client");
  });

  it("confirms only the newest preview, only from the same connection, and cancels on request", async () => {
    const first = await prisma.client.create({ data: { companyId: TEST_COMPANY_ID, displayName: "First Preview Ltd" } });
    const second = await prisma.client.create({ data: { companyId: TEST_COMPANY_ID, displayName: "Second Preview Ltd" } });
    const a = result(await call(writeToken, "archive_client", { client_id: first.id })).body.confirmation_id;
    const b = result(await call(writeToken, "archive_client", { client_id: second.id })).body.confirmation_id;

    const stale = result(await call(writeToken, MCP_CONFIRM_TOOL, { confirmation_id: a }));
    assert.equal(stale.body.error, "CONFIRMATION_ALREADY_USED", "a replaced preview cannot be confirmed");
    assert.equal((await prisma.client.findUniqueOrThrow({ where: { id: first.id } })).isActive, true);

    // The same person through another OAuth connection cannot confirm it.
    const otherConnection = await connect(await register(), "admin@test.local");
    const foreign = result(await call(otherConnection.access_token, MCP_CONFIRM_TOOL, { confirmation_id: b }));
    assert.equal(foreign.body.error, "CONFIRMATION_NOT_FOUND");
    // Nor can Alfonzo's spoken yes: the MCP queue is its own.
    const user = await prisma.user.findUniqueOrThrow({ where: { email: "admin@test.local" } });
    const voice = await confirmPendingEmmaAction({ ...user, permissions: user.permissions } as unknown as AuthedUser);
    assert.equal(voice.ok, false);
    assert.equal((await prisma.voicePendingAction.findUniqueOrThrow({ where: { id: b } })).status, "pending");

    // A foreign attempt neither used nor blocked it: the real connection can still confirm it.
    const real = result(await call(writeToken, MCP_CONFIRM_TOOL, { confirmation_id: b }));
    assert.equal(real.isError, false, JSON.stringify(real.body));
    assert.equal((await prisma.client.findUniqueOrThrow({ where: { id: second.id } })).isActive, false);

    const c = result(await call(writeToken, "archive_client", { client_id: first.id })).body.confirmation_id;
    const cancelled = result(await call(writeToken, MCP_CANCEL_TOOL, { confirmation_id: c }));
    assert.equal(cancelled.body.cancelled, true);
    const late = result(await call(writeToken, MCP_CONFIRM_TOOL, { confirmation_id: c }));
    assert.equal(late.body.error, "CONFIRMATION_ALREADY_USED");
    assert.equal((await prisma.client.findUniqueOrThrow({ where: { id: first.id } })).isActive, true);
  });

  it("refuses a confirmation when the record changed after the preview", async () => {
    const client = await prisma.client.create({ data: { companyId: TEST_COMPANY_ID, displayName: "Invoice Client Ltd" } });
    const created = result(await call(writeToken, "create_invoice_draft", {
      idempotency_key: key(), invoice: { client_id: client.id, invoice_number: "MCP-PREVIEW-1", title: "Lawn care", items: [{ description: "Mowing", unit_price: 40 }] },
    })).body.data;
    const prepared = result(await call(writeToken, "change_invoice_status", { invoice_id: created.id, invoice_status: "issued" }));
    assert.equal(prepared.isError, false, JSON.stringify(prepared.body));
    assert.equal(prepared.body.reason, "financial");
    assert.equal(prepared.body.preview.statusBefore, "draft");
    assert.equal(prepared.body.preview.statusAfter, "issued");
    assert.equal(prepared.body.preview.totals.total, 40);

    // The amount changes after the person saw 40.
    result(await call(writeToken, "update_invoice_draft", { idempotency_key: key(), invoice_id: created.id, changes: { items: [{ description: "Mowing", unit_price: 400 }] } }));
    const confirmed = result(await call(writeToken, MCP_CONFIRM_TOOL, { confirmation_id: prepared.body.confirmation_id }));
    assert.equal(confirmed.body.error, "PREVIEW_CHANGED");
    assert.equal((await prisma.invoice.findUniqueOrThrow({ where: { id: created.id } })).invoiceStatus, "draft");

    // Prepared again and confirmed unchanged, it is issued.
    const again = result(await call(writeToken, "change_invoice_status", { invoice_id: created.id, invoice_status: "issued" }));
    assert.equal(again.body.preview.totals.total, 400);
    assert.equal(result(await call(writeToken, MCP_CONFIRM_TOOL, { confirmation_id: again.body.confirmation_id })).isError, false);
    assert.equal((await prisma.invoice.findUniqueOrThrow({ where: { id: created.id } })).invoiceStatus, "issued");
    const edit = result(await call(writeToken, "update_invoice_draft", { idempotency_key: key(), invoice_id: created.id, changes: { notes: "late edit" } }));
    assert.equal(edit.body.error, "INVOICE_NOT_EDITABLE", "an issued invoice is no longer a draft");
  });

  it("converts a lead only after its preview is confirmed", async () => {
    const lead = await prisma.lead.create({ data: { companyId: TEST_COMPANY_ID, name: "Convert Me", email: "convert-me@test.local" } });
    const prepared = result(await call(writeToken, "convert_lead", { lead_id: lead.id }));
    assert.equal(prepared.body.preview.outcome, "create_new_client");
    assert.equal((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).leadStatus, "new");
    assert.equal(result(await call(writeToken, MCP_CONFIRM_TOOL, { confirmation_id: prepared.body.confirmation_id })).isError, false);
    const converted = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    assert.equal(converted.leadStatus, "converted");
    assert.ok(converted.convertedClientId);
  });

  it("does not run a confirmation during an emergency stop, and keeps it waiting", async () => {
    const client = await prisma.client.create({ data: { companyId: TEST_COMPANY_ID, displayName: "Stop Review Ltd" } });
    const prepared = result(await call(writeToken, "archive_client", { client_id: client.id }));
    await prisma.company.update({ where: { id: TEST_COMPANY_ID }, data: { safeModeSince: new Date() } });
    const res = await call(writeToken, MCP_CONFIRM_TOOL, { confirmation_id: prepared.body.confirmation_id });
    assert.equal(res.status, 423);
    assert.equal((await prisma.client.findUniqueOrThrow({ where: { id: client.id } })).isActive, true);
    assert.equal((await prisma.voicePendingAction.findUniqueOrThrow({ where: { id: prepared.body.confirmation_id } })).status, "pending");
    await prisma.company.update({ where: { id: TEST_COMPANY_ID }, data: { safeModeSince: null } });
    result(await call(writeToken, MCP_CANCEL_TOOL, { confirmation_id: prepared.body.confirmation_id }));
  });

  // ------------------------------------------------------------------------
  // Unknown outcomes are kept, never repeated (review finding P1).

  /**
   * A real failure after a real write: the owning services save their record
   * and then write their audit entry outside any transaction. This trigger
   * makes that audit insert fail for marked records only, so the record is
   * already committed when the service throws.
   */
  async function failAuditAfterWrite(condition: string, work: () => Promise<void>) {
    await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION mcp_test_fail_audit() RETURNS trigger AS $$
      BEGIN IF ${condition} THEN RAISE EXCEPTION 'injected audit failure after the write'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER mcp_test_fail_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION mcp_test_fail_audit()`);
    try {
      await work();
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS mcp_test_fail_audit ON audit_log`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS mcp_test_fail_audit()`);
    }
  }

  it("makes a direct write in one transaction: a failure after the insert saves nothing, and a retry with its key saves it once", async () => {
    const marker = "Trigger Fault Lead";
    const args = { idempotency_key: key(), lead: { name: marker, email: "fault-lead@test.local" } };
    const taskArgs = { idempotency_key: key(), task: { title: "Trigger Fault Task" } };
    await failAuditAfterWrite(`NEW.action_name IN ('create_lead', 'create_task') AND NEW.input_payload::text LIKE '%Trigger Fault%'`, async () => {
      // The lead is inserted, then its audit entry fails: the whole write rolls back.
      const first = result(await call(writeToken, "create_lead", args));
      assert.equal(first.isError, true);
      assert.equal(first.body.error, "WRITE_FAILED");
      assert.equal(await prisma.lead.count({ where: { name: marker } }), 0, "nothing was saved");
      assert.equal(result(await call(writeToken, "create_task", taskArgs)).body.error, "WRITE_FAILED");
      assert.equal(await prisma.task.count({ where: { title: "Trigger Fault Task" } }), 0);
    });
    // The fault is gone: the same key runs once, and every later retry gets that answer.
    const saved = result(await call(writeToken, "create_lead", args));
    assert.equal(saved.isError, false, JSON.stringify(saved.body));
    const again = result(await call(writeToken, "create_lead", args));
    assert.equal(again.body.replayed, true);
    assert.equal(again.body.data.id, saved.body.data.id);
    assert.equal(await prisma.lead.count({ where: { name: marker } }), 1, "exactly one lead");
    assert.equal(result(await call(writeToken, "create_task", taskArgs)).isError, false);
    assert.equal(result(await call(writeToken, "create_task", taskArgs)).body.replayed, true);
    assert.equal(await prisma.task.count({ where: { title: "Trigger Fault Task" } }), 1, "exactly one task");
    // The owning service's audit entry was saved with the write it describes, once.
    assert.equal(await prisma.auditLog.count({ where: { actionName: "create_lead", result: "success", inputPayload: { path: ["name"], equals: marker } } }), 1);
  });

  it("keeps a confirmed change whose outcome is unknown, and a repeated yes does nothing again", async () => {
    const client = await prisma.client.create({ data: { companyId: TEST_COMPANY_ID, displayName: "Unknown Outcome Ltd" } });
    const prepared = result(await call(writeToken, "archive_client", { client_id: client.id }));
    await failAuditAfterWrite(`NEW.action_name = 'archive_client' AND NEW.result = 'success' AND NEW.input_payload->>'id' = '${client.id}'`, async () => {
      const confirmed = result(await call(writeToken, MCP_CONFIRM_TOOL, { confirmation_id: prepared.body.confirmation_id }));
      assert.equal(confirmed.body.error, "OUTCOME_UNKNOWN");
      assert.equal((await prisma.client.findUniqueOrThrow({ where: { id: client.id } })).isActive, false, "archived before the failure");
      const again = result(await call(writeToken, MCP_CONFIRM_TOOL, { confirmation_id: prepared.body.confirmation_id }));
      assert.equal(again.body.error, "OUTCOME_UNKNOWN");
    });
    assert.notEqual((await prisma.voicePendingAction.findUniqueOrThrow({ where: { id: prepared.body.confirmation_id } })).status, "pending", "the review can never be claimed again");
  });

  // ------------------------------------------------------------------------
  // An invoice is issued only as the whole document that was shown (review finding P2).

  async function draftInvoice(number: string, items: Json[], extra: Json = {}) {
    const client = await prisma.client.create({ data: { companyId: TEST_COMPANY_ID, displayName: `Client ${number}` } });
    const created = result(await call(writeToken, "create_invoice_draft", {
      idempotency_key: key(), invoice: { client_id: client.id, invoice_number: number, title: "Garden works", items, ...extra },
    }));
    assert.equal(created.isError, false, JSON.stringify(created.body));
    return created.body.data as Json;
  }

  it("shows the whole invoice and refuses to issue it when its lines changed but the total did not", async () => {
    const invoice = await draftInvoice("MCP-LINES-1", [{ description: "Hedge cutting", quantity: 1, unit_price: 100 }], { due_date: "2026-12-01T00:00:00.000Z", notes: "Payment within 14 days" });
    const prepared = result(await call(writeToken, "change_invoice_status", { invoice_id: invoice.id, invoice_status: "issued" }));
    assert.deepEqual(prepared.body.preview.items, [{ position: 0, description: "Hedge cutting", quantity: 1, unitPrice: 100, lineTotal: 100 }]);
    assert.equal(prepared.body.preview.dueDate, "2026-12-01T00:00:00.000Z");
    assert.equal(prepared.body.preview.notes, "Payment within 14 days");
    assert.equal(prepared.body.preview.client.id, invoice.clientId);
    assert.ok(prepared.body.preview.revision);

    // Different work, same total.
    result(await call(writeToken, "update_invoice_draft", { idempotency_key: key(), invoice_id: invoice.id, changes: { items: [{ description: "Turf laying", quantity: 2, unit_price: 50 }] } }));
    const confirmed = result(await call(writeToken, MCP_CONFIRM_TOOL, { confirmation_id: prepared.body.confirmation_id }));
    assert.equal(confirmed.body.error, "PREVIEW_CHANGED");
    assert.equal(confirmed.body.preview.totals.total, 100, "the total alone would not have shown it");
    assert.equal(confirmed.body.preview.items[0].description, "Turf laying");
    assert.equal((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).invoiceStatus, "draft");
  });

  it("refuses to issue an invoice whose due date or notes changed after the preview", async () => {
    const invoice = await draftInvoice("MCP-DUE-1", [{ description: "Pruning", unit_price: 80 }], { due_date: "2026-12-01T00:00:00.000Z" });
    const due = result(await call(writeToken, "change_invoice_status", { invoice_id: invoice.id, invoice_status: "issued" }));
    result(await call(writeToken, "update_invoice_draft", { idempotency_key: key(), invoice_id: invoice.id, changes: { due_date: "2026-11-05T00:00:00.000Z" } }));
    assert.equal(result(await call(writeToken, MCP_CONFIRM_TOOL, { confirmation_id: due.body.confirmation_id })).body.error, "PREVIEW_CHANGED");

    const notes = result(await call(writeToken, "change_invoice_status", { invoice_id: invoice.id, invoice_status: "issued" }));
    result(await call(writeToken, "update_invoice_draft", { idempotency_key: key(), invoice_id: invoice.id, changes: { notes: "Payment on receipt" } }));
    assert.equal(result(await call(writeToken, MCP_CONFIRM_TOOL, { confirmation_id: notes.body.confirmation_id })).body.error, "PREVIEW_CHANGED");
    assert.equal((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).invoiceStatus, "draft");
  });

  it("issues only the revision that was verified, under a row lock", async () => {
    const invoice = await draftInvoice("MCP-REV-1", [{ description: "Mowing", unit_price: 30 }]);
    const user = await prisma.user.findUniqueOrThrow({ where: { email: "admin@test.local" } });
    const stale = new Date(Date.now() - 60_000).toISOString();
    const refused = await changeInvoiceStatus(user as unknown as AuthedUser, invoice.id, { invoice_status: "issued", expected_revision: stale });
    assert.equal(refused.ok, false);
    assert.equal(!refused.ok && refused.error, "INVOICE_CHANGED");
    assert.equal((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).invoiceStatus, "draft");

    // A change of the lines alone moves the revision.
    const before = (await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).updatedAt;
    result(await call(writeToken, "update_invoice_draft", { idempotency_key: key(), invoice_id: invoice.id, changes: { items: [{ description: "Mowing", unit_price: 30 }] } }));
    assert.notEqual((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).updatedAt.getTime(), before.getTime());

    const current = (await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).updatedAt.toISOString();
    const issued = await changeInvoiceStatus(user as unknown as AuthedUser, invoice.id, { invoice_status: "issued", expected_revision: current });
    assert.equal(issued.ok, true);
  });

  it("moves the revision on a partial payment, so an approved void cannot act on a changed balance", async () => {
    const invoice = await draftInvoice("MCP-PAY-1", [{ description: "Patio", unit_price: 500 }]);
    const user = (await prisma.user.findUniqueOrThrow({ where: { email: "admin@test.local" } })) as unknown as AuthedUser;
    assert.equal((await changeInvoiceStatus(user, invoice.id, { invoice_status: "issued" })).ok, true);
    const approved = (await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).updatedAt.toISOString();

    // A partial payment lands between the verified preview and the status change.
    const paid = await addPayment(user, invoice.id, { amount: 100, paid_at: new Date().toISOString(), confirmed: true });
    assert.equal(paid.ok, true, JSON.stringify(paid));
    assert.notEqual((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).updatedAt.toISOString(), approved);

    const voided = await changeInvoiceStatus(user, invoice.id, { invoice_status: "void", expected_revision: approved });
    assert.equal(!voided.ok && voided.error, "INVOICE_CHANGED");
    assert.equal((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).invoiceStatus, "issued");
  });

  it("converts a lead only as the revision that was approved", async () => {
    const lead = await prisma.lead.create({ data: { companyId: TEST_COMPANY_ID, name: "Revision Lead", email: "revision-lead@test.local" } });
    const user = (await prisma.user.findUniqueOrThrow({ where: { email: "admin@test.local" } })) as unknown as AuthedUser;
    const approved = lead.updatedAt.toISOString();
    await prisma.lead.update({ where: { id: lead.id }, data: { email: "someone-else@test.local" } });
    const refused = await convertLead(user, lead.id, { expectedRevision: approved });
    assert.equal(!refused.ok && refused.error, "LEAD_CHANGED");
    assert.equal((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).leadStatus, "new");
    assert.equal(await prisma.client.count({ where: { emailPrimary: "someone-else@test.local" } }), 0, "no client was created");
  });

  it("converts a lead only to the client outcome that was approved", async () => {
    const user = (await prisma.user.findUniqueOrThrow({ where: { email: "admin@test.local" } })) as unknown as AuthedUser;
    const client = await prisma.client.create({ data: { companyId: TEST_COMPANY_ID, displayName: "Existing Match Ltd", emailPrimary: "match@test.local" } });
    const lead = await prisma.lead.create({ data: { companyId: TEST_COMPANY_ID, name: "Matching Lead", email: "match@test.local" } });
    const prepared = result(await call(writeToken, "convert_lead", { lead_id: lead.id }));
    assert.equal(prepared.body.preview.outcome, "link_existing_client");
    assert.equal(prepared.body.preview.client.id, client.id);

    // The client's e-mail changes; the lead does not.
    await prisma.client.update({ where: { id: client.id }, data: { emailPrimary: "moved@test.local" } });
    const direct = await convertLead(user, lead.id, { expectedRevision: lead.updatedAt.toISOString(), expectedClient: { id: client.id, displayName: client.displayName } });
    assert.equal(!direct.ok && direct.error, "CONVERSION_CHANGED");
    const confirmed = result(await call(writeToken, MCP_CONFIRM_TOOL, { confirmation_id: prepared.body.confirmation_id }));
    assert.equal(confirmed.body.error, "PREVIEW_CHANGED");
    assert.equal((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).leadStatus, "new");
    assert.equal(await prisma.client.count({ where: { displayName: "Matching Lead" } }), 0, "no new client was created instead");

    // Approved as a new client, refused once a matching client appears.
    const newLead = await prisma.lead.create({ data: { companyId: TEST_COMPANY_ID, name: "Fresh Lead", email: "fresh@test.local" } });
    await prisma.client.create({ data: { companyId: TEST_COMPANY_ID, displayName: "Fresh Match Ltd", emailPrimary: "fresh@test.local" } });
    const appeared = await convertLead(user, newLead.id, { expectedRevision: newLead.updatedAt.toISOString(), expectedClient: null });
    assert.equal(!appeared.ok && appeared.error, "CONVERSION_CHANGED");
  });

  it("refuses a preview too large to show whole, and leaves nothing to confirm", async () => {
    const client = await prisma.client.create({ data: { companyId: TEST_COMPANY_ID, displayName: "Large Invoice Ltd" } });
    const invoice = await prisma.invoice.create({
      data: {
        companyId: TEST_COMPANY_ID, clientId: client.id, invoiceNumber: "MCP-LARGE-1", title: "Large", notes: "Terms. ".repeat(9_000),
        items: { create: [{ companyId: TEST_COMPANY_ID, description: "Work", quantity: 1, unitPrice: 10, sortOrder: 0 }] },
      },
    });
    const before = await prisma.voicePendingAction.count({ where: { actionType: MCP_REVIEW.actionType, status: "pending" } });
    const res = await call(writeToken, "change_invoice_status", { invoice_id: invoice.id, invoice_status: "issued" });
    const refused = result(res);
    assert.equal(refused.isError, true);
    assert.equal(refused.body.error, "PREVIEW_TOO_LARGE");
    assert.equal(refused.body.confirmation_id, undefined);
    assert.ok(!res.body.result.content[0].text.endsWith("[truncated]"));
    assert.equal(await prisma.voicePendingAction.count({ where: { actionType: MCP_REVIEW.actionType, status: "pending" } }), before);
    assert.equal((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).invoiceStatus, "draft");
  });

  it("hands every accepted preview back whole, as valid JSON", async () => {
    const client = await prisma.client.create({ data: { companyId: TEST_COMPANY_ID, displayName: "Long Invoice Ltd" } });
    const invoice = await prisma.invoice.create({
      data: {
        companyId: TEST_COMPANY_ID, clientId: client.id, invoiceNumber: "MCP-LONG-1", title: "Long", notes: "Terms. ".repeat(5_000),
        items: { create: Array.from({ length: 40 }, (_, index) => ({ companyId: TEST_COMPANY_ID, description: `Line ${index}`, quantity: 1, unitPrice: 1, sortOrder: index })) },
      },
    });
    const res = await call(writeToken, "change_invoice_status", { invoice_id: invoice.id, invoice_status: "issued" });
    const prepared = result(res);
    assert.equal(prepared.isError, false, JSON.stringify(prepared.body).slice(0, 300));
    assert.equal(prepared.body.preview.items.length, 40);
    assert.equal(prepared.body.preview.totals.total, 40);
    result(await call(writeToken, MCP_CANCEL_TOOL, { confirmation_id: prepared.body.confirmation_id }));
  });

  // ------------------------------------------------------------------------
  // Races between the verified preview and the change (review round 3).

  /**
   * Runs a statement from inside the confirmation itself: when the owning
   * service records the unconfirmed preview it recomputes (an audit entry
   * written after it has read the record), the trigger makes a concurrent
   * change commit at exactly that point, between the verified preview and
   * the change. Created after the first preview, so only the confirmation
   * fires it.
   */
  async function duringReverification(condition: string, statement: string, work: () => Promise<void>) {
    await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION mcp_test_concurrent() RETURNS trigger AS $$
      BEGIN IF ${condition} THEN ${statement}; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER mcp_test_concurrent AFTER INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION mcp_test_concurrent()`);
    try {
      await work();
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS mcp_test_concurrent ON audit_log`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS mcp_test_concurrent()`);
    }
  }

  it("does not archive a client renamed between the verified preview and the archive", async () => {
    const client = await prisma.client.create({ data: { companyId: TEST_COMPANY_ID, displayName: "Approved Name Ltd" } });
    const prepared = result(await call(writeToken, "archive_client", { client_id: client.id }));
    assert.equal(prepared.body.preview.displayName, "Approved Name Ltd");
    // Renamed by raw SQL, so even the revision column does not move: the name itself is compared.
    await duringReverification(
      `NEW.action_name = 'archive_client' AND NEW.error_message = 'CONFIRMATION_REQUIRED' AND NEW.input_payload->>'id' = '${client.id}'`,
      `UPDATE clients SET display_name = 'Someone Else Ltd' WHERE id = '${client.id}'`,
      async () => {
        const confirmed = result(await call(writeToken, MCP_CONFIRM_TOOL, { confirmation_id: prepared.body.confirmation_id }));
        assert.equal(confirmed.body.error, "CLIENT_CHANGED");
      },
    );
    const after = await prisma.client.findUniqueOrThrow({ where: { id: client.id } });
    assert.equal(after.isActive, true, "the renamed client was not archived");
    assert.equal(after.displayName, "Someone Else Ltd");
    assert.equal(result(await call(writeToken, MCP_CONFIRM_TOOL, { confirmation_id: prepared.body.confirmation_id })).body.error, "CLIENT_CHANGED", "a repeated yes gets the first answer");
    assert.equal(await prisma.auditLog.count({ where: { actionName: "archive_client", result: "success", inputPayload: { path: ["id"], equals: client.id } } }), 0);
  });

  it("does not archive a contact relinked to another client between the verified preview and the archive", async () => {
    const first = await prisma.client.create({ data: { companyId: TEST_COMPANY_ID, displayName: "Contact Owner A" } });
    const second = await prisma.client.create({ data: { companyId: TEST_COMPANY_ID, displayName: "Contact Owner B" } });
    const contact = await prisma.contact.create({ data: { companyId: TEST_COMPANY_ID, clientId: first.id, displayName: "Linked Person", email: "linked@test.local" } });
    const prepared = result(await call(writeToken, "archive_contact", { contact_id: contact.id }));
    assert.equal(prepared.body.preview.client.id, first.id);
    await duringReverification(
      `NEW.action_name = 'archive_contact' AND NEW.error_message = 'CONFIRMATION_REQUIRED' AND NEW.input_payload->>'id' = '${contact.id}'`,
      `UPDATE contacts SET client_id = '${second.id}' WHERE id = '${contact.id}'`,
      async () => {
        const confirmed = result(await call(writeToken, MCP_CONFIRM_TOOL, { confirmation_id: prepared.body.confirmation_id }));
        assert.equal(confirmed.body.error, "CONTACT_CHANGED");
      },
    );
    const after = await prisma.contact.findUniqueOrThrow({ where: { id: contact.id } });
    assert.equal(after.isActive, true);
    assert.equal(after.clientId, second.id);

    // The service compares the approved link by itself as well.
    const user = (await prisma.user.findUniqueOrThrow({ where: { email: "admin@test.local" } })) as unknown as AuthedUser;
    const stale = await archiveContact(user, contact.id, { confirmed: true, expected_client_id: first.id });
    assert.equal(!stale.ok && stale.error, "CONTACT_CHANGED");
    assert.equal((await prisma.contact.findUniqueOrThrow({ where: { id: contact.id } })).isActive, true);
  });

  it("does not run a confirmation when the emergency stop is switched on while it is being verified, and closes the review", async () => {
    const client = await prisma.client.create({ data: { companyId: TEST_COMPANY_ID, displayName: "Stopped Mid Confirm Ltd" } });
    const prepared = result(await call(writeToken, "archive_client", { client_id: client.id }));
    await duringReverification(
      `NEW.action_name = 'archive_client' AND NEW.error_message = 'CONFIRMATION_REQUIRED' AND NEW.input_payload->>'id' = '${client.id}'`,
      `UPDATE companies SET safe_mode_since = now() WHERE id = '${TEST_COMPANY_ID}'`,
      async () => {
        const res = await call(writeToken, MCP_CONFIRM_TOOL, { confirmation_id: prepared.body.confirmation_id });
        assert.equal(res.status, 423);
        assert.equal(res.body.error, "SAFE_MODE_ACTIVE");
      },
    );
    assert.equal((await prisma.client.findUniqueOrThrow({ where: { id: client.id } })).isActive, true, "nothing ran");
    assert.equal((await prisma.voicePendingAction.findUniqueOrThrow({ where: { id: prepared.body.confirmation_id } })).status, "failed", "the review is closed, not left executing");
    assert.equal(await prisma.idempotencyRecord.count({ where: { key: { endsWith: prepared.body.confirmation_id } } }), 0, "no unknown outcome is kept: nothing started");

    await prisma.company.update({ where: { id: TEST_COMPANY_ID }, data: { safeModeSince: null } });
    const later = result(await call(writeToken, MCP_CONFIRM_TOOL, { confirmation_id: prepared.body.confirmation_id }));
    assert.equal(later.body.error, "CONFIRMATION_ALREADY_USED", "after the stop the change must be prepared again");
    assert.equal((await prisma.client.findUniqueOrThrow({ where: { id: client.id } })).isActive, true);
  });

  it("serialises the owning service's stop check with the switch itself", async () => {
    const invoice = await draftInvoice("MCP-STOP-1", [{ description: "Fencing", unit_price: 300 }]);
    const user = (await prisma.user.findUniqueOrThrow({ where: { email: "admin@test.local" } })) as unknown as AuthedUser;
    // The administrator's switch, exactly as company/routes.ts takes it: the
    // stop lock, the company row FOR UPDATE, then the stop, committed a moment later.
    let release!: () => void;
    let locked!: () => void;
    const lockHeld = new Promise<void>((resolve) => { locked = resolve; });
    const switching = prisma.$transaction(async (tx) => {
      await lockSafeModeSwitch(tx, TEST_COMPANY_ID);
      await tx.$queryRawUnsafe(`SELECT "safe_mode_since" FROM "companies" WHERE "id" = '${TEST_COMPANY_ID}' FOR UPDATE`);
      await tx.company.update({ where: { id: TEST_COMPANY_ID }, data: { safeModeSince: new Date() } });
      locked();
      await new Promise<void>((resolve) => { release = resolve; });
    }, { timeout: 15_000 });
    await lockHeld;
    // Issued while the switch is in flight: it waits for the switch and then sees the stop.
    const issuing = changeInvoiceStatus(user, invoice.id, { invoice_status: "issued" }, { safeModeLocked: true });
    await new Promise((resolve) => setTimeout(resolve, 300));
    release();
    await switching;
    await assert.rejects(issuing, (error) => error instanceof SafeModeActiveError);
    assert.equal((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).invoiceStatus, "draft");
    await prisma.company.update({ where: { id: TEST_COMPANY_ID }, data: { safeModeSince: null } });
  });

  /** Waits until some database session is blocked on a lock (the write under test reached it). */
  async function untilBlockedOnLock() {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const rows = await prisma.$queryRawUnsafe<Array<{ waiting: bigint }>>(
        `SELECT count(*) AS waiting FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()`,
      );
      if (Number(rows[0].waiting) > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.fail("the write never reached the lock");
  }

  it("serialises a direct write with the emergency-stop switch", async () => {
    let release!: () => void;
    let locked!: () => void;
    const lockHeld = new Promise<void>((resolve) => { locked = resolve; });
    const switching = prisma.$transaction(async (tx) => {
      await lockSafeModeSwitch(tx, TEST_COMPANY_ID);
      await tx.$queryRawUnsafe(`SELECT "safe_mode_since" FROM "companies" WHERE "id" = '${TEST_COMPANY_ID}' FOR UPDATE`);
      await tx.company.update({ where: { id: TEST_COMPANY_ID }, data: { safeModeSince: new Date() } });
      locked();
      await new Promise<void>((resolve) => { release = resolve; });
    }, { timeout: 15_000 });
    await lockHeld;
    // Sent while the switch is in flight: the gateway still reads no stop, so
    // the write gets past it and waits on the company row the switch holds.
    const writing = call(writeToken, "create_client", { idempotency_key: key(), client: { display_name: "In Flight Ltd" } }).then((response) => response);
    await untilBlockedOnLock();
    release();
    await switching;
    const res = await writing;
    assert.equal(res.status, 423);
    assert.equal(await prisma.client.count({ where: { displayName: "In Flight Ltd" } }), 0, "nothing committed after the stop");
    assert.equal(await prisma.idempotencyRecord.count({ where: { key: { startsWith: "mcp:direct:" }, status: "in_progress" } }), 0, "nothing started, so no claim is kept");
    await prisma.company.update({ where: { id: TEST_COMPANY_ID }, data: { safeModeSince: null } });

    // Once the stop is lifted, writing works again.
    const created = result(await call(writeToken, "create_client", { idempotency_key: key(), client: { display_name: "After Stop Ltd" } }));
    assert.equal(created.isError, false);
  });

  it("lets no direct write commit after a stop, even when the write outlives its time limit", async () => {
    process.env.MCP_WRITE_TRANSACTION_MS = "1000";
    const client = await prisma.client.create({ data: { companyId: TEST_COMPANY_ID, displayName: "Blocked Row Ltd" } });
    // Another transaction holds the client's row, so the update waits past the gateway's time limit.
    let releaseRow!: () => void;
    let rowLocked!: () => void;
    const rowHeld = new Promise<void>((resolve) => { rowLocked = resolve; });
    const holder = prisma.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(`SELECT id FROM clients WHERE id = '${client.id}' FOR UPDATE`);
      rowLocked();
      await new Promise<void>((resolve) => { releaseRow = resolve; });
    }, { timeout: 20_000 });
    await rowHeld;
    const writing = call(writeToken, "update_client", { idempotency_key: key(), client_id: client.id, changes: { display_name: "Late Write Ltd" } }).then((response) => response);
    await untilBlockedOnLock();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    // The administrator switches the stop on after the time limit has passed.
    const switching = prisma.$transaction(async (tx) => {
      await lockSafeModeSwitch(tx, TEST_COMPANY_ID);
      await tx.$queryRawUnsafe(`SELECT "safe_mode_since" FROM "companies" WHERE "id" = '${TEST_COMPANY_ID}' FOR UPDATE`);
      await tx.company.update({ where: { id: TEST_COMPANY_ID }, data: { safeModeSince: new Date() } });
    }, { timeout: 20_000 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    releaseRow();
    await holder;
    await switching;
    const res = await writing;
    delete process.env.MCP_WRITE_TRANSACTION_MS;
    const after = await prisma.client.findUniqueOrThrow({ where: { id: client.id } });
    const stoppedAt = (await prisma.company.findUniqueOrThrow({ where: { id: TEST_COMPANY_ID } })).safeModeSince!;
    // The write's transaction ran out of time, so everything it did was rolled back with its lock.
    assert.equal(after.displayName, "Blocked Row Ltd", "nothing committed after the stop");
    assert.ok(stoppedAt, "the stop went through");
    assert.equal(result(res).body.error, "WRITE_FAILED");
    assert.equal(await prisma.auditLog.count({ where: { actionName: "update_client", result: "success", dataAfter: { path: ["displayName"], equals: "Late Write Ltd" } } }), 0);
    await prisma.company.update({ where: { id: TEST_COMPANY_ID }, data: { safeModeSince: null } });
  });

  it("cannot be held off by a stream of writes: the switch goes first, later writes wait for it", { timeout: 30_000 }, async () => {
    // A change already under way holds the stop lock shared.
    let releaseFirst!: () => void;
    let firstHeld!: () => void;
    const held = new Promise<void>((resolve) => { firstHeld = resolve; });
    const first = whileNotInSafeMode(TEST_COMPANY_ID, async () => {
      firstHeld();
      await new Promise<void>((resolve) => { releaseFirst = resolve; });
    });
    await held;

    // The administrator switches the stop on through the real route; it waits for that change.
    const login = await request(app).post("/auth/login").send({ email: "admin@test.local", password: "Password123!" });
    const order: string[] = [];
    const switching = request(app).put("/company/safe-mode").set("Authorization", `Bearer ${login.body.token}`)
      .send({ enabled: true, reason: "audit test" }).then((response) => { order.push("switch"); return response; });
    await untilBlockedOnLock();

    // A new write arrives while the switch waits. With the old row lock it went
    // ahead of the switch; now it queues behind it and then sees the stop.
    const before = await prisma.client.count();
    const late = call(writeToken, "create_client", { idempotency_key: key(), client: { display_name: "Queue Jumper Ltd" } })
      .then((response) => { order.push("write"); return response; });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(order, [], "both wait while the first change is under way");

    releaseFirst();
    await first;
    const switched = await switching;
    const refused = await late;
    assert.equal(switched.status, 200, JSON.stringify(switched.body));
    assert.equal(switched.body.enabled, true);
    // The later write ran only after the stop had committed: refused, nothing saved.
    // (Under the previous row lock it went first and its client was saved.)
    assert.equal(refused.status, 423);
    assert.equal(refused.body.error, "SAFE_MODE_ACTIVE");
    assert.equal(await prisma.client.count(), before, "the later write saved nothing");
    await prisma.company.update({ where: { id: TEST_COMPANY_ID }, data: { safeModeSince: null } });
  });

  it("keeps the gateway's idempotency records out of reach of Idempotency-Key headers", async () => {
    // An unknown outcome: the archive commits in its own transaction, then its audit entry fails.
    const client = await prisma.client.create({ data: { companyId: TEST_COMPANY_ID, displayName: "Namespace Archive Ltd" } });
    const prepared = result(await call(writeToken, "archive_client", { client_id: client.id }));
    await failAuditAfterWrite(`NEW.action_name = 'archive_client' AND NEW.result = 'success' AND NEW.input_payload->>'id' = '${client.id}'`, async () => {
      assert.equal(result(await call(writeToken, MCP_CONFIRM_TOOL, { confirmation_id: prepared.body.confirmation_id })).body.error, "OUTCOME_UNKNOWN");
    });
    const record = await prisma.idempotencyRecord.findFirstOrThrow({ where: { status: "unknown", key: { endsWith: prepared.body.confirmation_id } } });
    assert.ok(record.key.startsWith("mcp:confirm:"));
    // Past its retention, which the HTTP guard would treat as free.
    await prisma.idempotencyRecord.update({ where: { id: record.id }, data: { expiresAt: new Date(Date.now() - 1000) } });

    const login = await request(app).post("/auth/login").send({ email: "admin@test.local", password: "Password123!" });
    for (const header of [record.key, record.key.toUpperCase(), "mcp:anything", "Mcp:direct:x"]) {
      const ping = await request(app).post("/mcp").set("Authorization", `Bearer ${writeToken}`).set("Idempotency-Key", header)
        .send({ jsonrpc: "2.0", id: 9, method: "ping" });
      assert.equal(ping.status, 400, header);
      assert.equal(ping.body.error, "IDEMPOTENCY_KEY_RESERVED");
      const viaRest = await request(app).post("/crm/leads").set("Authorization", `Bearer ${login.body.token}`).set("Idempotency-Key", header).send({ name: "Via Rest" });
      assert.equal(viaRest.status, 400, header);
    }
    const kept = await prisma.idempotencyRecord.findUniqueOrThrow({ where: { id: record.id } });
    assert.equal(kept.status, "unknown", "the unknown claim survives");
    assert.equal(await prisma.lead.count({ where: { name: "Via Rest" } }), 0);

    // And the original confirmation still refuses to run again.
    const retry = result(await call(writeToken, MCP_CONFIRM_TOOL, { confirmation_id: prepared.body.confirmation_id }));
    assert.equal(retry.body.error, "OUTCOME_UNKNOWN");
    assert.equal(await prisma.auditLog.count({ where: { actionName: "mcp_write_tool", interpretedIntent: MCP_CONFIRM_TOOL, confirmed: true, inputPayload: { path: ["confirmationId"], equals: prepared.body.confirmation_id } } }), 0);
  });

  // ------------------------------------------------------------------------
  // The registry itself.

  it("reviews every tool whose contract needs confirmation, and every financial or irreversible one", () => {
    for (const tool of MCP_WRITE_TOOLS) {
      if (tool.contract.confirmationRequired) assert.equal(tool.kind, "reviewed", tool.name);
      if (tool.kind === "reviewed") assert.ok(tool.preview && tool.reviewReason, tool.name);
    }
    for (const name of ["archive_client", "archive_contact", "convert_lead", "change_invoice_status"]) {
      assert.equal(MCP_WRITE_TOOLS.find((tool) => tool.name === name)?.kind, "reviewed", name);
    }
    assert.equal(MCP_REVIEW.actionType, "mcp_write_review");
  });

  it("offers no tool that sends, publishes or deletes (but the guarded contact deletion), and no name twice", () => {
    const readNames = mcpTools().map((tool) => tool.name);
    const writeNames = MCP_WRITE_TOOLS.map((tool) => tool.name);
    assert.equal(new Set([...readNames, ...writeNames, MCP_CONFIRM_TOOL, MCP_CANCEL_TOOL]).size, readNames.length + writeNames.length + 2);
    // Issue #74: the WhatsApp sender review only classifies staged senders
    // (nothing is messaged), and the only deletion is the previewed,
    // name-typed delete_contact_permanently. Nothing sends, publishes, e-mails
    // or records a payment.
    const reviewed = new Set(["approve_whatsapp_sender", "reject_whatsapp_sender", "reopen_whatsapp_sender", "defer_whatsapp_sender", "delete_contact_permanently"]);
    for (const name of writeNames) {
      assert.doesNotMatch(name, /(^|_)send(_|$)|publish|email|payment/, name);
      if (!reviewed.has(name)) assert.doesNotMatch(name, /delete|whatsapp/, name);
    }
    const deletion = MCP_WRITE_TOOLS.find((tool) => tool.name === "delete_contact_permanently");
    assert.equal(deletion?.kind, "reviewed");
    assert.ok(deletion?.typedConfirmation, "permanent deletion needs the typed name");
  });
});
