import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import request from "supertest";
import { createServer } from "../src/server.js";
import { prisma } from "../src/db.js";
import {
  AGENT_RUN_BUDGET,
  compareWithParser,
  observeShadow,
  settleShadowRuns,
  type ProposedTool,
} from "../src/agents/shadowAgent.js";
import { AGENT_TOOL_CATALOGUE } from "../src/agents/toolCatalogue.js";
import { resetDb, seedCompanyAndAdmin } from "./setup.js";

const app = createServer();

type Call = { name: string; arguments: string };
let modelOutput: Call[] = [];
let modelStatus = 200;
let modelRequests: Array<Record<string, unknown>> = [];
let otherRequests: string[] = [];

const originalFetch = globalThis.fetch;
const originalKey = process.env.OPENAI_API_KEY;
const originalRate = process.env.AGENT_SHADOW_SAMPLE_RATE;

function installModel() {
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    if (url.hostname !== "api.openai.com") {
      otherRequests.push(url.toString());
      return originalFetch(input, init);
    }
    modelRequests.push(JSON.parse(String(init?.body)));
    if (modelStatus !== 200) return new Response("unavailable", { status: modelStatus });
    return Response.json({
      output: modelOutput.map((call, index) => ({ type: "function_call", call_id: `call_${index}`, ...call })),
      usage: { input_tokens: 9_800, output_tokens: 42 },
    });
  };
}

async function loginAs(email: string) {
  const res = await request(app).post("/auth/login").send({ email, password: "Password123!" });
  return res.body.token as string;
}

describe("agent in shadow (F1)", () => {
  let token: string;

  before(async () => {
    await resetDb();
    await seedCompanyAndAdmin();
    token = await loginAs("admin@test.local");
    process.env.OPENAI_API_KEY = "test-openai-key";
    installModel();
  });

  afterEach(async () => {
    await settleShadowRuns();
    modelOutput = [];
    modelStatus = 200;
    modelRequests = [];
    otherRequests = [];
    process.env.AGENT_SHADOW_SAMPLE_RATE = "1";
    await prisma.agentRun.deleteMany({});
  });

  after(async () => {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
    if (originalRate === undefined) delete process.env.AGENT_SHADOW_SAMPLE_RATE;
    else process.env.AGENT_SHADOW_SAMPLE_RATE = originalRate;
    await resetDb();
    await prisma.$disconnect();
  });

  const say = (text: string) => request(app).post("/command/text").set("Authorization", `Bearer ${token}`).send({ text });

  it("is off unless switched on: no model call, no run", async () => {
    delete process.env.AGENT_SHADOW_SAMPLE_RATE;
    const listed = await say("list clients");
    assert.equal(listed.status, 200);
    await settleShadowRuns();
    assert.equal(modelRequests.length, 0);
    assert.equal(await prisma.agentRun.count(), 0);
  });

  it("proposes without executing anything and stores no message text", async () => {
    process.env.AGENT_SHADOW_SAMPLE_RATE = "1";
    const sentence = "create client Shadow Person, email shadow.person@example.com, phone 07700 900222";
    modelOutput = [
      { name: "run_command", arguments: JSON.stringify({ canonical_command: sentence }) },
      // A proposal that would message someone outside — it must never be sent.
      { name: "send_whatsapp", arguments: JSON.stringify({ to: "+447700900333", body: "Top secret shadow body" }) },
    ];
    const prepared = await say(sentence);
    assert.equal(prepared.status, 202, JSON.stringify(prepared.body));
    assert.equal(prepared.body.intent, "create_client");
    await settleShadowRuns();

    // The model saw the catalogue plus the parser bridge, and nothing was stored by the provider.
    assert.equal(modelRequests.length, 1);
    const sent = modelRequests[0] as { tools: Array<{ name: string }>; store: boolean; max_output_tokens: number };
    assert.equal(sent.store, false);
    assert.equal(sent.tools.length, AGENT_TOOL_CATALOGUE.length + 1);
    assert.equal(sent.tools[0].name, "run_command");
    assert.equal(sent.max_output_tokens, AGENT_RUN_BUDGET.maxOutputTokens);

    // Nothing the shadow proposed ran: no WhatsApp request left, no review of
    // its own, no client — only the parser's own create-client review exists.
    assert.deepEqual(otherRequests.filter((url) => url.includes("graph.facebook.com")), []);
    assert.equal(await prisma.client.count({ where: { displayName: "Shadow Person" } }), 0);
    const reviews = await prisma.voicePendingAction.findMany({ where: { status: "pending" } });
    assert.deepEqual(reviews.map((review) => review.actionType), ["create_client"]);

    const run = await prisma.agentRun.findFirstOrThrow();
    assert.equal(run.mode, "shadow");
    assert.equal(run.status, "completed");
    assert.equal(run.parserIntent, "create_client");
    assert.equal(run.agreement, "match");
    assert.equal(run.steps, 2);
    assert.equal(run.tokensIn, 9_800);
    assert.match(run.inputFingerprint, /^[0-9a-f]{64}$/);
    const stored = JSON.stringify(run);
    for (const secret of ["Shadow Person", "shadow.person@example.com", "Top secret shadow body", "+447700900333", "07700 900222"]) {
      assert.ok(!stored.includes(secret), `the run must not store "${secret}"`);
    }
    const proposed = run.proposedTools as unknown as ProposedTool[];
    assert.deepEqual(proposed.map((tool) => [tool.tool, tool.key, tool.valid]), [
      ["run_command", "create_client", true],
      ["send_whatsapp", "execute_action:send_whatsapp", true],
    ]);
    await prisma.voicePendingAction.deleteMany({});
  });

  it("a failing model is recorded as an error and the request is unaffected", async () => {
    modelStatus = 500;
    const listed = await say("list clients");
    assert.equal(listed.status, 200);
    assert.equal(listed.body.intent, "list_clients");
    await settleShadowRuns();
    const run = await prisma.agentRun.findFirstOrThrow();
    assert.equal(run.status, "error");
    assert.equal(run.errorCode, "HTTP_500");
    assert.equal(run.agreement, "error");
  });

  it("keeps to the step budget", async () => {
    modelOutput = Array.from({ length: AGENT_RUN_BUDGET.maxSteps + 2 }, () => ({
      name: "run_command",
      arguments: JSON.stringify({ canonical_command: "list clients" }),
    }));
    await say("list clients");
    await settleShadowRuns();
    const run = await prisma.agentRun.findFirstOrThrow();
    assert.equal(run.steps, AGENT_RUN_BUDGET.maxSteps);
    assert.equal(run.status, "budget_exceeded");
    assert.equal(run.errorCode, "STEP_BUDGET");
    assert.equal(run.agreement, "match");
  });

  it("a command the parser does not know is an invalid proposal, not a match", async () => {
    modelOutput = [{ name: "run_command", arguments: JSON.stringify({ canonical_command: "launch the rocket" }) }];
    await say("list clients");
    await settleShadowRuns();
    const run = await prisma.agentRun.findFirstOrThrow();
    assert.equal(run.agreement, "invalid_proposal");
  });

  it("confirmation turns get no shadow run", async () => {
    const skipped = observeShadow({
      user: { id: "user", companyId: "company" },
      channel: "text",
      language: "en-GB",
      text: "yes",
      actual: { intent: "confirm_create_client", key: "confirm_create_client" },
    });
    assert.equal(skipped, undefined);
    assert.equal(modelRequests.length, 0);
  });

  it("summarises agreement for the acceptance check, admin only", async () => {
    modelOutput = [{ name: "run_command", arguments: JSON.stringify({ canonical_command: "list clients" }) }];
    await say("list clients");
    await settleShadowRuns();
    modelOutput = [];
    await say("list clients");
    await settleShadowRuns();

    const summary = await request(app).get("/audit/agent-shadow").set("Authorization", `Bearer ${token}`);
    assert.equal(summary.status, 200);
    assert.equal(summary.body.total, 2);
    assert.deepEqual(summary.body.byAgreement, { match: 1, parser_only: 1 });
    assert.equal(summary.body.agreementRate, 0.5);
    assert.equal(summary.body.acceptance.met, false);

    const worker = await loginAs("worker@test.local");
    const denied = await request(app).get("/audit/agent-shadow").set("Authorization", `Bearer ${worker}`);
    assert.equal(denied.status, 403);
  });

  it("compares proposals with the parser outcome", () => {
    const proposal = (key: string | null, valid = key !== null): ProposedTool => ({ tool: "t", kind: "write", key, valid, argumentsFingerprint: "f" });
    assert.equal(compareWithParser([], { intent: "assistant_reply", key: null }), "both_none");
    assert.equal(compareWithParser([proposal("create_job")], { intent: "assistant_plan", key: null }), "agent_only");
    assert.equal(compareWithParser([], { intent: "create_job", key: "create_job" }), "parser_only");
    assert.equal(compareWithParser([proposal("create_task")], { intent: "create_job", key: "create_job" }), "mismatch");
    assert.equal(compareWithParser([proposal("create_task"), proposal("create_job")], { intent: "create_job", key: "create_job" }), "match");
    assert.equal(compareWithParser([proposal(null)], { intent: "create_job", key: "create_job" }), "invalid_proposal");
  });
});
