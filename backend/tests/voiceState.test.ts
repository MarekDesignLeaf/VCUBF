import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import request from "supertest";
import { createServer } from "../src/server.js";
import { prisma } from "../src/db.js";
import { resetDb, seedCompanyAndAdmin } from "./setup.js";

const app = createServer();

describe("native voice device state", () => {
  let token: string;
  before(async () => {
    await resetDb(); await seedCompanyAndAdmin();
    const login = await request(app).post("/auth/login").send({ email: "admin@test.local", password: "Password123!" });
    token = login.body.token;
  });
  after(async () => { await resetDb(); await prisma.$disconnect(); });

  it("shows final transcript and exchanges a pause control", async () => {
    const navigation = await request(app).post("/command/text").set("Authorization", `Bearer ${token}`).send({ text: "show contacts", input_method: "voice_transcript" });
    assert.equal(navigation.status, 200); assert.equal(navigation.body.uiAction.path, "/contacts");
    const updated = await request(app).put("/command/voice-state").set("Authorization", `Bearer ${token}`).send({ status: "hearing", mode: "realtime", listening: true, last_transcript: "show my jobs" });
    assert.equal(updated.status, 200); assert.equal(updated.body.lastTranscript, "show my jobs"); assert.equal(updated.body.lastUiAction.id, navigation.body.uiAction.id);
    const control = await request(app).post("/command/voice-state/control").set("Authorization", `Bearer ${token}`).send({ control: "pause" });
    assert.equal(control.status, 202); assert.equal(control.body.pendingControl, "pause");
    const ack = await request(app).put("/command/voice-state").set("Authorization", `Bearer ${token}`).send({ status: "paused", mode: "wake_word", listening: false, ack_control: "pause" });
    assert.equal(ack.body.pendingControl, null); assert.equal(ack.body.status, "paused");
    const cleared = await request(app).delete("/command/voice-state/history").set("Authorization", `Bearer ${token}`);
    assert.equal(cleared.status, 200); assert.equal(cleared.body.lastTranscript, null); assert.equal(cleared.body.lastUiAction, null);
    const audit = await prisma.auditLog.findFirst({ where: { actionName: "control_voice_device", interpretedIntent: "pause" } });
    assert.ok(audit);
    assert.ok(await prisma.auditLog.findFirst({ where: { actionName: "clear_voice_device_history" } }));
  });

  it("persists a complete ordered text transcript without audio", async () => {
    const started = await request(app).post("/command/voice-conversations").set("Authorization", `Bearer ${token}`).send({ mode: "realtime" });
    assert.equal(started.status, 201);
    const conversationId = started.body.id;

    // Realtime input transcription is asynchronous and may arrive after the
    // model response, so the explicit sequence must define display order.
    const assistant = await request(app).post(`/command/voice-conversations/${conversationId}/messages`).set("Authorization", `Bearer ${token}`).send({ role: "assistant", content: "Open Invoices and choose Create draft.", sequence: 2, source_event_id: "response-1" });
    assert.equal(assistant.status, 201);
    const user = await request(app).post(`/command/voice-conversations/${conversationId}/messages`).set("Authorization", `Bearer ${token}`).send({ role: "user", content: "Where do I create an invoice?", sequence: 1, source_event_id: "input-1" });
    assert.equal(user.status, 201);
    const duplicate = await request(app).post(`/command/voice-conversations/${conversationId}/messages`).set("Authorization", `Bearer ${token}`).send({ role: "user", content: "Where do I create an invoice?", sequence: 1, source_event_id: "input-1" });
    assert.equal(duplicate.status, 200);
    await request(app).post(`/command/voice-conversations/${conversationId}/end`).set("Authorization", `Bearer ${token}`).send({ status: "completed" }).expect(204);

    const history = await request(app).get("/command/voice-conversations").set("Authorization", `Bearer ${token}`);
    assert.equal(history.status, 200);
    assert.equal(history.body[0].status, "completed");
    assert.deepEqual(history.body[0].messages.map((message: any) => [message.role, message.content]), [
      ["user", "Where do I create an invoice?"],
      ["assistant", "Open Invoices and choose Create draft."],
    ]);
    assert.equal("audio" in history.body[0], false);
    assert.equal(await prisma.voiceConversationMessage.count({ where: { conversationId } }), 2);

    await prisma.user.update({ where: { email: "worker@test.local" }, data: { permissions: ["voice.execute"] } });
    const workerLogin = await request(app).post("/auth/login").send({ email: "worker@test.local", password: "Password123!" });
    const workerHistory = await request(app).get("/command/voice-conversations").set("Authorization", `Bearer ${workerLogin.body.token}`);
    assert.deepEqual(workerHistory.body, []);
    await request(app).post(`/command/voice-conversations/${conversationId}/messages`).set("Authorization", `Bearer ${workerLogin.body.token}`).send({ role: "user", content: "not mine" }).expect(404);

    await request(app).delete("/command/voice-state/history").set("Authorization", `Bearer ${token}`).expect(200);
    assert.equal(await prisma.voiceConversation.count({ where: { id: conversationId } }), 0);
  });

  it("keeps at most one active conversation and ends it immediately from the web control", async () => {
    const first = await request(app).post("/command/voice-conversations").set("Authorization", `Bearer ${token}`).send({ mode: "realtime" });
    const second = await request(app).post("/command/voice-conversations").set("Authorization", `Bearer ${token}`).send({ mode: "realtime" });
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.equal(await prisma.voiceConversation.count({ where: { status: "active" } }), 1);
    assert.equal((await prisma.voiceConversation.findUniqueOrThrow({ where: { id: first.body.id } })).status, "interrupted");

    const ended = await request(app)
      .post("/command/voice-state/control")
      .set("Authorization", `Bearer ${token}`)
      .send({ control: "end_conversation" });
    assert.equal(ended.status, 202);
    assert.equal(await prisma.voiceConversation.count({ where: { status: "active" } }), 0);
    assert.equal((await prisma.voiceConversation.findUniqueOrThrow({ where: { id: second.body.id } })).status, "interrupted");
  });
});
