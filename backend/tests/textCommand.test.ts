import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import request from "supertest";
import { createServer } from "../src/server.js";
import { prisma } from "../src/db.js";
import { resetDb, seedCompanyAndAdmin } from "./setup.js";

const app = createServer();

async function loginAs(email: string) {
  const res = await request(app).post("/auth/login").send({ email, password: "Password123!" });
  return res.body.token as string;
}

describe("command/text", () => {
  let adminToken: string;
  let workerToken: string;

  before(async () => {
    await resetDb();
    await seedCompanyAndAdmin();
    adminToken = await loginAs("admin@test.local");
    // worker has empty permissions in setup.ts — used for the permission-denied case.
    workerToken = await loginAs("worker@test.local");
  });
  after(async () => {
    await resetDb();
    await prisma.$disconnect();
  });

  it("rejects a command without voice.execute permission (403)", async () => {
    const res = await request(app)
      .post("/command/text")
      .set("Authorization", `Bearer ${workerToken}`)
      .send({ text: "list clients" });
    assert.equal(res.status, 403);
  });

  it("rejects invalid command audio before contacting the transcription provider", async () => {
    const res = await request(app)
      .post("/command/transcribe?language=en-GB&wake_word=Emma")
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "audio/wav")
      .send(Buffer.from("not a WAV"));
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "INVALID_AUDIO");
  });

  it("a reviewed executable action that no longer validates fails instead of running; cancel reports what it cancelled", async () => {
    const admin = await prisma.user.findFirstOrThrow({ where: { email: "admin@test.local" } });
    const say = (text: string) => request(app).post("/command/text").set("Authorization", `Bearer ${adminToken}`).send({ text });
    const seed = (parameters: Record<string, unknown>) => prisma.voicePendingAction.create({
      data: {
        companyId: admin.companyId,
        userId: admin.id,
        actionType: "emma_universal_action",
        payload: { action: "merge_clients", parameters },
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    // Stored parameters the action's schema no longer accepts are never executed.
    const broken = await seed({ primary_client_name: "Only One" });
    const refused = await say("yes");
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body.intent, "confirm_execute_action");
    assert.equal(refused.body.error, "PENDING_ACTION_INVALID");
    const brokenRow = await prisma.voicePendingAction.findUniqueOrThrow({ where: { id: broken.id } });
    assert.equal(brokenRow.status, "failed");
    assert.equal(brokenRow.payload, null);

    // A no cancels the waiting review and says that something was cancelled.
    const waiting = await seed({ primary_client_name: "First", duplicate_client_name: "Second" });
    const cancelled = await say("cancel action");
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    assert.equal(cancelled.body.intent, "cancel_execute_action");
    assert.deepEqual(cancelled.body.data, { cancelled: true });
    const waitingRow = await prisma.voicePendingAction.findUniqueOrThrow({ where: { id: waiting.id } });
    assert.equal(waitingRow.status, "cancelled");
    assert.equal(waitingRow.payload, null);
  });

  it("a yes approves the review the client showed, not a newer one it never heard", async () => {
    const send = (text: string, review_id?: string | null) =>
      request(app).post("/command/text").set("Authorization", `Bearer ${adminToken}`).send({ text, ...(review_id !== undefined ? { review_id } : {}) });
    const heard = await send("create client Bound Heard, email bound.heard@example.com, phone 07700 900611");
    assert.equal(heard.status, 202, JSON.stringify(heard.body));
    const heardId = heard.body.pendingReview?.id;
    assert.match(heardId, /^[0-9a-f-]{36}$/);
    const unheard = await send("create client Bound Unheard, email bound.unheard@example.com, phone 07700 900622");
    const unheardId = unheard.body.pendingReview?.id;
    assert.ok(unheardId && unheardId !== heardId);

    // The client still shows the first preview: its yes executes nothing.
    const refused = await send("yes", heardId);
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    // Something is waiting, so the answer must not claim nothing is: it says
    // the waiting review was not read out here.
    assert.equal(refused.body.error, "REVIEW_NOT_HEARD");
    assert.match(refused.body.message, /not read out to you here/);
    // The heard review no longer waits, so the client forgets it — and the
    // unheard one is not handed over: the user has not heard it.
    assert.equal(refused.body.pendingReview, null);
    // A client that displays nothing approves nothing.
    const nothingShown = await send("yes", null);
    assert.equal(nothingShown.status, 409, JSON.stringify(nothingShown.body));
    assert.equal(nothingShown.body.error, "REVIEW_NOT_HEARD");
    assert.equal(await prisma.client.count({ where: { displayName: { in: ["Bound Heard", "Bound Unheard"] } } }), 0);

    // A yes for the review that was shown last creates exactly that client.
    const approved = await send("yes", unheardId);
    assert.equal(approved.status, 201, JSON.stringify(approved.body));
    assert.equal(approved.body.pendingReview, null, "the client's remembered review is spent");
    assert.equal(await prisma.client.count({ where: { displayName: "Bound Unheard" } }), 1);
    assert.equal(await prisma.client.count({ where: { displayName: "Bound Heard" } }), 0);
  });

  it("a reviewed action's 409 preview hands over its review, and the assistant path honours it", async () => {
    const companyId = (await prisma.company.findFirstOrThrow()).id;
    await prisma.client.createMany({ data: [{ companyId, displayName: "Bind Keep" }, { companyId, displayName: "Bind Drop" }] });
    const assistant = (text: string, review_id?: string | null) =>
      request(app).post("/command/assistant").set("Authorization", `Bearer ${adminToken}`)
        .send({ text, input_method: "voice_transcript", history: [], ...(review_id !== undefined ? { review_id } : {}) });
    const previewed = await assistant('voice action merge_clients {"primary_client_name":"Bind Keep","duplicate_client_name":"Bind Drop"}', null);
    assert.equal(previewed.body.error, "CONFIRMATION_REQUIRED", JSON.stringify(previewed.body));
    const reviewId = previewed.body.pendingReview?.id;
    assert.match(reviewId, /^[0-9a-f-]{36}$/);
    // A yes carrying a review from elsewhere is refused; the merge has not happened.
    const wrong = await assistant("yes", "00000000-0000-4000-8000-000000000000");
    assert.equal(wrong.body.ok, false, JSON.stringify(wrong.body));
    assert.equal(wrong.body.error, "REVIEW_NOT_HEARD");
    assert.equal(await prisma.client.count({ where: { displayName: "Bind Drop", isActive: true } }), 1);
    await prisma.voicePendingAction.deleteMany({});
  });

  it("previews and confirms a client via a text command and audits it", async () => {
    const preview = await request(app)
      .post("/command/text")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ text: "create client Command Client, email cmd@example.com, phone 07700 900111" });
    assert.equal(preview.status, 202);
    assert.equal(preview.body.intent, "create_client");
    assert.equal(preview.body.ok, true);
    assert.equal(preview.body.data.confirmationRequired, true);
    assert.equal(preview.body.uiAction, undefined);
    assert.equal(await prisma.client.count({ where: { displayName: "Command Client" } }), 0);

    const res = await request(app)
      .post("/command/text")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ text: "yes" });
    assert.equal(res.status, 201);
    assert.equal(res.body.intent, "confirm_create_client");
    assert.equal(res.body.ok, true);
    assert.equal(res.body.data.displayName, "Command Client");
    assert.equal(res.body.uiAction.kind, "navigate");
    assert.equal(res.body.uiAction.path, `/clients/${res.body.data.id}`);

    const audit = await prisma.auditLog.findFirst({
      where: { actionName: "execute_text_command", result: "success" },
      orderBy: { createdAt: "desc" },
    });
    assert.ok(audit);
    assert.equal(audit?.interpretedIntent, "confirm_create_client");
  });

  it("records a reviewed voice transcript while using the same deterministic command path", async () => {
    const res = await request(app)
      .post("/command/text")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ text: "list clients", input_method: "voice_transcript" });
    assert.equal(res.status, 200);
    assert.equal(res.body.intent, "list_clients");
    assert.equal(res.body.ok, true);
    assert.equal(res.body.message, "Opening Clients.");
    assert.equal(res.body.uiAction.path, "/clients");

    const state = await request(app)
      .get("/command/voice-state")
      .set("Authorization", `Bearer ${adminToken}`);
    assert.equal(state.body.lastUiAction.id, res.body.uiAction.id);
    assert.equal(state.body.lastUiAction.label, "Clients");

    const audit = await prisma.auditLog.findFirst({
      where: { actionName: "execute_text_command", result: "success" },
      orderBy: { createdAt: "desc" },
    });
    assert.equal((audit?.inputPayload as any)?.inputMethod, "voice_transcript");
    assert.equal(audit?.interpretedIntent, "list_clients");
  });

  it("executes an already-supported request through the assistant endpoint without an AI round trip", async () => {
    const res = await request(app)
      .post("/command/assistant")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ text: "list clients", input_method: "voice_transcript", language: "en-GB", history: [] });
    assert.equal(res.status, 200);
    assert.equal(res.body.kind, "action");
    assert.equal(res.body.intent, "list_clients");
    assert.equal(res.body.ok, true);
    assert.equal(res.body.message, "Opening Clients.");
  });

  it("navigates the signed-in application without changing business data", async () => {
    const res = await request(app)
      .post("/command/assistant")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ text: "open invoices", input_method: "voice_transcript", language: "en-GB", history: [] });
    assert.equal(res.status, 200);
    assert.equal(res.body.intent, "navigate");
    assert.equal(res.body.message, "Opening Invoices.");
    assert.equal(res.body.uiAction.path, "/invoices");
  });

  it("finds a client, reports data quality and preselects the invoice customer without creating an invoice", async () => {
    const admin = await prisma.user.findUniqueOrThrow({ where: { email: "admin@test.local" } });
    const client = await prisma.client.create({
      data: {
        companyId: admin.companyId,
        displayName: "Invoice Prefill Client",
        emailPrimary: "prefill@example.com",
        phonePrimary: "+447700900123",
        billingLine1: "1 Garden Road",
        billingCity: "London",
        billingPostcode: "SW1A 1AA",
      },
    });
    const before = await prisma.invoice.count();
    const res = await request(app)
      .post("/command/text")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ text: 'voice action prepare_invoice_for_client {"client_name":"Invoice Prefill Client"}', input_method: "voice_transcript" });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.data.clientId, client.id);
    assert.deepEqual(res.body.data.issues, []);
    assert.match(res.body.message, /found Invoice Prefill Client/i);
    assert.equal(res.body.uiAction.path, `/invoices?client=${client.id}`);
    assert.equal(await prisma.invoice.count(), before);
  });

  it("changes Emma and Secretary menu language through a voice command", async () => {
    // Said in English, the language the test user starts in.
    const res = await request(app)
      .post("/command/text")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ text: "switch language to Czech", input_method: "voice_transcript" });
    assert.equal(res.status, 200);
    assert.equal(res.body.intent, "set_voice_language");
    assert.equal(res.body.data.voiceLanguage, "cs-CZ");
    assert.equal(res.body.uiAction.kind, "set_language");
    assert.equal(res.body.uiAction.language, "cs-CZ");

    const me = await request(app).get("/auth/me").set("Authorization", `Bearer ${adminToken}`);
    assert.equal(me.body.voiceLanguage, "cs-CZ");

    const state = await request(app).get("/command/voice-state").set("Authorization", `Bearer ${adminToken}`);
    assert.equal(state.body.lastUiAction.kind, "set_language");
    assert.equal(state.body.lastUiAction.language, "cs-CZ");
  });

  it("does not execute an AI-inferred language change that the user did not request", async () => {
    await request(app)
      .post("/command/text")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ text: "změň jazyk na češtinu", input_method: "voice_transcript" });
    const previousKey = process.env.OPENAI_API_KEY;
    const previousFetch = globalThis.fetch;
    process.env.OPENAI_API_KEY = "test-key";
    globalThis.fetch = async () => Response.json({
      output: [{ content: [{ text: JSON.stringify({
        kind: "command",
        canonical_command: "set language en-GB",
        message: "Switching to English.",
      }) }] }],
    });
    try {
      const res = await request(app)
        .post("/command/assistant")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ text: "tell me something useful", input_method: "voice_transcript", language: "cs-CZ", history: [] });
      assert.equal(res.status, 200);
      assert.equal(res.body.kind, "clarification");

      const me = await request(app).get("/auth/me").set("Authorization", `Bearer ${adminToken}`);
      assert.equal(me.body.voiceLanguage, "cs-CZ");
      const audit = await prisma.auditLog.findFirst({
        where: { actionName: "reject_inferred_voice_language_change" },
        orderBy: { createdAt: "desc" },
      });
      assert.equal(audit?.errorMessage, "LANGUAGE_CHANGE_NOT_EXPLICIT");
    } finally {
      globalThis.fetch = previousFetch;
      if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousKey;
    }
  });

  it("uses multi-turn client details, reports invalid contact data, and confirms only a real create", async () => {
    // This scenario verifies the English response contract. Keep it independent
    // from the preceding language-persistence tests, which intentionally leave
    // the shared test user in Czech.
    await prisma.user.update({
      where: { email: "admin@test.local" },
      data: { voiceLanguage: "en-GB" },
    });
    const previousKey = process.env.OPENAI_API_KEY;
    const previousFetch = globalThis.fetch;
    process.env.OPENAI_API_KEY = "test-key";
    let assistantResult = {
      kind: "command",
      canonical_command: "create client Roger, email roger@gmail.com, phone 0755 835 085",
      message: "Creating Roger.",
    };
    let providerRequest: any;
    globalThis.fetch = async (_input, init) => {
      providerRequest = JSON.parse(String(init?.body ?? "{}"));
      return Response.json({ output: [{ content: [{ text: JSON.stringify(assistantResult) }] }] });
    };
    const history = [
      { role: "user", content: "Emma, make a new client." },
      { role: "assistant", content: "What is the client name?" },
      { role: "user", content: "Client name is Roger" },
      { role: "assistant", content: "What is Roger's email address?" },
      { role: "user", content: "Email address is roger@gmail.com" },
    ];
    try {
      const invalid = await request(app)
        .post("/command/assistant")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ text: "Phone number is 0755 835 085.", input_method: "voice_transcript", language: "en-GB", history });
      assert.equal(invalid.status, 400);
      assert.equal(invalid.body.kind, "action");
      assert.equal(invalid.body.intent, "create_client");
      assert.equal(invalid.body.ok, false);
      assert.deepEqual(invalid.body.data.invalidFields, ["phone_primary"]);
      assert.match(invalid.body.message, /Roger was not created/i);
      assert.equal(invalid.body.assistantMessage, invalid.body.message);
      assert.doesNotMatch(invalid.body.assistantMessage, /Creating Roger/i);
      assert.equal(await prisma.client.count({ where: { displayName: "Roger" } }), 0);
      assert.equal(providerRequest.input[0].content, "Emma, make a new client.");
      assert.equal(providerRequest.input.at(-1).content, "Phone number is 0755 835 085.");

      assistantResult = {
        kind: "reply",
        canonical_command: null as any,
        message: "Understood. I'll go ahead and create Roger now.",
      };
      const falsePromise = await request(app)
        .post("/command/assistant")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ text: "Yes, that's correct.", input_method: "voice_transcript", language: "en-GB", history });
      assert.equal(falsePromise.status, 200);
      assert.equal(falsePromise.body.actionExecuted, false);
      assert.equal(falsePromise.body.message, "No business record was created or changed. I still need a complete, valid request before I can do that.");
      assert.equal(await prisma.client.count({ where: { displayName: "Roger" } }), 0);

      assistantResult = {
        kind: "command",
        canonical_command: "create client Roger, email roger@gmail.com, phone 07700 900123",
        message: "Creating Roger.",
      };
      const preview = await request(app)
        .post("/command/assistant")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ text: "The full phone number is 07700 900123.", input_method: "voice_transcript", language: "en-GB", history });
      assert.equal(preview.status, 202);
      assert.equal(preview.body.ok, true);
      assert.equal(preview.body.intent, "create_client");
      assert.equal(preview.body.data.confirmationRequired, true);
      assert.match(preview.body.message, /Please confirm/i);
      assert.equal(await prisma.client.count({ where: { displayName: "Roger" } }), 0);

      const created = await request(app)
        .post("/command/assistant")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ text: "yes", input_method: "voice_transcript", language: "en-GB", history: [] });
      assert.equal(created.status, 201);
      assert.equal(created.body.ok, true);
      assert.equal(created.body.intent, "confirm_create_client");
      assert.equal(created.body.message, "Roger was created as a client.");
      assert.equal(created.body.assistantMessage, created.body.message);
      assert.equal(await prisma.client.count({ where: { displayName: "Roger" } }), 1);
    } finally {
      globalThis.fetch = previousFetch;
      if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousKey;
    }
  });

  it("creates a job via text command by resolving the client name", async () => {
    const res = await request(app)
      .post("/command/text")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ text: "create job Fence repair for Command Client" });
    assert.equal(res.status, 201);
    assert.equal(res.body.data.jobTitle, "Fence repair");
    assert.equal(res.body.data.jobStatus, "nova");
  });

  it("changes job status via text command with a human status word", async () => {
    const res = await request(app)
      .post("/command/text")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ text: "set job Fence repair as scheduled" });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.jobStatus, "naplanovano");
  });

  it("returns CLIENT_NOT_FOUND when the referenced client doesn't exist", async () => {
    const res = await request(app)
      .post("/command/text")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ text: "create job Something for Nonexistent Person" });
    assert.equal(res.status, 404);
    assert.equal(res.body.error, "CLIENT_NOT_FOUND");
  });

  it("returns AMBIGUOUS_REFERENCE when multiple clients match", async () => {
    await request(app)
      .post("/crm/clients")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ display_name: "Command Client Two" });

    const res = await request(app)
      .post("/command/text")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ text: "create job Painting for Command" });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, "AMBIGUOUS_REFERENCE");
  });

  it("returns UNSUPPORTED_ACTION for unrecognized text and audits the failure", async () => {
    const res = await request(app)
      .post("/command/text")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ text: "do something vague" });
    assert.equal(res.status, 422);
    assert.equal(res.body.error, "UNSUPPORTED_ACTION");

    const audit = await prisma.auditLog.findFirst({
      where: { actionName: "execute_text_command", result: "error" },
      orderBy: { createdAt: "desc" },
    });
    assert.ok(audit);
  });

  it("assigns a job to an employee via a text command, resolving both by name", async () => {
    const accepted = await request(app)
      .post("/command/text")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ text: "set job Fence repair as accepted" });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.data.jobStatus, "prijato");

    const res = await request(app)
      .post("/command/text")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ text: "assign job Fence repair to Test Admin" });
    assert.equal(res.status, 200);
    assert.equal(res.body.intent, "assign_job");
    assert.equal(res.body.ok, true);
    assert.equal(res.body.data.job.jobTitle, "Fence repair");
  });

  it("returns EMPLOYEE_NOT_FOUND when assigning to an unknown employee name", async () => {
    const res = await request(app)
      .post("/command/text")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ text: "assign job Fence repair to Nobody Here" });
    assert.equal(res.status, 404);
    assert.equal(res.body.error, "EMPLOYEE_NOT_FOUND");
  });

  it("detects overload via a text command", async () => {
    const res = await request(app)
      .post("/command/text")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ text: "show overload" });
    assert.equal(res.status, 200);
    assert.equal(res.body.intent, "detect_overload");
    assert.ok(Array.isArray(res.body.data.overloadedWeeks));
  });

  it("creates and lists Secretary tasks through text commands", async () => {
    const create = await request(app)
      .post("/command/text")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ text: "create task for Test Admin: Review tomorrow's schedule" });
    assert.equal(create.status, 201);
    assert.equal(create.body.intent, "create_task");
    assert.equal(create.body.data.task.title, "Review tomorrow's schedule");
    assert.equal(create.body.data.task.assignedUser.displayName, "Test Admin");

    const list = await request(app)
      .post("/command/text")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ text: "list tasks" });
    assert.equal(list.status, 200);
    assert.equal(list.body.intent, "list_tasks");
    assert.ok(list.body.data.some((task: any) => task.id === create.body.data.task.id));
  });

  it("creates a service catalogue item via a text command", async () => {
    const res = await request(app)
      .post("/command/text")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ text: "create service Gutter cleaning, category Roofing" });
    assert.equal(res.status, 201);
    assert.equal(res.body.intent, "create_service");
    assert.equal(res.body.data.name, "Gutter cleaning");
    assert.equal(res.body.data.category, "Roofing");
  });

  it("lists quotes for a specific client via a text command", async () => {
    const clientRes = await request(app)
      .post("/crm/clients")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ display_name: "Text Command Quote Client" });
    const clientId = clientRes.body.id;
    await request(app)
      .post("/quotes")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        client_id: clientId,
        title: "Voice quote",
        items: [{ description: "Job", unit_price: 100, unit_cost: 60 }],
      });

    const res = await request(app)
      .post("/command/text")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ text: "list quotes for Text Command Quote Client" });
    assert.equal(res.status, 200);
    assert.equal(res.body.intent, "list_quotes");
    assert.ok(res.body.data.length >= 1);
    assert.ok(res.body.data.every((q: any) => q.clientId === clientId));
  });

  it("returns AMBIGUOUS_REFERENCE when 'list quotes for X' matches multiple clients", async () => {
    await request(app)
      .post("/crm/clients")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ display_name: "Ambiguous Quote Co" });
    await request(app)
      .post("/crm/clients")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ display_name: "Ambiguous Quote Co Ltd" });

    const res = await request(app)
      .post("/command/text")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ text: "list quotes for Ambiguous Quote Co" });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, "AMBIGUOUS_REFERENCE");
  });

  it("lists job openings via a text command", async () => {
    await request(app)
      .post("/recruitment/job-openings")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ title: "Text Command Opening" });

    const res = await request(app)
      .post("/command/text")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ text: "list job openings" });
    assert.equal(res.status, 200);
    assert.equal(res.body.intent, "list_job_openings");
    assert.ok(res.body.data.some((o: any) => o.title === "Text Command Opening"));
  });

  it("lists clients via a text command", async () => {
    const res = await request(app)
      .post("/command/text")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ text: "list clients" });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.data));
    assert.ok(res.body.data.length >= 1);
  });
});
