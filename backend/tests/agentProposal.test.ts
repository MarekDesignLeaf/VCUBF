import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import request from "supertest";
import { createServer } from "../src/server.js";
import { prisma } from "../src/db.js";
import { AGENT_TOOLSET_FINGERPRINT } from "../src/agents/shadowAgent.js";
import { buildId } from "../src/lib/buildInfo.js";
import { modelFor } from "../src/lib/modelGateway.js";
import { resetDb, seedCompanyAndAdmin, TEST_COMPANY_ID } from "./setup.js";

// The agent acting — masterplan F2b. A multi-step request becomes one
// proposal, read out in full, carried out by one yes; nothing changes before it.

const app = createServer();

type Call = { name: string; arguments: string };
type Round = Call[] | { text: string };

let interpretation: Record<string, unknown> = {};
let interpretationCalls = 0;
let agentRounds: Round[] = [];
let agentStatus = 200;
let agentRequests: Array<Record<string, any>> = [];

const originalFetch = globalThis.fetch;
const originalKey = process.env.OPENAI_API_KEY;
const originalBuild = process.env.RAILWAY_GIT_COMMIT_SHA;

const command = (canonical: string): Call => ({ name: "run_command", arguments: JSON.stringify({ canonical_command: canonical }) });

function installModel() {
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    if (url.hostname !== "api.openai.com") return originalFetch(input, init);
    const body = JSON.parse(String(init?.body ?? "{}"));
    // The agent is the request that offers tools; the interpretation offers none.
    if (Array.isArray(body.tools)) {
      agentRequests.push(body);
      if (agentStatus !== 200) return new Response("unavailable", { status: agentStatus });
      const round = agentRounds.shift() ?? { text: "" };
      const usage = { input_tokens: 9_000, output_tokens: 60 };
      if (!Array.isArray(round)) {
        return Response.json({ status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: round.text }] }], usage });
      }
      return Response.json({
        status: "completed",
        output: round.map((call, index) => ({ type: "function_call", id: `fc_${agentRequests.length}_${index}`, call_id: `call_${agentRequests.length}_${index}`, ...call })),
        usage,
      });
    }
    interpretationCalls += 1;
    return Response.json({ output: [{ content: [{ text: JSON.stringify(interpretation) }] }] });
  };
}

describe("agent proposals (F2b)", () => {
  let token: string;
  const as = () => ({ Authorization: `Bearer ${token}` });
  const say = (text: string, reviewId?: string | null) =>
    request(app).post("/command/assistant").set(as()).send({ text, input_method: "voice_transcript", language: "en-GB", history: [], ...(reviewId !== undefined ? { review_id: reviewId } : {}) });
  const switchAgent = (enabled: boolean) => request(app).put("/company/agent-mode").set(as()).send({ enabled, reason: "test" });
  const latestProposal = () => prisma.voicePendingAction.findFirst({ where: { actionType: "agent_proposal" }, orderBy: { createdAt: "desc" } });

  before(async () => {
    process.env.RAILWAY_GIT_COMMIT_SHA = "agentproposaltestbuild";
    process.env.OPENAI_API_KEY = "test-key";
    await resetDb();
    const { admin } = await seedCompanyAndAdmin();
    token = (await request(app).post("/auth/login").send({ email: "admin@test.local", password: "Password123!" })).body.token;
    await prisma.client.create({ data: { companyId: TEST_COMPANY_ID, displayName: "Petra Novak" } });
    // English voice requests passed the shadow acceptance on this build.
    const template = {
      companyId: TEST_COMPANY_ID, userId: admin.id, mode: "shadow", channel: "assistant", language: "en-GB",
      inputFingerprint: "f", catalogueVersion: "1.1.0", catalogueFingerprint: "c",
      toolsetFingerprint: AGENT_TOOLSET_FINGERPRINT, build: buildId(), model: modelFor("agent_plan"),
      status: "completed", steps: 1, proposedTools: [], durationMs: 1,
    };
    await prisma.agentRun.createMany({
      data: [
        ...Array.from({ length: 80 }, () => ({ ...template, agreement: "match", parserIntent: "execute_action", parserAction: "execute_action:create_task" })),
        ...Array.from({ length: 40 }, () => ({ ...template, agreement: "both_none", parserIntent: "assistant_reply", parserAction: null })),
      ],
    });
    assert.equal((await switchAgent(true)).status, 200);
    installModel();
  });

  beforeEach(() => {
    interpretation = { kind: "plan", canonical_command: null, message: "1. Create the job. 2. Add a task." };
    agentRounds = [];
    agentStatus = 200;
    agentRequests = [];
  });

  after(async () => {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
    if (originalBuild === undefined) delete process.env.RAILWAY_GIT_COMMIT_SHA;
    else process.env.RAILWAY_GIT_COMMIT_SHA = originalBuild;
    await prisma.$disconnect();
  });

  it("reads first, puts up one proposal, and one yes carries out every step", async () => {
    agentRounds = [
      [command("list clients")],
      [command("create job Hedge trim for Petra Novak"), command("create task Call Petra Novak about the hedge")],
    ];
    const proposed = await say("Set up the hedge job for Petra and remind me to call her");
    assert.equal(proposed.status, 409, JSON.stringify(proposed.body));
    assert.equal(proposed.body.error, "CONFIRMATION_REQUIRED");
    assert.equal(proposed.body.intent, "agent_proposal");
    assert.equal(
      proposed.body.message,
      "I propose 2 steps: 1. command “create job Hedge trim for Petra Novak”. 2. command “create task Call Petra Novak about the hedge”. Shall I carry out all of them?",
    );
    assert.equal(proposed.body.assistantMessage, proposed.body.message);
    assert.equal(proposed.body.data.steps.length, 2);
    const reviewId = proposed.body.pendingReview?.id as string;
    assert.ok(reviewId, "the client is told which proposal its yes approves");

    // The read ran and its result went back to the planner.
    assert.equal(agentRequests.length, 2);
    const fed = agentRequests[1].input.find((item: { type?: string }) => item.type === "function_call_output");
    assert.match(fed.output, /Petra Novak/);
    assert.ok(agentRequests[1].input.every((item: { id?: unknown }) => item.id === undefined), "stored items are not referenced (store: false)");
    // Nothing changed before the yes.
    assert.equal(await prisma.job.count(), 0);
    assert.equal(await prisma.task.count(), 0);

    // The run is recorded without any text (D4).
    const run = await prisma.agentRun.findFirstOrThrow({ where: { mode: "proposal" }, orderBy: { createdAt: "desc" } });
    assert.equal(run.status, "completed");
    assert.equal(run.agreement, "not_compared");
    assert.deepEqual((run.proposedTools as Array<{ use: string }>).map((call) => call.use), ["read", "step", "step"]);
    assert.doesNotMatch(JSON.stringify(run), /Petra|hedge/i);
    const prepared = await prisma.auditLog.findFirstOrThrow({ where: { actionName: "execute_agent_proposal", interpretedIntent: "agent_proposal" } });
    assert.equal(prepared.errorMessage, "CONFIRMATION_REQUIRED");
    assert.doesNotMatch(JSON.stringify(prepared.inputPayload), /Petra|hedge/i);

    const interpretationsBefore = interpretationCalls;
    const done = await say("yes", reviewId);
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(done.body.intent, "confirm_agent_proposal");
    assert.equal(done.body.ok, true);
    assert.equal(
      done.body.message,
      "Done. 1. command “create job Hedge trim for Petra Novak” – done. 2. command “create task Call Petra Novak about the hedge” – done.",
    );
    assert.equal(interpretationCalls, interpretationsBefore, "a yes is not interpreted by the model");
    assert.equal(agentRequests.length, 2, "a yes is not planned again");
    const job = await prisma.job.findFirstOrThrow({ include: { client: true } });
    assert.equal(job.jobTitle, "Hedge trim");
    assert.equal(job.client.displayName, "Petra Novak");
    assert.equal((await prisma.task.findFirstOrThrow()).title, "Call Petra Novak about the hedge");
    const resolved = await latestProposal();
    assert.equal(resolved?.status, "completed");
    assert.equal(resolved?.payload, null, "the proposal's text does not outlive the decision");
    const executed = await prisma.auditLog.findFirstOrThrow({ where: { actionName: "execute_agent_proposal", interpretedIntent: "confirm_agent_proposal" } });
    assert.equal(executed.result, "success");
    assert.equal(executed.confirmed, true);
  });

  it("a request that needs no change is answered from what the agent read", async () => {
    agentRounds = [[command("list clients")], { text: "You have one client, Petra Novak." }];
    const answer = await say("Who are my clients and is anything due?");
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.equal(answer.body.kind, "reply");
    assert.equal(answer.body.message, "You have one client, Petra Novak.");
    assert.equal(answer.body.pendingReview, undefined);
  });

  it("never proposes administration or connector settings, and says what it left out", async () => {
    agentRounds = [[{ name: "disconnect_gmail", arguments: "{}" }, command("create task Check the invoices")]];
    const proposed = await say("Disconnect Gmail and add a task to check the invoices");
    assert.equal(proposed.status, 409, JSON.stringify(proposed.body));
    assert.match(proposed.body.message, /^I propose one step: 1\. command “create task Check the invoices”\. I left out of the proposal: disconnect gmail\. You would do that yourself\. Shall I carry it out\?$/);
    const cancelled = await say("no", proposed.body.pendingReview.id);
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    assert.equal(cancelled.body.intent, "cancel_agent_proposal");
    assert.equal(cancelled.body.message, "Cancelled; nothing was done.");
    assert.equal(await prisma.task.count({ where: { title: "Check the invoices" } }), 0);
    assert.equal((await latestProposal())?.status, "cancelled");
  });

  it("a failing step stops the rest, and the answer says which ran", async () => {
    agentRounds = [[command("create task Buy fuel"), command("set job Missing job as dokonceno"), command("create task Wash the van")]];
    const proposed = await say("Buy fuel, close the missing job and wash the van");
    assert.equal(proposed.status, 409, JSON.stringify(proposed.body));
    const done = await say("yes", proposed.body.pendingReview.id);
    assert.equal(done.body.ok, false, JSON.stringify(done.body));
    assert.equal(done.status, 404);
    assert.match(done.body.message, /^I carried out 1 of 3 steps\. 1\. command “create task Buy fuel” – done\. 2\. Failed: No job matching "Missing job"\. I did not carry out the remaining step\.$/);
    assert.equal(await prisma.task.count({ where: { title: "Buy fuel" } }), 1);
    assert.equal(await prisma.task.count({ where: { title: "Wash the van" } }), 0);
    assert.equal((await latestProposal())?.status, "failed");
  });

  it("the emergency stop refuses the yes and keeps the proposal; the no still works", async () => {
    agentRounds = [[command("create task Sharpen the shears")]];
    const proposed = await say("Remind me to sharpen the shears");
    assert.equal(proposed.status, 409, JSON.stringify(proposed.body));
    assert.equal((await request(app).put("/company/safe-mode").set(as()).send({ enabled: true })).status, 200);
    try {
      const refused = await say("yes", proposed.body.pendingReview.id);
      assert.equal(refused.status, 423, JSON.stringify(refused.body));
      assert.equal(refused.body.error, "SAFE_MODE_ACTIVE");
      assert.equal(await prisma.task.count({ where: { title: "Sharpen the shears" } }), 0);
      assert.equal((await latestProposal())?.status, "pending");
      const cancelled = await say("no", proposed.body.pendingReview.id);
      assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
      assert.equal((await latestProposal())?.status, "cancelled");
    } finally {
      assert.equal((await request(app).put("/company/safe-mode").set(as()).send({ enabled: false })).status, 200);
    }
  });

  it("a planner failure reads the plan out as before and changes nothing", async () => {
    agentStatus = 500;
    const fallback = await say("Set up the hedge job for Petra and remind me to call her");
    assert.equal(fallback.status, 200, JSON.stringify(fallback.body));
    assert.equal(fallback.body.kind, "plan");
    assert.equal(fallback.body.message, "1. Create the job. 2. Add a task.");
    const run = await prisma.agentRun.findFirstOrThrow({ where: { mode: "proposal" }, orderBy: { createdAt: "desc" } });
    assert.equal(run.status, "error");
    assert.equal(run.errorCode, "HTTP_500");
    assert.equal(run.agreement, "error");
  });

  it("switching the agent off withdraws a waiting proposal, and plans are only read out again", async () => {
    agentRounds = [[command("create task Order new blades")]];
    const proposed = await say("Order new blades for the trimmer");
    assert.equal(proposed.status, 409, JSON.stringify(proposed.body));
    assert.equal((await switchAgent(false)).status, 200);

    const refused = await say("yes", proposed.body.pendingReview.id);
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body.error, "AGENT_OFF");
    assert.equal(refused.body.message, "The agent is switched off, so I withdrew its proposal and did nothing.");
    assert.equal(refused.body.pendingReview, null, "the client forgets the withdrawn proposal");
    assert.equal(await prisma.task.count({ where: { title: "Order new blades" } }), 0);
    assert.equal((await latestProposal())?.status, "cancelled");

    agentRequests = [];
    const plan = await say("Set up the hedge job for Petra and remind me to call her");
    assert.equal(plan.status, 200);
    assert.equal(plan.body.kind, "plan");
    assert.equal(agentRequests.length, 0, "the agent is not asked while it is off");
    const withdrawn = await prisma.auditLog.findFirstOrThrow({ where: { actionName: "execute_agent_proposal", errorMessage: "AGENT_OFF" } });
    assert.equal(withdrawn.result, "rejected");
  });
});
