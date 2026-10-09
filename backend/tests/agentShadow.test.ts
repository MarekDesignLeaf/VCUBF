import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import request from "supertest";
import { createServer } from "../src/server.js";
import { prisma } from "../src/db.js";
import {
  AGENT_PLANNER_FINGERPRINT,
  AGENT_RUN_BUDGET,
  compareWithParser,
  observeShadow,
  settleShadowRuns,
  type Proposal,
  type ProposedTool,
} from "../src/agents/shadowAgent.js";
import { AGENT_TOOL_CATALOGUE } from "../src/agents/toolCatalogue.js";
import { resetDb, seedCompanyAndAdmin } from "./setup.js";

const app = createServer();

type Call = { name: string; arguments: string };
let modelOutput: Call[] = [];
let modelStatus = 200;
let modelIncomplete: string | undefined;
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
      status: modelIncomplete ? "incomplete" : "completed",
      ...(modelIncomplete ? { incomplete_details: { reason: modelIncomplete } } : {}),
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
    modelIncomplete = undefined;
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
    // The right command, but with a send beside it: not a match.
    assert.equal(run.agreement, "extra_calls");
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
    // What each call would have been given is compared in memory and never kept.
    assert.ok(proposed.every((tool) => !("entities" in tool)), JSON.stringify(proposed));
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

  it("the right command with other values is not a match", async () => {
    modelOutput = [{
      name: "run_command",
      arguments: JSON.stringify({ canonical_command: "create client Values Differ, email someone.else@example.com, phone 07700 900444" }),
    }];
    const prepared = await say("create client Values Differ, email values.differ@example.com, phone 07700 900444");
    assert.equal(prepared.status, 202, JSON.stringify(prepared.body));
    await settleShadowRuns();
    const run = await prisma.agentRun.findFirstOrThrow();
    assert.equal(run.agreement, "arguments_differ");
    assert.ok(!JSON.stringify(run).includes("someone.else@example.com"));
    await prisma.voicePendingAction.deleteMany({});
  });

  it("the same command with exactly the same values is a match", async () => {
    modelOutput = [{
      name: "run_command",
      arguments: JSON.stringify({ canonical_command: "create client Values Same, email values.same@example.com, phone 07700 900555" }),
    }];
    await say("create client Values Same, email values.same@example.com, phone 07700 900555");
    await settleShadowRuns();
    const run = await prisma.agentRun.findFirstOrThrow();
    assert.equal(run.agreement, "match");
    await prisma.voicePendingAction.deleteMany({});
  });

  it("a plan cut off by the output budget is recorded as such, never compared", async () => {
    modelIncomplete = "max_output_tokens";
    modelOutput = [];
    await say("list clients");
    await settleShadowRuns();
    const run = await prisma.agentRun.findFirstOrThrow();
    assert.equal(run.status, "budget_exceeded");
    assert.equal(run.errorCode, "OUTPUT_BUDGET");
    // An empty truncated answer must not count as "neither would act".
    assert.equal(run.agreement, "error");
    assert.equal(run.tokensIn, 9_800);
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
    assert.equal(run.agreement, "extra_calls");
  });

  it("a command the parser does not know is an invalid proposal, not a match", async () => {
    modelOutput = [{ name: "run_command", arguments: JSON.stringify({ canonical_command: "launch the rocket" }) }];
    await say("list clients");
    await settleShadowRuns();
    const run = await prisma.agentRun.findFirstOrThrow();
    assert.equal(run.agreement, "invalid_proposal");
  });

  it("a bridge call with anything beside the canonical command is invalid", async () => {
    modelOutput = [{ name: "run_command", arguments: JSON.stringify({ canonical_command: "list clients", unexpected: true }) }];
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

    // Runs of another model or another planner are shown but never counted toward acceptance.
    const counted = await prisma.agentRun.findFirstOrThrow();
    await prisma.agentRun.create({
      data: { ...counted, id: undefined, model: "some-earlier-model", agreement: "match", proposedTools: [] },
    });
    await prisma.agentRun.create({
      data: { ...counted, id: undefined, plannerFingerprint: "an-earlier-planner", agreement: "match", proposedTools: [] },
    });

    const summary = await request(app).get("/audit/agent-shadow").set("Authorization", `Bearer ${token}`);
    assert.equal(summary.status, 200);
    assert.equal(summary.body.total, 2);
    assert.equal(summary.body.otherCohortRuns, 2);
    assert.equal(summary.body.cohort.model, "gpt-5.4-mini");
    assert.equal(summary.body.cohort.plannerFingerprint, AGENT_PLANNER_FINGERPRINT);
    assert.deepEqual(summary.body.byAgreement, { match: 1, parser_only: 1 });
    assert.equal(summary.body.agreementRate, 0.5);
    assert.equal(summary.body.acceptance.met, false);

    const worker = await loginAs("worker@test.local");
    const denied = await request(app).get("/audit/agent-shadow").set("Authorization", `Bearer ${worker}`);
    assert.equal(denied.status, 403);
  });

  it("compares proposals with the parser outcome", () => {
    const proposal = (key: string | null, valid = key !== null, entities?: unknown): Proposal => ({ tool: "t", kind: "write", key, valid, argumentsFingerprint: "f", entities });
    const job = { intent: "create_job", key: "create_job", entities: { title: "Garden", client_name: "Jane Smith" } };
    assert.equal(compareWithParser([proposal("create_job", true, { title: "Garden", client_name: "Jane Smith" })], job), "match");
    // Values are compared exactly: text that differs only in case or spacing is different text.
    assert.equal(compareWithParser([proposal("create_job", true, { client_name: "jane  smith", title: "Garden" })], job), "arguments_differ");
    const message = { intent: "execute_action", key: "execute_action:send_whatsapp", entities: { action: "send_whatsapp", parameters: { to: "+447700900123", body: "Please STOP" } } };
    assert.equal(
      compareWithParser([proposal("execute_action:send_whatsapp", true, { action: "send_whatsapp", parameters: { to: "+447700900123", body: "please  STOP" } })], message),
      "arguments_differ",
    );
    assert.equal(compareWithParser([proposal("create_job", true, { client_name: "John Smith", title: "Garden" })], job), "arguments_differ");
    // A service-validated action given nothing differs from what the parser received.
    assert.equal(
      compareWithParser(
        [proposal("execute_action:create_website_audit", true, { action: "create_website_audit", parameters: {} })],
        { intent: "execute_action", key: "execute_action:create_website_audit", entities: { action: "create_website_audit", parameters: { website_url: "https://example.com", pages: ["/"] } } },
      ),
      "arguments_differ",
    );
    assert.equal(compareWithParser([], { intent: "assistant_reply", key: null }), "both_none");
    assert.equal(compareWithParser([proposal("create_job")], { intent: "assistant_plan", key: null }), "agent_only");
    assert.equal(compareWithParser([], { intent: "create_job", key: "create_job" }), "parser_only");
    assert.equal(compareWithParser([proposal("create_task")], { intent: "create_job", key: "create_job" }), "mismatch");
    assert.equal(compareWithParser([proposal("create_job")], { intent: "create_job", key: "create_job" }), "match");
    // The right action with something else beside it is not agreement.
    assert.equal(compareWithParser([proposal("create_task"), proposal("create_job")], { intent: "create_job", key: "create_job" }), "extra_calls");
    // Neither is the right action with arguments its schema refuses, nor any refused call beside it.
    assert.equal(compareWithParser([proposal("create_job", false)], { intent: "create_job", key: "create_job" }), "invalid_proposal");
    assert.equal(compareWithParser([proposal("create_job"), proposal(null)], { intent: "create_job", key: "create_job" }), "invalid_proposal");
    assert.equal(compareWithParser([proposal(null)], { intent: "assistant_reply", key: null }), "invalid_proposal");
  });
});
