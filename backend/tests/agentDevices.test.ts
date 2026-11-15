import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import http from "node:http";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import bcrypt from "bcryptjs";
import request from "supertest";
import { createServer } from "../src/server.js";
import { prisma } from "../src/db.js";
import { SPECIALISTS } from "../src/agents/specialists.js";
import { AGENT_TOOL_CATALOGUE } from "../src/agents/toolCatalogue.js";
import type { AuthedUser } from "../src/middleware/auth.js";
import { executeApprovedEmmaAction, previewEmmaActionForProposal } from "../src/services/emmaExecutableActionService.js";
import { resetDb, seedCompanyAndAdmin, TEST_COMPANY_ID } from "./setup.js";

// The owner's phone, PC and WhatsApp delivery status under Secretary's own
// assistant and agent: the executable actions the agent tool catalogue is
// generated from, through the same command endpoint, policy, previews, yes and
// emergency stop as every other action — against local fake services only.

const app = createServer();
const BRIDGE_TOKEN = "agent-bridge-admin-token-0123456789";
const RELAY_TOKEN = "agent-relay-client-token-0123456789";
const ENV_KEYS = ["SMS_BRIDGE_URL", "SMS_BRIDGE_ADMIN_TOKEN", "SMS_BRIDGE_COMPANY_ID", "SMS_BRIDGE_DEVICE_ID", "PCP_RELAY_URL", "PCP_CLIENT_TOKEN", "PCP_COMPANY_ID",
  "WHATSAPP_GRAPH_API_VERSION", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_BUSINESS_ACCOUNT_ID", "WHATSAPP_ACCESS_TOKEN", "WHATSAPP_WEBHOOK_VERIFY_TOKEN", "META_APP_SECRET",
  "OPENAI_API_KEY"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((name) => [name, process.env[name]]));

type Json = Record<string, any>;
interface Seen { method: string; path: string; headers: http.IncomingHttpHeaders; body: any }

function fakeService() {
  const seen: Seen[] = [];
  const handlers = new Map<string, (req: Seen, res: http.ServerResponse) => void>();
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://fake");
      const entry: Seen = { method: req.method ?? "", path: url.pathname, headers: req.headers, body: raw ? JSON.parse(raw) : null };
      seen.push(entry);
      const handler = handlers.get(`${entry.method} ${entry.path}`) ?? [...handlers.entries()].find(([key]) => key.endsWith("*") && `${entry.method} ${entry.path}`.startsWith(key.slice(0, -1)))?.[1];
      if (!handler) return void res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ detail: "no fake handler" }));
      handler(entry, res);
    });
  });
  const json = (res: http.ServerResponse, status: number, body: unknown) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
  return {
    seen, handlers, json,
    async start() {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    },
    stop: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

describe("agent and assistant: the owner's phone, PC and WhatsApp delivery status", () => {
  const bridge = fakeService();
  const relay = fakeService();
  /** The bridge's own idempotency: request_id -> message. */
  const bridgeMessages = new Map<string, { id: string; status: string }>();
  let admin: string;
  let worker: string;
  let other: string;
  /** A second administrator of the same company: same permissions, another person. */
  let colleague: string;
  let adminUser: AuthedUser;

  const login = async (email: string) => (await request(app).post("/auth/login").send({ email, password: "Password123!" })).body.token as string;
  const say = (token: string, text: string) => request(app).post("/command/assistant").set("Authorization", `Bearer ${token}`).send({ text, input_method: "voice_transcript", language: "en-GB", history: [] });
  const action = (token: string, name: string, parameters: Json = {}) => say(token, `voice action ${name} ${JSON.stringify(parameters)}`);
  const posts = (service: ReturnType<typeof fakeService>, path: string) => service.seen.filter((entry) => entry.method === "POST" && entry.path === path);
  const audits = (actionName: string) => prisma.auditLog.findMany({ where: { companyId: TEST_COMPANY_ID, actionName }, orderBy: { createdAt: "asc" } });

  before(async () => {
    await resetDb();
    await seedCompanyAndAdmin();
    const hash = await bcrypt.hash("Password123!", 10);
    const company = await prisma.company.create({ data: { name: "Other Agent Co" } });
    await prisma.user.create({ data: { companyId: company.id, email: "other-agent@test.local", passwordHash: hash, displayName: "Other", role: "administrator",
      permissions: ["company.manage", "connectors.read", "connectors.manage", "crm.read", "crm.manage", "voice.execute"] } });
    await prisma.user.create({ data: { companyId: TEST_COMPANY_ID, email: "colleague@test.local", passwordHash: hash, displayName: "Colleague", role: "administrator",
      permissions: ["company.manage", "connectors.read", "connectors.manage", "crm.read", "crm.manage", "voice.execute"] } });
    for (const name of ENV_KEYS) delete process.env[name];
    Object.assign(process.env, {
      SMS_BRIDGE_URL: await bridge.start(), SMS_BRIDGE_ADMIN_TOKEN: BRIDGE_TOKEN, SMS_BRIDGE_COMPANY_ID: TEST_COMPANY_ID,
      PCP_RELAY_URL: await relay.start(), PCP_CLIENT_TOKEN: RELAY_TOKEN, PCP_COMPANY_ID: TEST_COMPANY_ID,
    });
    admin = await login("admin@test.local");
    worker = await login("worker@test.local");
    other = await login("other-agent@test.local");
    colleague = await login("colleague@test.local");
    const row = await prisma.user.findFirstOrThrow({ where: { email: "admin@test.local" } });
    adminUser = { id: row.id, companyId: row.companyId, role: row.role, permissions: row.permissions, voiceLanguage: "en-GB", mustChangePassword: false } as unknown as AuthedUser;
  });

  beforeEach(async () => {
    bridge.seen.length = 0;
    relay.seen.length = 0;
    bridge.handlers.clear();
    relay.handlers.clear();
    await prisma.voicePendingAction.deleteMany({});
    const { json } = bridge;
    bridge.handlers.set("GET /api/dashboard/status", (_req, res) => json(res, 200, { gateway_online: true, gateway_last_seen: 1767225600, device_id: "samsung-s938b" }));
    bridge.handlers.set("GET /api/phone/health", (_req, res) => json(res, 200, { battery: 81 }));
    bridge.handlers.set("GET /api/chat/messages", (_req, res) => json(res, 200, {
      device_id: "samsung-s938b", next_cursor: null, listener: { enabled: true, reported_at: 1767225600 },
      messages: [{ key: "k1aaaaaaa", channel: "whatsapp", chat: "Jana Nováková", sender: "Jana Nováková", text: "Kdy přijedete?", ts: 1767225600000, direction: "in", is_group: false }],
    }));
    bridge.handlers.set("POST /api/send", (req, res) => {
      const known = bridgeMessages.get(req.body.request_id);
      if (known) return json(res, 202, { created: false, message: known });
      const message = { id: `sms-${bridgeMessages.size + 1}`, status: "queued" };
      bridgeMessages.set(req.body.request_id, message);
      json(res, 202, { created: true, message });
    });
    bridge.handlers.set("GET /api/messages/*", (req, res) => json(res, 200, { id: req.path.split("/").pop(), status: "sent", updated_at: 1767225700 }));
    bridge.handlers.set("POST /api/chat/reply", (_req, res) => json(res, 202, { id: "act-1", created: true }));
    relay.handlers.set("POST /v1/call", (req, res) => relay.json(res, 200, { id: "job-1", ok: true, data: { tool: req.body.tool } }));
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

  it("gives the agent the same contracts: reads at once, sends and PC steps only as reviewed proposals", () => {
    const byName = new Map(AGENT_TOOL_CATALOGUE.map((tool) => [tool.name, tool]));
    for (const name of ["phone_status", "list_phone_sms", "list_phone_chats", "phone_message_status", "whatsapp_message_status", "list_pc_tools", "read_pc"]) {
      assert.equal(byName.get(name as never)?.kind, "read", name);
    }
    for (const [name, capability] of [["send_phone_sms", "action.send_phone_sms"], ["reply_phone_chat", "action.reply_phone_chat"], ["operate_pc", "action.operate_pc"]] as const) {
      const tool = byName.get(name)!;
      assert.notEqual(tool.kind, "read", name);
      assert.equal(tool.confirmation, "service_preview", name);
      assert.equal(tool.capabilityId, capability, name);
    }
    for (const name of ["send_phone_sms", "reply_phone_chat", "phone_message_status", "whatsapp_message_status"]) {
      assert.ok((SPECIALISTS.communication.tools as readonly string[]).includes(name), `the communication specialist plans with ${name}`);
    }
  });

  it("reads the phone and the PC at once, with the server-side tokens, and lists the PC tools with what is not offered", async () => {
    const status = await action(admin, "phone_status");
    assert.equal(status.status, 200, JSON.stringify(status.body));
    assert.equal(bridge.seen[0].headers["x-admin-token"], BRIDGE_TOKEN);
    assert.ok(!JSON.stringify(status.body).includes(BRIDGE_TOKEN));

    const tools = await action(admin, "list_pc_tools");
    assert.equal(tools.status, 200, JSON.stringify(tools.body));
    const data = tools.body.data as Json;
    assert.match(data.rule, /never from screenshots/);
    const steps = (data.steps as Json[]).map((entry) => entry.tool);
    for (const name of ["pc_browser_act", "pc_delete_file", "pc_run_approved_script", "pc_write_file"]) assert.ok(steps.includes(name), name);
    const notOffered = new Map((data.not_offered as Json[]).map((entry) => [entry.name, entry.reason]));
    assert.match(notOffered.get("pc_run_command") ?? "", /Owner-local, pending review/);
    assert.match(notOffered.get("pc_screenshot") ?? "", /never controls the PC from images/);

    const read = await action(admin, "read_pc", { tool: "pc_ui_windows" });
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.equal(posts(relay, "/v1/call")[0].body.tool, "engine_ui_windows");
    assert.equal(posts(relay, "/v1/call")[0].headers.authorization, `Bearer ${RELAY_TOKEN}`);
    const shell = await action(admin, "read_pc", { tool: "pc_run_command", arguments: { command: "whoami" } });
    assert.equal(shell.body.error, "VALIDATION_FAILED");
    const step = await action(admin, "operate_pc", { tool: "pc_run_command", arguments: { command: "whoami" } });
    assert.equal(step.body.error, "VALIDATION_FAILED");
    assert.equal(posts(relay, "/v1/call").length, 1, "nothing that is not offered reaches the PC");
  });

  it("sends an SMS only after the yes, once, with the request id shown in the preview, and audits it without the text", async () => {
    const prepared = await action(admin, "send_phone_sms", { to: "+447700900401", text: "We arrive at nine." });
    assert.equal(prepared.status, 409, JSON.stringify(prepared.body));
    assert.equal(prepared.body.error, "CONFIRMATION_REQUIRED");
    const requestId = prepared.body.details?.preview?.request_id ?? prepared.body.data?.preview?.request_id ?? JSON.stringify(prepared.body).match(/vcubf-[0-9a-f-]+/)?.[0];
    assert.match(String(requestId), /^vcubf-10000000-[0-9a-f-]{36}$/);
    assert.equal(posts(bridge, "/api/send").length, 0, "the preview sends nothing");

    const yes = await say(admin, "yes");
    assert.equal(yes.status, 202, JSON.stringify(yes.body));
    assert.equal(yes.body.ok, true, "queued on the phone");
    const sends = posts(bridge, "/api/send");
    assert.equal(sends.length, 1);
    assert.equal(sends[0].body.request_id, requestId);
    assert.equal(sends[0].body.recipient, "+447700900401");
    const again = await say(admin, "yes");
    assert.ok(again.status >= 400, "a second yes has nothing to confirm");
    assert.equal(posts(bridge, "/api/send").length, 1, "and sends nothing more");

    const audit = await audits("send_phone_sms");
    assert.equal(audit.at(-1)?.result, "success");
    assert.ok(!JSON.stringify(audit).includes("We arrive at nine"), "the text is not in the audit log");
    const status = await action(admin, "phone_message_status", { request_id: requestId });
    assert.equal(status.body.data?.status, "sent", JSON.stringify(status.body));
  });

  it("keeps an unanswered send unknown, never resends it by itself, and settles it with the same request id", async () => {
    bridge.handlers.set("POST /api/send", (_req, res) => res.socket?.destroy());
    const prepared = await action(admin, "send_phone_sms", { to: "+447700900402", text: "Unknown outcome" });
    const requestId = JSON.stringify(prepared.body).match(/vcubf-[0-9a-f-]{8}-[0-9a-f-]{36}/)![0];
    const yes = await say(admin, "yes");
    assert.equal(yes.body.error, "OUTCOME_UNKNOWN", JSON.stringify(yes.body));
    assert.equal(posts(bridge, "/api/send").length, 1);
    const status = await action(admin, "phone_message_status", { request_id: requestId });
    assert.equal(status.body.data?.status, "unknown");

    const invented = await action(admin, "send_phone_sms", { to: "+447700900402", text: "Unknown outcome", reuse_request_id: "vcubf-10000000-00000000-0000-0000-0000-000000000000" });
    assert.equal(invented.body.error, "NOT_RESUBMITTABLE", "only a request id Secretary recorded as unknown can be reused");

    bridgeMessages.set(requestId, { id: "sms-arrived", status: "queued" });
    bridge.handlers.set("POST /api/send", (req, res) => {
      const known = bridgeMessages.get(req.body.request_id);
      bridge.json(res, 202, known ? { created: false, message: known } : { created: true, message: { id: "sms-new", status: "queued" } });
    });
    const settle = await action(admin, "send_phone_sms", { to: "+447700900402", text: "Unknown outcome", reuse_request_id: requestId });
    assert.equal(settle.body.error, "CONFIRMATION_REQUIRED", JSON.stringify(settle.body));
    assert.match(JSON.stringify(settle.body), /nothing new is sent/);
    const settled = await say(admin, "yes");
    assert.equal(settled.status, 202, JSON.stringify(settled.body));
    assert.equal(posts(bridge, "/api/send").at(-1)?.body.request_id, requestId);
    assert.equal(settled.body.data?.created ?? false, false, "the bridge already had it: nothing new was sent");
    const known = await action(admin, "phone_message_status", { request_id: requestId });
    assert.equal(known.body.data?.status, "sent");
  });

  it("sends nothing and changes nothing on the PC during the emergency stop, but still reads", async () => {
    const prepared = await action(admin, "send_phone_sms", { to: "+447700900403", text: "Stopped" });
    assert.equal(prepared.body.error, "CONFIRMATION_REQUIRED");
    const step = await previewEmmaActionForProposal(adminUser, { action: "operate_pc", parameters: { tool: "pc_browser_open", arguments: { url: "https://example.org/" } } });
    assert.equal(step.result.ok ? "ok" : step.result.error, "CONFIRMATION_REQUIRED");
    await prisma.company.update({ where: { id: TEST_COMPANY_ID }, data: { safeModeSince: new Date() } });
    const yes = await say(admin, "yes");
    assert.notEqual(yes.status, 200);
    assert.equal(posts(bridge, "/api/send").length, 0, "nothing reached the phone");
    const ran = await executeApprovedEmmaAction(adminUser, step.reviewed, true);
    assert.equal(ran.ok ? "ok" : ran.error, "SAFE_MODE_ACTIVE");
    assert.equal(posts(relay, "/v1/call").length, 0, "nothing reached the PC");
    const read = await action(admin, "phone_status");
    assert.equal(read.status, 200, "reading goes on during the stop");
  });

  it("runs an agent's PC step through its proposal: previewed, carried out once with the yes, an unanswered PC kept unknown", async () => {
    const { result, reviewed } = await previewEmmaActionForProposal(adminUser, { action: "operate_pc", parameters: { tool: "pc_delete_file", arguments: { path: "C:\\Users\\Owner\\old.txt" } } });
    assert.equal(result.ok ? "ok" : result.error, "CONFIRMATION_REQUIRED");
    assert.match(JSON.stringify(result), /backup copy/);
    assert.equal(posts(relay, "/v1/call").length, 0);
    const done = await executeApprovedEmmaAction(adminUser, reviewed, true);
    assert.equal(done.ok, true, JSON.stringify(done));
    assert.equal(posts(relay, "/v1/call")[0].body.tool, "delete_file");

    relay.handlers.set("POST /v1/call", (_req, res) => relay.json(res, 504, { detail: "Agent timeout" }));
    const slow = await previewEmmaActionForProposal(adminUser, { action: "operate_pc", parameters: { tool: "pc_run_approved_script", arguments: { name: "daily-report.ps1" } } });
    const unknown = await executeApprovedEmmaAction(adminUser, slow.reviewed, true);
    assert.equal(unknown.ok ? "ok" : unknown.error, "OUTCOME_UNKNOWN");
    assert.equal(posts(relay, "/v1/call").length, 2, "an unknown PC step is not repeated");
    const audit = await audits("operate_pc");
    assert.deepEqual(audit.slice(-2).map((entry) => entry.errorMessage), [null, "OUTCOME_UNKNOWN"]);
  });

  it("holds the company binding, the permission and the administrator's switch", async () => {
    const elsewhere = await action(other, "phone_status");
    assert.equal(elsewhere.body.error, "CONNECTOR_NOT_CONFIGURED", JSON.stringify(elsewhere.body));
    const elsewherePc = await action(other, "read_pc", { tool: "pc_ui_windows" });
    assert.equal(elsewherePc.body.error, "CONNECTOR_NOT_CONFIGURED");
    const noPermission = await action(worker, "send_phone_sms", { to: "+447700900404", text: "x" });
    assert.notEqual(noPermission.status, 200);
    assert.notEqual(noPermission.body.error, "CONFIRMATION_REQUIRED", "a person without connectors.manage gets no preview");
    await prisma.company.update({ where: { id: TEST_COMPANY_ID }, data: { emmaDisabledCapabilities: ["action.send_phone_sms"] } });
    const switchedOff = await action(admin, "send_phone_sms", { to: "+447700900404", text: "x" });
    assert.notEqual(switchedOff.body.error, "CONFIRMATION_REQUIRED", JSON.stringify(switchedOff.body));
    assert.equal(posts(bridge, "/api/send").length, 0);
    assert.equal(bridge.seen.length, 0, "the other company and the refused calls reached nothing");
    assert.equal(relay.seen.length, 0);
  });

  it("keeps each person's sends to themselves: a colleague can neither read nor settle them", async () => {
    const prepared = await action(admin, "send_phone_sms", { to: "+447700900410", text: "Mine" });
    const requestId = JSON.stringify(prepared.body).match(/vcubf-[0-9a-f-]{8}-[0-9a-f-]{36}/)![0];
    assert.equal((await say(admin, "yes")).status, 202);
    const theirs = await action(colleague, "phone_message_status", { request_id: requestId });
    assert.equal(theirs.body.data?.status, "not_sent", "a colleague learns nothing about another person's send");
    assert.equal((await action(admin, "phone_message_status", { request_id: requestId })).body.data?.status, "sent");

    bridge.handlers.set("POST /api/send", (_req, res) => res.socket?.destroy());
    const unknown = await action(admin, "send_phone_sms", { to: "+447700900411", text: "Unknown, mine" });
    const unknownId = JSON.stringify(unknown.body).match(/vcubf-[0-9a-f-]{8}-[0-9a-f-]{36}/)![0];
    assert.equal((await say(admin, "yes")).body.error, "OUTCOME_UNKNOWN");
    const settle = await action(colleague, "send_phone_sms", { to: "+447700900411", text: "Unknown, mine", reuse_request_id: unknownId });
    assert.equal(settle.body.error, "NOT_RESUBMITTABLE", "a colleague cannot settle another person's unknown send");
    // The colleague's own yes cannot confirm the owner's waiting review either.
    const waiting = await action(admin, "send_phone_sms", { to: "+447700900412", text: "Waiting for my yes" });
    assert.equal(waiting.body.error, "CONFIRMATION_REQUIRED");
    const before = posts(bridge, "/api/send").length;
    assert.ok((await say(colleague, "yes")).status >= 400);
    assert.equal(posts(bridge, "/api/send").length, before, "another person's yes sends nothing");
  });

  it("sends once when the same yes arrives twice at the same moment", async () => {
    await action(admin, "send_phone_sms", { to: "+447700900420", text: "Simultaneous" });
    const answers = await Promise.all([say(admin, "yes"), say(admin, "yes")]);
    assert.deepEqual(answers.map((answer) => answer.status >= 400).sort(), [false, true], JSON.stringify(answers.map((answer) => answer.body)));
    assert.equal(posts(bridge, "/api/send").length, 1, "exactly one request reached the phone");
  });

  it("creates one message when the same approved agent step runs twice at once, and when an unknown send is settled twice at once", async () => {
    const { reviewed } = await previewEmmaActionForProposal(adminUser, { action: "send_phone_sms", parameters: { to: "+447700900430", text: "Agent step" } });
    const requestId = String(reviewed.parameters.request_id);
    const before = bridgeMessages.size;
    const [first, second] = await Promise.all([executeApprovedEmmaAction(adminUser, reviewed, true), executeApprovedEmmaAction(adminUser, reviewed, true)]);
    assert.equal(first.ok && second.ok, true);
    assert.equal(bridgeMessages.size, before + 1, "the bridge holds one message for the one request id");
    assert.ok(posts(bridge, "/api/send").every((entry) => entry.body.request_id === requestId));
    assert.equal((first as { data: { remote_id: string } }).data.remote_id, (second as { data: { remote_id: string } }).data.remote_id);

    bridge.handlers.set("POST /api/send", (_req, res) => res.socket?.destroy());
    const { reviewed: lost } = await previewEmmaActionForProposal(adminUser, { action: "send_phone_sms", parameters: { to: "+447700900431", text: "Lost" } });
    const lostRun = await executeApprovedEmmaAction(adminUser, lost, true);
    assert.equal(lostRun.ok ? "ok" : lostRun.error, "OUTCOME_UNKNOWN");
    const lostId = String(lost.parameters.request_id);
    bridge.handlers.set("POST /api/send", (req, res) => {
      const known = bridgeMessages.get(req.body.request_id);
      if (known) return bridge.json(res, 202, { created: false, message: known });
      const message = { id: `sms-${bridgeMessages.size + 1}`, status: "queued" };
      bridgeMessages.set(req.body.request_id, message);
      bridge.json(res, 202, { created: true, message });
    });
    const settleA = await previewEmmaActionForProposal(adminUser, { action: "send_phone_sms", parameters: { to: "+447700900431", text: "Lost", reuse_request_id: lostId } });
    const settleB = await previewEmmaActionForProposal(adminUser, { action: "send_phone_sms", parameters: { to: "+447700900431", text: "Lost", reuse_request_id: lostId } });
    assert.equal(settleA.reviewed.parameters.request_id, lostId);
    const sizeBefore = bridgeMessages.size;
    const settled = await Promise.all([executeApprovedEmmaAction(adminUser, settleA.reviewed, true), executeApprovedEmmaAction(adminUser, settleB.reviewed, true)]);
    assert.ok(settled.every((entry) => entry.ok), JSON.stringify(settled));
    assert.equal(bridgeMessages.size, sizeBefore + 1, "two settlements at once still make one message");
    const status = await action(admin, "phone_message_status", { request_id: lostId });
    assert.equal(status.body.data?.status, "sent");
  });

  it("records WhatsApp Business delivery statuses from the verified webhook, only forward, and reads them back", async () => {
    Object.assign(process.env, { WHATSAPP_GRAPH_API_VERSION: "v21.0", WHATSAPP_PHONE_NUMBER_ID: "123456789", WHATSAPP_BUSINESS_ACCOUNT_ID: "987654321",
      WHATSAPP_ACCESS_TOKEN: "test-placeholder-token", WHATSAPP_WEBHOOK_VERIFY_TOKEN: "test-verify", META_APP_SECRET: "test-app-secret" });
    const source = await prisma.connectorSource.create({ data: { companyId: TEST_COMPANY_ID, connectorKey: "whatsapp_business", displayName: "Business number",
      serviceType: "messaging", configuredScopes: ["read:messages", "send:messages"], isEnabled: true, connectionStatus: "connected" } });
    const webhook = (status: string, at: number, errors?: Json[], messageId = "wamid.OUT42") => {
      const raw = JSON.stringify({ object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: {
        metadata: { phone_number_id: "123456789" }, statuses: [{ id: messageId, status, recipient_id: "447700900405", timestamp: String(at), ...(errors ? { errors } : {}) }],
      } }] }] });
      return request(app).post("/connectors/whatsapp/webhook").set("Content-Type", "application/json")
        .set("X-Hub-Signature-256", "sha256=" + createHmac("sha256", "test-app-secret").update(raw).digest("hex")).send(raw);
    };
    try {
      const none = await action(admin, "whatsapp_message_status", { message_id: "wamid.OUT42" });
      assert.equal(none.body.data?.status, "not_reported", JSON.stringify(none.body));
      assert.equal((await webhook("delivered", 1767225700)).status, 200);
      assert.equal((await webhook("sent", 1767225600)).status, 200, "a late 'sent' arrives after 'delivered'");
      const delivered = await action(admin, "whatsapp_message_status", { message_id: "wamid.OUT42" });
      assert.equal(delivered.body.data?.status, "delivered", "a state is never moved back");
      await webhook("read", 1767225800);
      assert.equal((await action(admin, "whatsapp_message_status", { message_id: "wamid.OUT42" })).body.data?.status, "read");
      // Real DB interleaving: hold the older delivered INSERT before it takes
      // the conflict row, allowing the later read event to commit first.
      await webhook("sent", 1767225600, undefined, "wamid.RACE42");
      await prisma.$executeRawUnsafe(`CREATE FUNCTION test_delay_delivery() RETURNS trigger AS $$
        BEGIN IF NEW.message_id = 'wamid.RACE42' AND NEW.status = 'delivered' THEN
          PERFORM pg_sleep(1); END IF; RETURN NEW; END; $$ LANGUAGE plpgsql`);
      await prisma.$executeRawUnsafe(`CREATE TRIGGER test_delay_delivery BEFORE INSERT ON whatsapp_message_statuses
        FOR EACH ROW EXECUTE FUNCTION test_delay_delivery()`);
      try {
        const answers = await Promise.all([
          webhook("delivered", 1767225700, undefined, "wamid.RACE42"),
          webhook("read", 1767225800, undefined, "wamid.RACE42"),
        ]);
        for (const answer of answers) assert.equal(answer.status, 200, JSON.stringify(answer.body));
        assert.equal((await action(admin, "whatsapp_message_status", { message_id: "wamid.RACE42" })).body.data?.status,
          "read", "concurrent delayed delivered event cannot overwrite a committed read event");
      } finally {
        await prisma.$executeRawUnsafe("DROP TRIGGER test_delay_delivery ON whatsapp_message_statuses");
        await prisma.$executeRawUnsafe("DROP FUNCTION test_delay_delivery()");
      }
      const unsigned = await request(app).post("/connectors/whatsapp/webhook").set("Content-Type", "application/json").send("{}");
      assert.notEqual(unsigned.status, 200, "an unsigned webhook records nothing");
      const elsewhere = await action(other, "whatsapp_message_status", { message_id: "wamid.OUT42" });
      assert.equal(elsewhere.body.data?.status ?? elsewhere.body.error, "not_reported", "another company never sees this company's status");
    } finally {
      await prisma.whatsAppMessageStatus.deleteMany({});
      await prisma.connectorSource.delete({ where: { id: source.id } });
    }
  });
});
