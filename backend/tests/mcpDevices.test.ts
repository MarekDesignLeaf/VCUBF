import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import bcrypt from "bcryptjs";
import request from "supertest";
import { createServer } from "../src/server.js";
import { prisma } from "../src/db.js";
import { MCP_READ_SCOPE, MCP_WRITE_SCOPE } from "../src/modules/mcp/oauth.js";
import { MCP_CONFIRM_TOOL } from "../src/modules/mcp/writeTools.js";
import { bridgeRequestId } from "../src/services/smsBridgeService.js";
import { resetDb, seedCompanyAndAdmin, TEST_COMPANY_ID } from "./setup.js";

// The owner's phone (SMS Bridge) and PC (PC Control Plus relay) through the
// Secretary MCP gateway. Both systems are replaced by local HTTP servers that
// record every request, so each assertion about what was or was not sent is a
// fact about the wire. No real phone, PC or message is involved.

const app = createServer();
const BASE = "https://secretary.test";
const RESOURCE = `${BASE}/mcp`;
const REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect";
const BOTH = `${MCP_READ_SCOPE} ${MCP_WRITE_SCOPE}`;
const BRIDGE_TOKEN = "test-bridge-admin-token-0123456789";
const RELAY_TOKEN = "test-relay-client-token-0123456789";
const ENV_KEYS = ["MCP_GATEWAY_ENABLED", "MCP_WRITE_ENABLED", "MCP_PUBLIC_URL", "SMS_BRIDGE_URL", "SMS_BRIDGE_ADMIN_TOKEN",
  "SMS_BRIDGE_COMPANY_ID", "SMS_BRIDGE_DEVICE_ID", "PCP_RELAY_URL", "PCP_CLIENT_TOKEN", "PCP_COMPANY_ID"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((name) => [name, process.env[name]]));

type Json = Record<string, any>;
interface Seen { method: string; path: string; query: URLSearchParams; headers: http.IncomingHttpHeaders; body: any }

/** A fake HTTP service: a handler per "METHOD /path", a log of every request. */
function fakeService() {
  const seen: Seen[] = [];
  const handlers = new Map<string, (req: Seen, res: http.ServerResponse) => void>();
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://fake");
      const entry: Seen = { method: req.method ?? "", path: url.pathname, query: url.searchParams, headers: req.headers, body: raw ? JSON.parse(raw) : null };
      seen.push(entry);
      const handler = handlers.get(`${entry.method} ${entry.path}`) ?? [...handlers.entries()].find(([key]) => key.endsWith("*") && `${entry.method} ${entry.path}`.startsWith(key.slice(0, -1)))?.[1];
      if (!handler) {
        res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ detail: "no fake handler" }));
        return;
      }
      handler(entry, res);
    });
  });
  const json = (res: http.ServerResponse, status: number, body: unknown) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
  return {
    seen, handlers, json, server,
    async start() {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    },
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

describe("MCP: the owner's phone (SMS Bridge) and PC (PC Control Plus)", () => {
  const bridge = fakeService();
  const relay = fakeService();
  let writeToken: string;
  let readToken: string;
  let workerToken: string;
  let otherToken: string;
  let otherCompanyId: string;
  /** The bridge's own idempotency: request_id -> message. */
  const bridgeMessages = new Map<string, { id: string; status: string }>();

  const register = async () => (await request(app).post("/oauth/register").send({ client_name: "ChatGPT", redirect_uris: [REDIRECT] })).body.client_id as string;
  async function connect(email: string, decision = "approve_write") {
    const clientId = await register();
    const { verifier, challenge } = pkce();
    const consent = await request(app).post("/oauth/authorize").type("form").send({
      client_id: clientId, redirect_uri: REDIRECT, response_type: "code", code_challenge: challenge, code_challenge_method: "S256",
      state: "s-1", scope: BOTH, resource: RESOURCE, email, password: "Password123!", decision, ...(decision === "approve_write" ? { allow_write: "yes" } : {}),
    });
    assert.equal(consent.status, 302, consent.text);
    const code = new URL(consent.headers.location).searchParams.get("code")!;
    const token = await request(app).post("/oauth/token").type("form")
      .send({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier, resource: RESOURCE });
    assert.equal(token.status, 200, JSON.stringify(token.body));
    return token.body.access_token as string;
  }
  const rpc = (token: string, body: Json) => request(app).post("/mcp").set("Authorization", `Bearer ${token}`).send(body);
  const call = (token: string, name: string, args: unknown) => rpc(token, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  const result = (res: request.Response) => {
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.result, JSON.stringify(res.body));
    return { isError: res.body.result.isError as boolean, body: JSON.parse(res.body.result.content[0].text) as Json };
  };
  const describeTools = async (token: string) => result(await call(token, "describe_capabilities", {})).body.tools as Json[];
  const posts = (service: ReturnType<typeof fakeService>, path: string) => service.seen.filter((entry) => entry.method === "POST" && entry.path === path);

  before(async () => {
    const bridgeUrl = await bridge.start();
    const relayUrl = await relay.start();
    await resetDb();
    await seedCompanyAndAdmin();
    const hash = await bcrypt.hash("Password123!", 10);
    const other = await prisma.company.create({ data: { name: "Other Device Co" } });
    otherCompanyId = other.id;
    await prisma.user.create({ data: { companyId: other.id, email: "other-owner@test.local", passwordHash: hash, displayName: "Other Owner", role: "administrator",
      permissions: ["company.manage", "connectors.read", "connectors.manage", "crm.read", "crm.manage"] } });
    Object.assign(process.env, {
      MCP_GATEWAY_ENABLED: "true", MCP_WRITE_ENABLED: "true", MCP_PUBLIC_URL: BASE,
      SMS_BRIDGE_URL: bridgeUrl, SMS_BRIDGE_ADMIN_TOKEN: BRIDGE_TOKEN, SMS_BRIDGE_COMPANY_ID: TEST_COMPANY_ID, SMS_BRIDGE_DEVICE_ID: "samsung-s938b",
      PCP_RELAY_URL: relayUrl, PCP_CLIENT_TOKEN: RELAY_TOKEN, PCP_COMPANY_ID: TEST_COMPANY_ID,
    });
    writeToken = await connect("admin@test.local");
    readToken = await connect("admin@test.local", "approve");
    workerToken = await connect("worker@test.local");
    otherToken = await connect("other-owner@test.local");
  });

  beforeEach(() => {
    bridge.seen.length = 0;
    relay.seen.length = 0;
    bridge.handlers.clear();
    relay.handlers.clear();
    const { json } = bridge;
    bridge.handlers.set("GET /api/dashboard/status", (_req, res) => json(res, 200, { gateway_online: true, gateway_last_seen: 1767225600, message_counts: { sent: 3 }, synced_sms_count: 12, queued_device_actions: 0, device_id: "samsung-s938b" }));
    bridge.handlers.set("GET /api/phone/health", (_req, res) => json(res, 200, { battery: 81 }));
    bridge.handlers.set("GET /api/chat/messages", (_req, res) => json(res, 200, {
      device_id: "samsung-s938b", next_cursor: null, listener: { enabled: true, reported_at: 1767225600 },
      messages: [
        { key: "k1aaaaaaa", channel: "whatsapp", chat: "Jana Nováková", sender: "Jana Nováková", text: "Kdy přijedete?", ts: 1767225600, direction: "in", is_group: false },
        { key: "k2aaaaaaa", channel: "messenger", chat: "Petr", sender: "Petr", text: "Ahoj", ts: 1767225500, direction: "in", is_group: false },
      ],
    }));
    bridge.handlers.set("GET /api/phone/messages", (_req, res) => json(res, 200, {
      device_id: "samsung-s938b", total: 1, offset: 0, has_more: false, next_cursor: null, last_upload_at: 1767225600,
      messages: [{ device_sms_id: 501, address: "+447700900123", body: "Can you come on Monday?", received_at: 1767225600, message_type: 1, thread_id: 7 }],
    }));
    bridge.handlers.set("POST /api/send", (req, res) => {
      const known = bridgeMessages.get(req.body.request_id);
      if (known) return json(res, 202, { created: false, message: known });
      const message = { id: `sms-${bridgeMessages.size + 1}`, status: "queued" };
      bridgeMessages.set(req.body.request_id, message);
      json(res, 202, { created: true, message });
    });
    bridge.handlers.set("GET /api/messages/*", (req, res) => {
      const id = req.path.split("/").pop();
      const message = [...bridgeMessages.values()].find((entry) => entry.id === id);
      return message ? json(res, 200, { ...message, status: "sent", updated_at: 1767225700 }) : json(res, 404, { detail: "SMS not found" });
    });
    bridge.handlers.set("POST /api/chat/reply", (_req, res) => json(res, 202, { id: "act-1", created: true }));
    bridge.handlers.set("GET /api/chat/reply/act-1", (_req, res) => json(res, 200, { id: "act-1", status: "completed", result: "", updated_at: 1767225700 }));
    relay.handlers.set("POST /v1/call", (req, res) => relay.json(res, 200, { id: "job-1", ok: true, data: { tool: req.body.tool, echoed: req.body.args } }));
  });

  afterEach(async () => {
    await prisma.company.update({ where: { id: TEST_COMPANY_ID }, data: { safeModeSince: null, emmaDisabledCapabilities: [] } });
  });

  after(async () => {
    for (const name of ENV_KEYS) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    await bridge.stop();
    await relay.stop();
    await prisma.$disconnect();
  });

  async function prepareAndConfirm(token: string, tool: string, args: Json) {
    const prepared = result(await call(token, tool, args));
    assert.equal(prepared.isError, false, JSON.stringify(prepared.body));
    assert.equal(prepared.body.status, "confirmation_required");
    const confirmed = result(await call(token, MCP_CONFIRM_TOOL, { confirmation_id: prepared.body.confirmation_id }));
    return { prepared, confirmed, confirmationId: prepared.body.confirmation_id as string };
  }

  // ─── Company isolation and availability ─────────────────────────────────────

  it("serves only the configured company: another company sees the tools as not set up and reaches nothing", async () => {
    const tools = await describeTools(otherToken);
    for (const name of ["phone_status", "list_phone_sms", "send_phone_sms", "reply_phone_chat", "pc_browser_act", "pc_ui_windows"]) {
      const tool = tools.find((entry) => entry.name === name)!;
      assert.equal(tool.availability.reason, "connector_not_configured", name);
      assert.equal(tool.availability.listed, false, name);
    }
    const read = result(await call(otherToken, "list_phone_sms", {}));
    assert.equal(read.body.error, "CONNECTOR_NOT_CONFIGURED");
    const send = result(await call(otherToken, "send_phone_sms", { to: "+447700900123", text: "hello" }));
    assert.equal(send.isError, true);
    assert.equal(bridge.seen.length, 0, "nothing reached the phone");
    assert.equal(relay.seen.length, 0, "nothing reached the PC");
    assert.ok(otherCompanyId);
  });

  it("lists the phone and PC tools for the configured company, by scope and permission", async () => {
    const owner = await describeTools(writeToken);
    for (const name of ["phone_status", "list_phone_sms", "list_phone_chat_messages", "get_outbound_message_status", "send_phone_sms", "reply_phone_chat",
      "resubmit_phone_message", "pc_connection_status", "pc_browser_snapshot", "pc_web_fetch", "pc_ui_snapshot", "pc_browser_open", "pc_browser_act", "pc_ui_act"]) {
      assert.equal(owner.find((entry) => entry.name === name)?.availability.reason, "available", name);
    }
    assert.ok(!owner.some((entry) => entry.name === "pc_browser_eval"), "arbitrary JavaScript is not offered");
    const send = owner.find((entry) => entry.name === "send_phone_sms")!;
    assert.equal(send.confirmation, "preview_then_confirm");
    assert.equal(send.destructive, true);
    assert.ok(send.limitations.some((line: string) => /outside the company/.test(line)), "declared as contacting someone outside");
    const chat = owner.find((entry) => entry.name === "list_phone_chat_messages")!;
    assert.match(chat.purpose, /No earlier history/);

    const reader = await describeTools(readToken);
    assert.equal(reader.find((entry) => entry.name === "list_phone_sms")?.availability.reason, "available");
    assert.equal(reader.find((entry) => entry.name === "send_phone_sms")?.availability.reason, "requires_write_scope");
    const worker = await describeTools(workerToken);
    assert.equal(worker.find((entry) => entry.name === "send_phone_sms")?.availability.reason, "missing_permission");
    assert.equal(worker.find((entry) => entry.name === "pc_browser_act")?.availability.reason, "missing_permission");
    assert.equal(result(await call(workerToken, "list_phone_sms", {})).body.error, "MISSING_PERMISSION");
  });

  // ─── Reading ───────────────────────────────────────────────────────────────

  it("reads phone status, synchronised SMS and notification chats with the server-side token", async () => {
    const status = result(await call(readToken, "phone_status", {}));
    assert.equal(status.isError, false, JSON.stringify(status.body));
    assert.equal(status.body.data.phone_online, true);
    assert.equal(status.body.data.notification_listener.enabled, true);
    const sms = result(await call(readToken, "list_phone_sms", { address: "+447700900123", direction: "in", limit: 5 }));
    assert.deepEqual(sms.body.data.messages[0], { device_sms_id: 501, address: "+447700900123", text: "Can you come on Monday?", at: "2026-01-01T00:00:00.000Z", kind: "received", thread_id: 7 });
    const smsRequest = bridge.seen.find((entry) => entry.path === "/api/phone/messages")!;
    assert.equal(smsRequest.headers["x-admin-token"], BRIDGE_TOKEN);
    assert.equal(smsRequest.query.get("message_type"), "1");
    assert.equal(smsRequest.query.get("device_id"), "samsung-s938b");
    const chats = result(await call(readToken, "list_phone_chat_messages", { channel: "whatsapp" }));
    assert.deepEqual(chats.body.data.messages.map((message: Json) => message.chat), ["Jana Nováková"]);
    assert.match(chats.body.data.limitation, /No earlier history/);
    assert.ok(!JSON.stringify([status.body, sms.body, chats.body]).includes(BRIDGE_TOKEN), "the token never reaches the client");
  });

  // ─── Sending an SMS: preview, yes, one bridge request ──────────────────────

  it("sends an SMS only after the yes, once, with a request id bound to the confirmation", async () => {
    const prepared = result(await call(writeToken, "send_phone_sms", { to: "+447700900123", text: "Přijedeme v pondělí v 9:00." }));
    assert.equal(prepared.body.status, "confirmation_required");
    assert.equal(prepared.body.preview.to, "+447700900123");
    assert.equal(prepared.body.preview.text, "Přijedeme v pondělí v 9:00.");
    assert.equal(prepared.body.preview.sms_parts, 1);
    assert.equal(posts(bridge, "/api/send").length, 0, "the preview sends nothing");

    const confirmationId = prepared.body.confirmation_id as string;
    const confirmed = result(await call(writeToken, MCP_CONFIRM_TOOL, { confirmation_id: confirmationId }));
    assert.equal(confirmed.isError, false, JSON.stringify(confirmed.body));
    assert.equal(confirmed.body.data.remote_id, "sms-1");
    const sends = posts(bridge, "/api/send");
    assert.equal(sends.length, 1);
    assert.equal(sends[0].body.request_id, bridgeRequestId(TEST_COMPANY_ID, confirmationId));
    assert.equal(sends[0].body.recipient, "+447700900123");
    assert.equal(sends[0].body.device_id, "samsung-s938b");

    const again = result(await call(writeToken, MCP_CONFIRM_TOOL, { confirmation_id: confirmationId }));
    assert.equal(again.body.replayed, true, "a repeated yes gets the first answer");
    assert.equal(posts(bridge, "/api/send").length, 1, "and sends nothing more");

    const status = result(await call(writeToken, "get_outbound_message_status", { confirmation_id: confirmationId }));
    assert.ok(status.body.data, JSON.stringify(status.body));
    assert.equal(status.body.data.status, "sent");
    assert.equal(status.body.data.remote_id, "sms-1");

    const audit = await prisma.auditLog.findMany({ where: { companyId: TEST_COMPANY_ID, actionName: "mcp_write_tool", interpretedIntent: { in: ["send_phone_sms", MCP_CONFIRM_TOOL] } } });
    assert.ok(audit.length >= 2);
    assert.ok(!JSON.stringify(audit).includes("Přijedeme"), "the message text is not in the audit log");
  });

  it("refuses invalid numbers and over-long texts before any preview", async () => {
    for (const args of [{ to: "07700900123", text: "x" }, { to: "+447700900123", text: "x".repeat(501) }, { to: "+447700900123", text: "" }]) {
      const res = result(await call(writeToken, "send_phone_sms", args));
      assert.equal(res.isError, true, JSON.stringify(args));
      assert.equal(res.body.error, "VALIDATION_FAILED");
    }
    assert.equal(bridge.seen.length, 0);
  });

  it("keeps an unknown outcome unknown, never resends by itself, and resolves it with the same request id", async () => {
    // The bridge receives the request and the connection drops before any answer.
    bridge.handlers.set("POST /api/send", (req, res) => {
      bridgeMessages.set(req.body.request_id, { id: "sms-lost", status: "queued" });
      res.socket?.destroy();
    });
    const { confirmed, confirmationId } = await prepareAndConfirm(writeToken, "send_phone_sms", { to: "+447700900124", text: "Lost answer" });
    assert.equal(confirmed.isError, true);
    assert.equal(confirmed.body.error, "OUTCOME_UNKNOWN");
    assert.equal(posts(bridge, "/api/send").length, 1);

    const retried = result(await call(writeToken, MCP_CONFIRM_TOOL, { confirmation_id: confirmationId }));
    assert.equal(retried.body.error, "OUTCOME_UNKNOWN");
    assert.equal(posts(bridge, "/api/send").length, 1, "the unknown send is not repeated");

    const status = result(await call(writeToken, "get_outbound_message_status", { confirmation_id: confirmationId }));
    assert.equal(status.body.data.status, "unknown");
    assert.equal(status.body.data.request_id, bridgeRequestId(TEST_COMPANY_ID, confirmationId));
    assert.equal(posts(bridge, "/api/send").length, 1, "checking the status never sends");

    // The owner decides to resolve it: the bridge already has the message, so nothing new is sent.
    bridge.handlers.set("POST /api/send", (req, res) => {
      const known = bridgeMessages.get(req.body.request_id);
      bridge.json(res, 202, known ? { created: false, message: known } : { created: true, message: { id: "sms-new", status: "queued" } });
    });
    const resolved = await prepareAndConfirm(writeToken, "resubmit_phone_message", { confirmation_id: confirmationId });
    assert.equal(resolved.prepared.body.preview.to, "+447700900124");
    assert.equal(resolved.confirmed.isError, false, JSON.stringify(resolved.confirmed.body));
    assert.equal(resolved.confirmed.body.data.already_known_to_bridge, true);
    const resend = posts(bridge, "/api/send");
    assert.equal(resend.length, 2);
    assert.equal(resend[1].body.request_id, resend[0].body.request_id, "the same request id: the bridge cannot send twice");

    const afterwards = result(await call(writeToken, "get_outbound_message_status", { confirmation_id: confirmationId }));
    assert.equal(afterwards.body.data.remote_id, "sms-lost");
    // A send the bridge has is not resubmitted again.
    const refused = result(await call(writeToken, "resubmit_phone_message", { confirmation_id: confirmationId }));
    assert.equal(refused.body.error, "OUTCOME_KNOWN");
  });

  it("reports a bridge that cannot be reached as nothing sent, not as unknown", async () => {
    const url = process.env.SMS_BRIDGE_URL;
    // A port that was just free and is closed again: the connection is refused.
    const probe = http.createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
    const closedPort = (probe.address() as { port: number }).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    process.env.SMS_BRIDGE_URL = `http://127.0.0.1:${closedPort}`;
    try {
      const { confirmed } = await prepareAndConfirm(writeToken, "send_phone_sms", { to: "+447700900125", text: "Bridge down" });
      assert.equal(confirmed.isError, true);
      assert.equal(confirmed.body.error, "PROVIDER_UNAVAILABLE");
      assert.match(confirmed.body.message, /Nothing was sent/);
    } finally {
      process.env.SMS_BRIDGE_URL = url;
    }
  });

  it("sends nothing during the emergency stop", async () => {
    const prepared = result(await call(writeToken, "send_phone_sms", { to: "+447700900126", text: "Stopped" }));
    await prisma.company.update({ where: { id: TEST_COMPANY_ID }, data: { safeModeSince: new Date() } });
    const res = await call(writeToken, MCP_CONFIRM_TOOL, { confirmation_id: prepared.body.confirmation_id });
    assert.equal(res.status, 423);
    assert.equal(posts(bridge, "/api/send").length, 0);
  });

  // ─── Notification replies ─────────────────────────────────────────────────

  it("replies only in a chat the phone has a notification of, after the yes", async () => {
    const unknownChat = result(await call(writeToken, "reply_phone_chat", { channel: "whatsapp", chat: "Nobody", text: "Hi" }));
    assert.equal(unknownChat.body.error, "PHONE_CHAT_NOT_FOUND");
    const { prepared, confirmed, confirmationId } = await prepareAndConfirm(writeToken, "reply_phone_chat", { channel: "whatsapp", chat: "Jana Nováková", text: "V pondělí v 9." });
    assert.match(prepared.body.preview.route, /notification's reply action/);
    assert.equal(confirmed.isError, false, JSON.stringify(confirmed.body));
    const replies = posts(bridge, "/api/chat/reply");
    assert.equal(replies.length, 1);
    assert.deepEqual({ ...replies[0].body, request_id: undefined }, { channel: "whatsapp", chat: "Jana Nováková", text: "V pondělí v 9.", device_id: "samsung-s938b", request_id: undefined });
    assert.equal(replies[0].body.request_id, bridgeRequestId(TEST_COMPANY_ID, confirmationId));
    const status = result(await call(writeToken, "get_outbound_message_status", { confirmation_id: confirmationId }));
    assert.equal(status.body.data.status, "completed");
  });

  // ─── The PC ───────────────────────────────────────────────────────────────

  it("reads the PC through catalogue tools only, with the relay token", async () => {
    const windows = result(await call(readToken, "pc_ui_windows", {}));
    assert.equal(windows.isError, false, JSON.stringify(windows.body));
    const [job] = posts(relay, "/v1/call");
    assert.equal(job.body.tool, "engine_ui_windows");
    assert.equal(job.headers.authorization, `Bearer ${RELAY_TOKEN}`);
    const status = result(await call(readToken, "pc_connection_status", {}));
    assert.equal(status.isError, false);
    assert.equal(posts(relay, "/v1/call")[1].body.tool, "browser_connection_status");
    const bad = result(await call(readToken, "pc_ui_snapshot", { window: "x", command: "rm -rf" }));
    assert.equal(bad.body.error, "VALIDATION_FAILED");
    assert.equal(posts(relay, "/v1/call").length, 2, "an unknown argument never reaches the PC");
  });

  it("runs a PC step only after the yes, and keeps a PC that did not answer as unknown", async () => {
    const steps = [{ fill: "e3", value: "Jana" }, { click: "e7" }];
    const prepared = result(await call(writeToken, "pc_browser_act", { steps }));
    assert.equal(prepared.body.preview.pc_tool, "browser_act");
    assert.deepEqual(prepared.body.preview.arguments.steps, steps);
    assert.equal(posts(relay, "/v1/call").length, 0, "the preview runs nothing on the PC");
    const confirmed = result(await call(writeToken, MCP_CONFIRM_TOOL, { confirmation_id: prepared.body.confirmation_id }));
    assert.equal(confirmed.isError, false, JSON.stringify(confirmed.body));
    assert.equal(posts(relay, "/v1/call")[0].body.tool, "engine_browser_act");

    relay.handlers.set("POST /v1/call", (_req, res) => relay.json(res, 504, { detail: "Agent timeout" }));
    const timedOut = await prepareAndConfirm(writeToken, "pc_ui_act", { steps: [{ click: "u9" }], window: "Uložit jako" });
    assert.equal(timedOut.confirmed.body.error, "OUTCOME_UNKNOWN");
    const again = result(await call(writeToken, MCP_CONFIRM_TOOL, { confirmation_id: timedOut.confirmationId }));
    assert.equal(again.body.error, "OUTCOME_UNKNOWN");
    assert.equal(posts(relay, "/v1/call").length, 2, "an unknown PC step is never repeated");

    relay.handlers.set("POST /v1/call", (_req, res) => relay.json(res, 200, { id: "job", ok: false, error: "Denied or approval timed out" }));
    const denied = await prepareAndConfirm(writeToken, "pc_browser_open", { url: "https://example.org/" });
    assert.equal(denied.confirmed.body.error, "PC_OWNER_DENIED");
  });
});
