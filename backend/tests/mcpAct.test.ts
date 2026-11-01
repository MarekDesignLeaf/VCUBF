import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import request from "supertest";
import { createServer } from "../src/server.js";
import { prisma } from "../src/db.js";
import { AGENT_NEVER_PROPOSES } from "../src/agents/agentProposal.js";
import { AGENT_TOOL_CATALOGUE } from "../src/agents/toolCatalogue.js";
import { MCP_CANCEL_TOOL, MCP_CONFIRM_TOOL } from "../src/modules/mcp/routes.js";
import { resetDb, seedCompanyAndAdmin, TEST_COMPANY_ID } from "./setup.js";

// Acting through the MCP gateway — voice assistant master document 1.1a, step P3a.

const app = createServer();
const BASE = "https://secretary.test";
const REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect";
const saved = { gateway: process.env.MCP_GATEWAY_ENABLED, write: process.env.MCP_WRITE_ENABLED, url: process.env.MCP_PUBLIC_URL };

type ToolResult = { content: Array<{ text: string }>; isError: boolean };

describe("MCP gateway acting (P3a)", () => {
  let ownerToken: string;
  let rpcId = 0;

  const rpc = (token: string, method: string, params?: unknown) =>
    request(app).post("/mcp").set("Authorization", `Bearer ${token}`).send({ jsonrpc: "2.0", id: ++rpcId, method, params });
  const call = async (token: string, name: string, args: unknown) => {
    const res = await rpc(token, "tools/call", { name, arguments: args });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body as { result?: ToolResult; error?: { code: number } };
  };
  const payload = (result: ToolResult | undefined) => JSON.parse(result!.content[0].text);
  const toolNames = async (token: string) => ((await rpc(token, "tools/list")).body.result.tools as Array<{ name: string }>).map((tool) => tool.name);

  async function oauthToken(scope?: string) {
    const client = (await request(app).post("/oauth/register").send({ client_name: "ChatGPT", redirect_uris: [REDIRECT] })).body.client_id as string;
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const approved = await request(app).post("/oauth/authorize").type("form").send({
      client_id: client, redirect_uri: REDIRECT, response_type: "code", code_challenge: challenge, code_challenge_method: "S256",
      state: "s", ...(scope ? { scope } : {}), email: "admin@test.local", password: "Password123!", decision: "approve",
    });
    assert.equal(approved.status, 302, approved.text);
    const code = new URL(approved.headers.location).searchParams.get("code")!;
    const token = await request(app).post("/oauth/token").type("form")
      .send({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: client, code_verifier: verifier });
    assert.equal(token.status, 200, JSON.stringify(token.body));
    return token.body as { access_token: string; scope: string };
  }

  before(async () => {
    await resetDb();
    await seedCompanyAndAdmin();
    ownerToken = (await request(app).post("/auth/login").send({ email: "admin@test.local", password: "Password123!" })).body.token;
  });

  beforeEach(() => {
    process.env.MCP_GATEWAY_ENABLED = "true";
    process.env.MCP_WRITE_ENABLED = "true";
    process.env.MCP_PUBLIC_URL = BASE;
  });

  afterEach(() => {
    for (const [key, value] of [["MCP_GATEWAY_ENABLED", saved.gateway], ["MCP_WRITE_ENABLED", saved.write], ["MCP_PUBLIC_URL", saved.url]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  after(async () => { await prisma.$disconnect(); });

  it("offers nothing that changes data while acting is switched off", async () => {
    delete process.env.MCP_WRITE_ENABLED;
    const names = await toolNames(ownerToken);
    assert.ok(!names.includes("send_email") && !names.includes(MCP_CONFIRM_TOOL));
    const refused = await call(ownerToken, "set_task_status", { task_title: "x", task_status: "completed" });
    assert.equal(refused.error?.code, -32602);
    const metadata = await request(app).get("/.well-known/oauth-protected-resource/mcp");
    assert.deepEqual(metadata.body.scopes_supported, ["secretary.read"]);
  });

  it("offers the tools the agent may propose, and never administration or connector settings", async () => {
    const names = await toolNames(ownerToken);
    for (const name of ["send_email", "reply_whatsapp", "create_calendar_event", "set_task_status", "merge_clients", MCP_CONFIRM_TOOL, MCP_CANCEL_TOOL]) {
      assert.ok(names.includes(name), `${name} is offered`);
    }
    for (const tool of AGENT_TOOL_CATALOGUE.filter((entry) => entry.kind === "administration" || AGENT_NEVER_PROPOSES.has(entry.name))) {
      assert.ok(!names.includes(tool.name), `${tool.name} must never be offered`);
    }
  });

  it("acts only for a connection approved with secretary.act", async () => {
    const readOnly = await oauthToken("secretary.read");
    assert.equal(readOnly.scope, "secretary.read");
    assert.ok(!(await toolNames(readOnly.access_token)).includes("send_email"));

    const acting = await oauthToken();
    assert.equal(acting.scope, "secretary.read secretary.act");
    assert.ok((await toolNames(acting.access_token)).includes("send_email"));

    // A connection approved for acting stops acting the moment the switch goes off.
    delete process.env.MCP_WRITE_ENABLED;
    assert.ok(!(await toolNames(acting.access_token)).includes("send_email"));
  });

  it("carries out an action without a preview straight away, as Secretary's voice does", async () => {
    await prisma.task.create({ data: { companyId: TEST_COMPANY_ID, title: "Call Petra" } });
    const done = await call(ownerToken, "set_task_status", { task_title: "Call Petra", task_status: "completed" });
    assert.equal(done.result?.isError, false, JSON.stringify(done.result));
    const task = await prisma.task.findFirst({ where: { companyId: TEST_COMPANY_ID, title: "Call Petra" } });
    assert.equal(task?.taskStatus, "completed");
    const audit = await prisma.auditLog.findFirst({ where: { actionName: "mcp_write_tool" }, orderBy: { createdAt: "desc" } });
    assert.equal(audit?.interpretedIntent, "set_task_status");
    assert.equal(JSON.stringify(audit).includes("Call Petra"), false, "the arguments are never stored");
  });

  describe("an action with a preview", () => {
    let pair = 0;
    async function clients() {
      pair += 1;
      const primary = `Act Primary ${pair}`;
      const duplicate = `Act Duplicate ${pair}`;
      for (const name of [primary, duplicate]) {
        const created = await request(app).post("/crm/clients").set("Authorization", `Bearer ${ownerToken}`).send({ display_name: name });
        assert.equal(created.status, 201, JSON.stringify(created.body));
      }
      return { primary_client_name: primary, duplicate_client_name: duplicate };
    }
    const mergeConfirmed = () => prisma.auditLog.count({ where: { actionName: "merge_clients", confirmed: true } });

    it("changes nothing until confirm_action names its review", async () => {
      const before = await mergeConfirmed();
      const names = await clients();
      const smuggled = await call(ownerToken, "merge_clients", { ...names, confirmed: true });
      assert.equal(smuggled.result?.isError, true, "a confirmed flag in the arguments is refused, never a way past the preview");
      assert.equal(await mergeConfirmed(), before);

      const prepared = await call(ownerToken, "merge_clients", names);
      const preview = payload(prepared.result);
      assert.equal(prepared.result?.isError, false, JSON.stringify(preview));
      assert.equal(preview.status, "awaiting_confirmation");
      assert.match(preview.review_id, /^[0-9a-f-]{36}$/);
      assert.equal(await mergeConfirmed(), before, "the preview changes nothing");

      const confirmed = await call(ownerToken, MCP_CONFIRM_TOOL, { review_id: preview.review_id });
      assert.equal(confirmed.result?.isError, false, JSON.stringify(payload(confirmed.result)));
      assert.equal(await mergeConfirmed(), before + 1);

      const again = await call(ownerToken, MCP_CONFIRM_TOOL, { review_id: preview.review_id });
      assert.equal(again.result?.isError, true);
      assert.equal(payload(again.result).error, "NO_PENDING_ACTION");
    });

    it("confirms only the review it names, never a newer one", async () => {
      const before = await mergeConfirmed();
      const first = payload((await call(ownerToken, "merge_clients", await clients())).result);
      const second = payload((await call(ownerToken, "merge_clients", await clients())).result);
      // Preparing the second replaced the first: its id no longer approves anything.
      const stale = await call(ownerToken, MCP_CONFIRM_TOOL, { review_id: first.review_id });
      assert.equal(stale.result?.isError, true);
      assert.equal(await mergeConfirmed(), before);
      const cancelled = await call(ownerToken, MCP_CANCEL_TOOL, { review_id: second.review_id });
      assert.equal(cancelled.result?.isError, false);
      const afterCancel = await call(ownerToken, MCP_CONFIRM_TOOL, { review_id: second.review_id });
      assert.equal(afterCancel.result?.isError, true);
      assert.equal(await mergeConfirmed(), before);
    });

    it("refuses a malformed review id", async () => {
      const res = await call(ownerToken, MCP_CONFIRM_TOOL, { review_id: "not-a-review" });
      assert.equal(res.result?.isError, true);
      assert.equal(payload(res.result).error, "VALIDATION_FAILED");
    });
  });
});
