import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import request from "supertest";
import { prisma } from "../src/db.js";
import { createServer } from "../src/server.js";
import { resetDb, seedCompanyAndAdmin } from "./setup.js";

const app = createServer();

describe("Emma notification deletion", () => {
  let token: string;
  let communicationId: string;

  before(async () => {
    await resetDb();
    await seedCompanyAndAdmin();
    const login = await request(app).post("/auth/login").send({ email: "admin@test.local", password: "Password123!" });
    token = login.body.token;

    const client = await request(app)
      .post("/crm/clients")
      .set("Authorization", `Bearer ${token}`)
      .send({ display_name: "Voice Notification Client" });
    const communication = await request(app)
      .post("/communications")
      .set("Authorization", `Bearer ${token}`)
      .send({
        client_id: client.body.id,
        channel: "phone_call",
        direction: "outbound",
        summary: "Voice notification test",
        occurred_at: new Date("2026-01-01T09:00:00.000Z").toISOString(),
        follow_up_needed: true,
        follow_up_due_at: new Date("2026-01-02T09:00:00.000Z").toISOString(),
      });
    communicationId = communication.body.id;
  });

  after(async () => {
    await resetDb();
    await prisma.$disconnect();
  });

  it("does not act on Polish while Czech is switched on", async () => {
    await prisma.user.update({ where: { email: "admin@test.local" }, data: { voiceLanguage: "cs-CZ" } });
    // Only the Czech grammar reads the sentence, and it is not Czech.
    const typed = await request(app)
      .post("/command/text")
      .set("Authorization", `Bearer ${token}`)
      .send({ text: "usuń wszystkie powiadomienia", input_method: "voice_transcript" });
    assert.equal(typed.body.intent, "unrecognized");
    assert.match(typed.body.message, /^Tomu příkazu nerozumím\./, "said in Czech, with a Czech example");
    assert.equal(await prisma.voicePendingAction.count({ where: { actionType: "delete_all_notifications" } }), 0, "nothing was prepared");

    // The language model is told which language is on and to act on no other.
    const previousKey = process.env.OPENAI_API_KEY;
    const previousFetch = globalThis.fetch;
    let instructions = "";
    process.env.OPENAI_API_KEY = "test-key";
    globalThis.fetch = async (_input, init) => {
      instructions = JSON.parse(String(init?.body)).instructions;
      return Response.json({ output: [{ content: [{ text: JSON.stringify({ kind: "reply", canonical_command: null, message: "Teď mluvím česky." }) }] }] });
    };
    try {
      const spoken = await request(app)
        .post("/command/assistant")
        .set("Authorization", `Bearer ${token}`)
        .send({ text: "usuń wszystkie powiadomienia", input_method: "voice_transcript", history: [] });
      assert.equal(spoken.body.actionExecuted, false);
      assert.match(instructions, /The language switched on is Czech\. Act only on what the user says in Czech\./);
    } finally {
      globalThis.fetch = previousFetch;
      if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousKey;
    }
    assert.equal(await prisma.voicePendingAction.count({ where: { actionType: "delete_all_notifications" } }), 0);
  });

  it("previews Polish voice deletion once Polish is switched on, waits for confirmation, then hides only reviewed notifications", async () => {
    await prisma.user.update({ where: { email: "admin@test.local" }, data: { voiceLanguage: "pl-PL" } });
    const beforeFeed = await request(app).get("/notifications").set("Authorization", `Bearer ${token}`);
    const reviewedKeys = beforeFeed.body.map((item: { key: string }) => item.key);
    assert.ok(reviewedKeys.includes(`follow_up:${communicationId}`));

    const preview = await request(app)
      .post("/command/text")
      .set("Authorization", `Bearer ${token}`)
      .send({ text: "usuń wszystkie powiadomienia", input_method: "voice_transcript" });
    assert.equal(preview.status, 202);
    assert.equal(preview.body.intent, "prepare_delete_notifications");
    assert.equal(preview.body.data.confirmationRequired, true);
    assert.equal(preview.body.data.preview.count, reviewedKeys.length);

    const unchanged = await request(app).get("/notifications").set("Authorization", `Bearer ${token}`);
    assert.equal(unchanged.body.length, reviewedKeys.length);

    const confirmed = await request(app)
      .post("/command/text")
      .set("Authorization", `Bearer ${token}`)
      .send({ text: "potwierdzam", input_method: "voice_transcript" });
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.body.intent, "confirm_delete_notifications");
    assert.equal(confirmed.body.data.deletedCount, reviewedKeys.length);
    assert.equal(confirmed.body.data.underlyingRecordsChanged, false);

    const hidden = await request(app).get("/notifications").set("Authorization", `Bearer ${token}`);
    assert.equal(hidden.body.length, 0);
    const source = await request(app).get(`/communications/${communicationId}`).set("Authorization", `Bearer ${token}`);
    assert.equal(source.body.followUpNeeded, true);

    const pending = await prisma.voicePendingAction.findFirstOrThrow({
      where: { actionType: "delete_all_notifications" },
      orderBy: { createdAt: "desc" },
    });
    assert.equal(pending.status, "completed");
    assert.equal(pending.payload, null);
    await prisma.user.update({ where: { email: "admin@test.local" }, data: { voiceLanguage: "en-GB" } });
  });

  it("supports deleting and restoring one notification through the UI API", async () => {
    const key = `follow_up:${communicationId}`;
    const restore = await request(app)
      .post(`/notifications/${encodeURIComponent(key)}/unacknowledge`)
      .set("Authorization", `Bearer ${token}`);
    assert.equal(restore.status, 200);

    const deletion = await request(app)
      .delete(`/notifications/${encodeURIComponent(key)}`)
      .set("Authorization", `Bearer ${token}`);
    assert.equal(deletion.status, 200);
    assert.equal(deletion.body.deleted, true);
    assert.equal(deletion.body.reversible, true);

    const hidden = await request(app).get("/notifications").set("Authorization", `Bearer ${token}`);
    assert.ok(!hidden.body.some((item: { key: string }) => item.key === key));
  });
});
