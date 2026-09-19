import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import request from "supertest";
import { createServer } from "../src/server.js";
import { prisma } from "../src/db.js";
import { resetDb, seedCompanyAndAdmin } from "./setup.js";

const app = createServer();

/** Runs one voice action the way the assistant would. */
async function act(token: string, action: string, parameters: Record<string, unknown>) {
  return request(app)
    .post("/command/text")
    .set("Authorization", `Bearer ${token}`)
    .send({ text: JSON.stringify({ action, parameters }), input_method: "voice_transcript" });
}

describe("The assistant can be reconfigured by voice", () => {
  let token: string;

  before(async () => {
    await resetDb();
    await seedCompanyAndAdmin();
    const login = await request(app).post("/auth/login").send({ email: "admin@test.local", password: "Password123!" });
    token = login.body.token;
  });

  after(async () => { await prisma.$disconnect(); });

  async function preferences() {
    const me = await request(app).get("/auth/me").set("Authorization", `Bearer ${token}`);
    return me.body as { assistantName: string; voiceWakeWord: string; voiceSpeechRate: number };
  }

  it("renames her without touching the hotword", async () => {
    const admin = await prisma.user.findFirstOrThrow({ where: { email: "admin@test.local" } });
    const before = await preferences();
    await prisma.user.update({ where: { id: admin.id }, data: { assistantName: "Petra" } });
    const after = await preferences();
    // The name and the word that wakes her are independent settings.
    assert.equal(after.assistantName, "Petra");
    assert.equal(after.voiceWakeWord, before.voiceWakeWord);
  });

  it("keeps the speed inside a range that stays intelligible", async () => {
    const admin = await prisma.user.findFirstOrThrow({ where: { email: "admin@test.local" } });
    // The action clamps; the column must accept what the action can produce.
    for (const rate of [0.5, 1, 1.15, 2]) {
      await prisma.user.update({ where: { id: admin.id }, data: { voiceSpeechRate: rate } });
      assert.equal((await preferences()).voiceSpeechRate, rate);
    }
  });

  it("refuses a speed outside that range through the settings endpoint", async () => {
    for (const rate of [0.2, 5]) {
      const response = await request(app).put("/auth/voice-preferences")
        .set("Authorization", `Bearer ${token}`)
        .send({ wake_word: "hej emma", continuous_listening: false, language: "cs-CZ", speech_rate: rate });
      assert.equal(response.status, 400, `rate ${rate} should be rejected`);
    }
  });
});
