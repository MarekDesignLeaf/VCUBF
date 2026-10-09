import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import request from "supertest";
import { createServer } from "../src/server.js";
import { prisma } from "../src/db.js";
import { AGENT_FUNCTION_TOOLS, AGENT_TOOLSET_FINGERPRINT } from "../src/agents/shadowAgent.js";
import { SPECIALISTS } from "../src/agents/specialists.js";
import { buildId } from "../src/lib/buildInfo.js";
import { modelFor } from "../src/lib/modelGateway.js";
import { resetDb, seedCompanyAndAdmin, TEST_COMPANY_ID } from "./setup.js";

// The agent acting — masterplan F2b and F3. A multi-step request becomes one
// proposal, read out in full, carried out by one yes; nothing changes before it.
// The orchestrator first chooses the specialists, and plans with their tools only.

const app = createServer();

type Call = { name: string; arguments: string };
type Round = Call[] | { text: string };

let interpretation: Record<string, unknown> = {};
let interpretationCalls = 0;
let agentRounds: Round[] = [];
let agentStatus = 200;
let agentRequests: Array<Record<string, any>> = [];
/** What the orchestrator's routing call answers; "other" plans with the whole catalogue. */
let routing: unknown = { specialists: ["other"] };
/** A routing call that fails: an HTTP status, or text that is not JSON at all. */
let routingFailure: { status: number } | { raw: string } | undefined;
let routingRequests = 0;

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
    // The orchestrator's routing call asks for the "specialists" format.
    if (body.text?.format?.name === "specialists") {
      routingRequests += 1;
      if (routingFailure && "status" in routingFailure) return new Response("unavailable", { status: routingFailure.status });
      const text = routingFailure && "raw" in routingFailure ? routingFailure.raw : JSON.stringify(routing);
      return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text }] }], usage: { input_tokens: 400, output_tokens: 10 } });
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
    routing = { specialists: ["other"] };
    routingFailure = undefined;
    routingRequests = 0;
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
      "I propose 2 steps: 1. New job “Hedge trim” for client Petra Novak. 2. New task “Call Petra Novak about the hedge”. Shall I carry out all of them?",
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
    assert.deepEqual((run.proposedTools as Array<{ use: string }>).map((call) => call.use), ["route", "read", "step", "step"]);
    assert.equal((run.proposedTools as Array<{ key: string }>)[0].key, "general", "\"other\" plans with the whole catalogue");
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
      "Done. 1. New job “Hedge trim” for client Petra Novak – done. 2. New task “Call Petra Novak about the hedge” – done.",
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

  it("never proposes administration, connector settings or playbooks, by any route, and says what it left out", async () => {
    agentRounds = [[
      { name: "disconnect_gmail", arguments: "{}" },
      // The same refusal through the command bridge's action form.
      command('voice action disable_connector_source {"connector_key":"gmail"}'),
      // A playbook would run stored steps that are neither read out nor checked here.
      { name: "run_playbook", arguments: JSON.stringify({ playbook_name: "Morning" }) },
      command("create task Check the invoices"),
    ]];
    const proposed = await say("Disconnect Gmail, run the morning playbook and add a task to check the invoices");
    assert.equal(proposed.status, 409, JSON.stringify(proposed.body));
    assert.equal(
      proposed.body.message,
      "I propose one step: 1. New task “Check the invoices”. I left out of the proposal: disconnect gmail, disable connector source, run playbook. You would do that yourself. Shall I carry it out?",
    );
    const run = await prisma.agentRun.findFirstOrThrow({ where: { mode: "proposal" }, orderBy: { createdAt: "desc" } });
    assert.deepEqual((run.proposedTools as Array<{ use: string }>).map((call) => call.use), ["route", "refused", "refused", "refused", "step"]);
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
    assert.match(done.body.message, /^I carried out 1 of 3 steps\. 1\. New task “Buy fuel” – done\. 2\. Failed: No job matching "Missing job"\. I did not carry out the remaining step\.$/);
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

  it("a proposal and another review never wait side by side: the yes means the last thing read out", async () => {
    const reviewClient = () => request(app).post("/command/text").set(as())
      .send({ text: "create client Jan Novy, email jan@example.com, phone 07700 900123", input_method: "text" });
    const waiting = () => prisma.voicePendingAction.findMany({ where: { status: "pending" }, select: { actionType: true } });

    // A client review waits; a proposal replaces it.
    assert.equal((await reviewClient()).status, 202);
    agentRounds = [[command("create task Water the hedge")]];
    const proposed = await say("Water the hedge and tell Petra");
    assert.equal(proposed.status, 409, JSON.stringify(proposed.body));
    assert.deepEqual((await waiting()).map((row) => row.actionType), ["agent_proposal"]);
    const done = await say("yes");
    assert.equal(done.body.intent, "confirm_agent_proposal", JSON.stringify(done.body));
    assert.equal(await prisma.task.count({ where: { title: "Water the hedge" } }), 1);
    assert.equal(await prisma.client.count({ where: { displayName: "Jan Novy" } }), 0);

    // A proposal waits; a newer review replaces it.
    agentRounds = [[command("create task Trim the hedge")]];
    assert.equal((await say("Trim the hedge and tell Petra")).status, 409);
    assert.equal((await reviewClient()).status, 202);
    assert.equal((await latestProposal())?.status, "cancelled");
    const created = await say("yes");
    assert.equal(created.body.intent, "confirm_create_client", JSON.stringify(created.body));
    assert.equal(await prisma.client.count({ where: { displayName: "Jan Novy" } }), 1);
    assert.equal(await prisma.task.count({ where: { title: "Trim the hedge" } }), 0);
  });

  it("a capability the administrator switched off after the read-out is not carried out", async () => {
    agentRounds = [[command("create task Pay the supplier")]];
    const proposed = await say("Remind me to pay the supplier");
    assert.equal(proposed.status, 409, JSON.stringify(proposed.body));
    const policy = (disabled: string[]) => request(app).put("/company/emma-policy").set(as()).send({ disabled_capabilities: disabled });
    assert.equal((await policy(["action.create_task"])).status, 200);
    try {
      const refused = await say("yes", proposed.body.pendingReview.id);
      assert.equal(refused.status, 403, JSON.stringify(refused.body));
      assert.equal(refused.body.error, "EMMA_CAPABILITY_DISABLED");
      assert.match(refused.body.message, /^I carried out 0 of 1 steps\. 1\. Failed: /);
      assert.equal(await prisma.task.count({ where: { title: "Pay the supplier" } }), 0);
    } finally {
      assert.equal((await policy([])).status, 200);
    }
  });

  it("a proposal too long to be read out in full is not put up", async () => {
    agentRounds = [[command(`create task ${"Inspect every hedge on the north boundary ".repeat(25).trim()}`)]];
    const answer = await say("Plan the boundary inspection");
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.equal(answer.body.kind, "reply");
    assert.equal(answer.body.message, "The proposal would be too long to read out in full, so I have not prepared anything. Please split it into smaller requests.");
    assert.equal(answer.body.pendingReview, undefined);
    assert.equal((await prisma.voicePendingAction.count({ where: { status: "pending" } })), 0);
    const run = await prisma.agentRun.findFirstOrThrow({ where: { mode: "proposal" }, orderBy: { createdAt: "desc" } });
    assert.equal(run.errorCode, "PROPOSAL_TOO_LONG");
  });

  it("the orchestrator plans with only the chosen specialists' tools, and refuses the rest (F3)", async () => {
    routing = { specialists: ["scheduling"] };
    agentRounds = [[
      // Not a scheduling tool, nor a scheduling command: refused, whatever the model asks for.
      { name: "send_email", arguments: JSON.stringify({ to: ["petra@example.com"], subject: "Fence", body: "We are coming on Friday." }) },
      command("convert lead Petra Novak"),
      // Customers can be read by every role.
      command("list clients"),
      command("create job Fence repair for Petra Novak"),
    ]];
    const proposed = await say("Book the fence repair for Petra");
    assert.equal(proposed.status, 409, JSON.stringify(proposed.body));
    assert.equal(
      proposed.body.message,
      "I propose one step: 1. New job “Fence repair” for client Petra Novak. I left out of the proposal: send email, convert lead. You would do that yourself. Shall I carry it out?",
      "what the chosen roles cannot do is named, never silently dropped",
    );
    assert.equal(routingRequests, 1);

    const shown = (agentRequests[0].tools as Array<{ name: string; description: string }>);
    assert.deepEqual(shown.map((tool) => tool.name).sort(), ["run_command", ...SPECIALISTS.scheduling.tools].sort());
    assert.match(shown[0].description, /show calendar today/);
    assert.doesNotMatch(shown[0].description, /send email to|convert lead|create client/);
    assert.match(agentRequests[0].instructions, /Scheduling: read the calendar/);

    const run = await prisma.agentRun.findFirstOrThrow({ where: { mode: "proposal" }, orderBy: { createdAt: "desc" } });
    const calls = run.proposedTools as Array<{ use: string; key: string; tool: string }>;
    assert.deepEqual(calls.map((call) => call.use), ["route", "refused", "refused", "read", "step"]);
    assert.equal(calls[0].key, "scheduling");
    assert.notEqual(run.toolsetFingerprint, AGENT_TOOLSET_FINGERPRINT, "the run records the subset it was shown");
    const prepared = await prisma.auditLog.findFirstOrThrow({ where: { actionName: "execute_agent_proposal", interpretedIntent: "agent_proposal" }, orderBy: { createdAt: "desc" } });
    assert.deepEqual((prepared.inputPayload as { specialists: string[] }).specialists, ["scheduling"]);

    assert.equal((await say("no", proposed.body.pendingReview.id)).status, 200);
    assert.equal(await prisma.job.count({ where: { jobTitle: "Fence repair" } }), 0);
  });

  it("a request that is partly outside the roles, or a routing failure, plans with the whole catalogue", async () => {
    const cases: Array<{ answer?: unknown; failure?: { status: number } | { raw: string }; valid: boolean }> = [
      { answer: { specialists: ["crm", "other"] }, valid: true },
      { answer: { specialists: [] }, valid: true },
      { answer: "a string, not the schema", valid: false },
      { failure: { raw: "not json at all" }, valid: false },
      { failure: { status: 500 }, valid: false },
    ];
    for (const { answer, failure, valid } of cases) {
      routing = answer;
      routingFailure = failure;
      agentRequests = [];
      agentRounds = [{ text: "Nothing to change." }];
      const reply = await say("Who is Petra and what did we quote her?");
      assert.equal(reply.status, 200, JSON.stringify(reply.body));
      assert.equal(agentRequests[0].tools.length, AGENT_FUNCTION_TOOLS.length, JSON.stringify({ answer, failure }));
      const run = await prisma.agentRun.findFirstOrThrow({ where: { mode: "proposal" }, orderBy: { createdAt: "desc" } });
      const route = (run.proposedTools as Array<{ key: string; valid: boolean }>)[0];
      assert.equal(route.key, "general");
      assert.equal(route.valid, valid, JSON.stringify({ answer, failure }));
      assert.equal(run.toolsetFingerprint, AGENT_TOOLSET_FINGERPRINT, "the whole catalogue was shown");
    }
  });

  it("a planner failure reads the plan out as before and changes nothing", async () => {
    agentStatus = 500;
    const [jobsBefore, tasksBefore] = [await prisma.job.count(), await prisma.task.count()];
    const fallback = await say("Set up the hedge job for Petra and remind me to call her");
    assert.equal(fallback.status, 200, JSON.stringify(fallback.body));
    assert.equal(fallback.body.kind, "plan");
    assert.equal(fallback.body.message, "1. Create the job. 2. Add a task.");
    assert.equal(await prisma.job.count(), jobsBefore);
    assert.equal(await prisma.task.count(), tasksBefore);
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
    routingRequests = 0;
    const plan = await say("Set up the hedge job for Petra and remind me to call her");
    assert.equal(plan.status, 200);
    assert.equal(plan.body.kind, "plan");
    assert.equal(agentRequests.length, 0, "the agent is not asked while it is off");
    assert.equal(routingRequests, 0, "nor is the orchestrator");
    const withdrawn = await prisma.auditLog.findFirstOrThrow({ where: { actionName: "execute_agent_proposal", errorMessage: "AGENT_OFF" } });
    assert.equal(withdrawn.result, "rejected");
  });
});
