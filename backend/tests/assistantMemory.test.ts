import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import request from "supertest";
import { createServer } from "../src/server.js";
import { prisma } from "../src/db.js";
import { resetDb, seedCompanyAndAdmin } from "./setup.js";

const app = createServer();

async function login(email: string) {
  const response = await request(app).post("/auth/login").send({ email, password: "Password123!" });
  return response.body.token as string;
}

describe("Emma persistent and conversation memory", () => {
  let adminToken: string;
  let workerToken: string;

  before(async () => {
    await resetDb();
    await seedCompanyAndAdmin();
    adminToken = await login("admin@test.local");
    await prisma.user.update({ where: { email: "worker@test.local" }, data: { permissions: ["voice.execute"] } });
    workerToken = await login("worker@test.local");
  });

  after(async () => {
    await resetDb();
    await prisma.$disconnect();
  });

  it("stores only an explicit remember command, deduplicates it and audits the write", async () => {
    const saved = await request(app)
      .post("/command/assistant")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        text: "remember that invoice numbers use YYYY-001",
        input_method: "voice_transcript",
        language: "en-GB",
        history: [],
      });
    assert.equal(saved.status, 201);
    assert.equal(saved.body.intent, "create_assistant_memory");
    assert.equal(saved.body.data.scope, "personal");
    assert.equal(saved.body.data.content, "invoice numbers use YYYY-001");
    assert.equal(saved.body.data.duplicate, false);

    const duplicate = await request(app)
      .post("/command/assistant")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ text: "remember that   INVOICE numbers use YYYY-001", language: "en-GB", history: [] });
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.body.data.duplicate, true);
    assert.equal(await prisma.assistantMemory.count(), 1);
    assert.ok(await prisma.auditLog.findFirst({ where: { actionName: "create_assistant_memory", result: "success" } }));
  });

  it("keeps personal memory private and protects company-wide memory", async () => {
    const companyMemory = await request(app)
      .post("/command/text")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ text: "remember for the company that approved invoice numbers use YYYY-001" });
    assert.equal(companyMemory.status, 201);
    assert.equal(companyMemory.body.data.scope, "company");

    const workerList = await request(app)
      .get("/memory-model/memories?status=active")
      .set("Authorization", `Bearer ${workerToken}`);
    assert.equal(workerList.status, 200);
    assert.deepEqual(workerList.body.map((memory: any) => memory.scope), ["company"]);

    const rejected = await request(app)
      .post("/command/text")
      .set("Authorization", `Bearer ${workerToken}`)
      .send({ text: "remember for the company that workers may replace invoice policy" });
    assert.equal(rejected.status, 403);
    assert.equal(rejected.body.error, "MISSING_PERMISSION");
  });

  it("returns bounded prior transcript context without treating it as permanent memory", async () => {
    const started = await request(app)
      .post("/command/voice-conversations")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ mode: "realtime" });
    const conversationId = started.body.id;
    await request(app)
      .post(`/command/voice-conversations/${conversationId}/messages`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ role: "user", content: "Yesterday we discussed the Smith quote.", sequence: 1 })
      .expect(201);
    await request(app)
      .post(`/command/voice-conversations/${conversationId}/messages`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ role: "assistant", content: "I will continue from that context next time.", sequence: 2 })
      .expect(201);
    await request(app)
      .post(`/command/voice-conversations/${conversationId}/end`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ status: "completed" })
      .expect(204);

    const context = await request(app)
      .get("/command/assistant-context")
      .set("Authorization", `Bearer ${adminToken}`);
    assert.equal(context.status, 200);
    assert.equal(context.body.recentConversations[0].id, conversationId);
    assert.deepEqual(context.body.recentConversations[0].messages.map((message: any) => message.role), ["user", "assistant"]);
    assert.equal(context.body.persistentMemories.length, 2);
    assert.equal(await prisma.assistantMemory.count(), 2, "conversation text must not be promoted into permanent memory");
  });

  it("recalls a saved rule and keeps it after transcript history is cleared", async () => {
    const recalled = await request(app)
      .post("/command/text")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ text: "what do you remember about invoice numbers?" });
    assert.equal(recalled.status, 200);
    assert.equal(recalled.body.intent, "recall_assistant_memory");
    assert.equal(recalled.body.data.length, 2);

    await request(app)
      .delete("/command/voice-state/history")
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);
    assert.equal(await prisma.voiceConversation.count(), 0);
    assert.equal(await prisma.assistantMemory.count(), 2);
  });

  it("archives a personal memory so it remains visible but leaves active context", async () => {
    const list = await request(app)
      .get("/memory-model/memories?status=active")
      .set("Authorization", `Bearer ${adminToken}`);
    const personal = list.body.find((memory: any) => memory.scope === "personal");
    assert.ok(personal);

    await request(app)
      .post(`/memory-model/memories/${personal.id}/archive`)
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);

    const all = await request(app)
      .get("/memory-model/memories?status=all")
      .set("Authorization", `Bearer ${adminToken}`);
    assert.equal(all.body.find((memory: any) => memory.id === personal.id).status, "archived");
    const context = await request(app)
      .get("/command/assistant-context")
      .set("Authorization", `Bearer ${adminToken}`);
    assert.equal(context.body.persistentMemories.some((memory: any) => memory.id === personal.id), false);
  });
});
