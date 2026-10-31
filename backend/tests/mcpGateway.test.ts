import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import request from "supertest";
import { createServer } from "../src/server.js";
import { prisma } from "../src/db.js";
import { isReadCommand } from "../src/agents/agentProposal.js";
import { AGENT_TOOL_CATALOGUE } from "../src/agents/toolCatalogue.js";
import { CANONICAL_COMMAND, parseTextCommand } from "../src/lib/commandParser.js";
import { EMMA_EXECUTABLE_ACTIONS } from "../src/lib/emmaExecutableActionCatalogue.js";
import { MCP_READ_COMMAND_TOOL, mcpTools, readCommandForms } from "../src/modules/mcp/routes.js";
import { resetDb, seedCompanyAndAdmin, TEST_COMPANY_ID } from "./setup.js";

// Read-only MCP gateway — voice assistant master document 1.1a, step P2a.

const app = createServer();
const originalFlag = process.env.MCP_GATEWAY_ENABLED;

type Rpc = { jsonrpc: "2.0"; id?: number | string; method: string; params?: unknown };

describe("MCP gateway (read only)", () => {
  let adminToken: string;
  let workerToken: string;
  const login = async (email: string) => (await request(app).post("/auth/login").send({ email, password: "Password123!" })).body.token as string;
  const rpc = (token: string, body: Rpc | unknown) =>
    request(app).post("/mcp").set("Authorization", `Bearer ${token}`).set("Accept", "application/json, text/event-stream").send(body as object);
  const call = (token: string, name: string, args: unknown, id = 7) =>
    rpc(token, { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

  before(async () => {
    await resetDb();
    await seedCompanyAndAdmin();
    adminToken = await login("admin@test.local");
    workerToken = await login("worker@test.local");
  });

  beforeEach(() => { process.env.MCP_GATEWAY_ENABLED = "true"; });

  afterEach(async () => {
    if (originalFlag === undefined) delete process.env.MCP_GATEWAY_ENABLED;
    else process.env.MCP_GATEWAY_ENABLED = originalFlag;
    await prisma.company.update({ where: { id: TEST_COMPANY_ID }, data: { safeModeSince: null } });
  });

  after(async () => { await prisma.$disconnect(); });

  it("does not exist while switched off, even for a signed-in user", async () => {
    delete process.env.MCP_GATEWAY_ENABLED;
    const res = await rpc(adminToken, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    assert.equal(res.status, 404);
  });

  it("needs a signed-in user", async () => {
    const res = await request(app).post("/mcp").send({ jsonrpc: "2.0", id: 1, method: "initialize" });
    assert.equal(res.status, 401);
  });

  it("initializes with a negotiated protocol version and only the tools capability", async () => {
    const known = await rpc(adminToken, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
    assert.equal(known.status, 200, JSON.stringify(known.body));
    assert.equal(known.body.id, 1);
    assert.equal(known.body.result.protocolVersion, "2025-03-26");
    assert.deepEqual(known.body.result.capabilities, { tools: { listChanged: false } });
    assert.equal(known.body.result.serverInfo.name, "vcubf-secretary");

    const unknown = await rpc(adminToken, { jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } });
    assert.equal(unknown.body.result.protocolVersion, "2025-06-18");
  });

  it("accepts notifications without an answer and answers ping", async () => {
    const note = await rpc(adminToken, { jsonrpc: "2.0", method: "notifications/initialized" });
    assert.equal(note.status, 202);
    const ping = await rpc(adminToken, { jsonrpc: "2.0", id: "p", method: "ping" });
    assert.deepEqual(ping.body, { jsonrpc: "2.0", id: "p", result: {} });
  });

  it("lists only tools that read and need no confirmation", async () => {
    const res = await rpc(adminToken, { jsonrpc: "2.0", id: 3, method: "tools/list" });
    assert.equal(res.status, 200);
    const tools = res.body.result.tools as Array<{ name: string; inputSchema: { type: string }; annotations: Record<string, boolean> }>;
    const expected = AGENT_TOOL_CATALOGUE.filter((tool) => tool.kind === "read" && EMMA_EXECUTABLE_ACTIONS[tool.name].confirmation === "none");
    assert.ok(expected.length > 0);
    assert.deepEqual(tools.map((tool) => tool.name).sort(), [MCP_READ_COMMAND_TOOL, ...expected.map((tool) => tool.name)].sort());
    for (const tool of tools) {
      assert.equal(tool.inputSchema.type, "object", tool.name);
      assert.equal(tool.annotations.readOnlyHint, true, tool.name);
      assert.equal(tool.annotations.destructiveHint, false, tool.name);
    }
    // Nothing that writes is offered.
    for (const tool of AGENT_TOOL_CATALOGUE.filter((entry) => entry.kind !== "read")) {
      assert.ok(!tools.some((offered) => offered.name === tool.name), `${tool.name} must not be offered`);
    }
    assert.deepEqual(mcpTools().map((tool) => tool.name).sort(), tools.map((tool) => tool.name).sort());
  });

  it("describes only commands the parser classifies as reads", () => {
    const forms = readCommandForms();
    assert.ok(forms.includes("list clients"), "list clients is a read");
    assert.ok(!forms.some((form) => form.startsWith("create client")), "create client is not a read");
    for (const form of forms) {
      const sample = form.replace(/\[[^\]]*\]/g, "").replace(/\b[A-Z][A-Z0-9]*(?:\s+[A-Z][A-Z0-9]*)*\b/g, "sample").replace(/\s+/g, " ").trim();
      assert.ok(isReadCommand(parseTextCommand(sample, CANONICAL_COMMAND).intent), form);
    }
  });

  it("runs a reading command and audits it without its text", async () => {
    const res = await call(adminToken, MCP_READ_COMMAND_TOOL, { canonical_command: "list clients" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.result.isError, false, JSON.stringify(res.body));
    assert.equal(res.body.result.content[0].type, "text");
    assert.equal(JSON.parse(res.body.result.content[0].text).ok, true);

    const audit = await prisma.auditLog.findFirst({ where: { actionName: "mcp_read_tool" }, orderBy: { createdAt: "desc" } });
    assert.ok(audit, "the call is audited");
    assert.equal(audit.interpretedIntent, "list_clients");
    assert.equal(audit.result, "success");
    const payload = audit.inputPayload as { tool: string; argumentsFingerprint: string };
    assert.equal(payload.tool, MCP_READ_COMMAND_TOOL);
    assert.match(payload.argumentsFingerprint, /^[0-9a-f]{64}$/);
    assert.equal(JSON.stringify(audit).includes("list clients"), false, "the command text is never stored");
  });

  it("refuses a command that would change something, and changes nothing", async () => {
    const before = await prisma.client.count();
    const res = await call(adminToken, MCP_READ_COMMAND_TOOL, { canonical_command: "create client Gateway Test Ltd, email gateway@test.local, phone +447700900123" });
    assert.equal(res.status, 200);
    assert.equal(res.body.result.isError, true);
    assert.equal(JSON.parse(res.body.result.content[0].text).error, "READ_ONLY_GATEWAY");
    assert.equal(await prisma.client.count(), before);
  });

  it("refuses an unrecognized command and malformed arguments", async () => {
    const unknown = await call(adminToken, MCP_READ_COMMAND_TOOL, { canonical_command: "make me a sandwich" });
    assert.equal(unknown.body.result.isError, true);
    assert.equal(JSON.parse(unknown.body.result.content[0].text).error, "UNRECOGNIZED_COMMAND");
    const malformed = await call(adminToken, MCP_READ_COMMAND_TOOL, { command: "list clients" });
    assert.equal(malformed.body.result.isError, true);
    assert.equal(JSON.parse(malformed.body.result.content[0].text).error, "VALIDATION_FAILED");
  });

  it("keeps the caller's permissions", async () => {
    const res = await call(workerToken, MCP_READ_COMMAND_TOOL, { canonical_command: "list clients" });
    assert.equal(res.status, 200);
    assert.equal(res.body.result.isError, true);
    assert.equal(JSON.parse(res.body.result.content[0].text).error, "NOT_ALLOWED");
  });

  it("does not run a tool it does not offer", async () => {
    const write = AGENT_TOOL_CATALOGUE.find((tool) => tool.kind !== "read");
    assert.ok(write);
    const res = await call(adminToken, write.name, {});
    assert.equal(res.body.error.code, -32602);
    const missing = await rpc(adminToken, { jsonrpc: "2.0", id: 9, method: "resources/list" });
    assert.equal(missing.body.error.code, -32601);
  });

  it("rejects batches and malformed messages", async () => {
    const batch = await rpc(adminToken, [{ jsonrpc: "2.0", id: 1, method: "ping" }]);
    assert.equal(batch.status, 400);
    assert.equal(batch.body.error.code, -32600);
    const bad = await rpc(adminToken, { id: 1, method: "ping" });
    assert.equal(bad.status, 400);
  });

  it("opens no stream", async () => {
    const res = await request(app).get("/mcp").set("Authorization", `Bearer ${adminToken}`);
    assert.equal(res.status, 405);
    assert.equal(res.headers.allow, "POST");
  });

  it("is closed during an emergency stop", async () => {
    await prisma.company.update({ where: { id: TEST_COMPANY_ID }, data: { safeModeSince: new Date() } });
    const res = await call(adminToken, MCP_READ_COMMAND_TOOL, { canonical_command: "list clients" });
    assert.equal(res.status, 423);
  });
});
