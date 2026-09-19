import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import request from "supertest";
import { createServer } from "../src/server.js";
import { prisma } from "../src/db.js";
import { resetDb, seedCompanyAndAdmin } from "./setup.js";
import { parseTextCommand } from "../src/lib/commandParser.js";

const app = createServer();

describe("Changing how fast she talks", () => {
  let token: string;

  before(async () => {
    await resetDb();
    await seedCompanyAndAdmin();
    const login = await request(app).post("/auth/login").send({ email: "admin@test.local", password: "Password123!" });
    token = login.body.token;
  });

  after(async () => { await prisma.$disconnect(); });

  // Recognised without a model round trip: adjusting her own voice is one word,
  // and making it depend on a round trip is how it came to do nothing at all.
  for (const [phrase, change] of [
    ["mluv rychleji", "faster"],
    ["rychleji", "faster"],
    ["zrychli", "faster"],
    ["mluv pomaleji", "slower"],
    ["zpomal", "slower"],
    ["speak faster", "faster"],
    ["slow down", "slower"],
    ["mluv normálně", "normal"],
  ] as const) {
    it(`understands "${phrase}"`, () => {
      const parsed = parseTextCommand(phrase);
      assert.equal(parsed.intent, "set_speech_rate");
      assert.equal((parsed.entities as { change?: string }).change, change);
    });
  }

  it("understands an explicit number and a percentage", () => {
    assert.equal((parseTextCommand("nastav rychlost 1.4").entities as { rate?: number }).rate, 1.4);
    // Said as a percentage rather than a multiplier.
    assert.equal((parseTextCommand("rychlost 130").entities as { rate?: number }).rate, 1.3);
  });

  it("does not mistake ordinary speech for a speed change", () => {
    for (const phrase of ["ukaž klienty", "vytvoř zakázku pro Nováka", "kolik mám faktur"]) {
      assert.notEqual(parseTextCommand(phrase).intent, "set_speech_rate", phrase);
    }
  });

  async function say(text: string) {
    const response = await request(app).post("/command/text")
      .set("Authorization", `Bearer ${token}`)
      .send({ text, input_method: "voice_transcript" });
    return response.body as { ok: boolean; message?: string; data?: { percent?: number; voiceSpeechRate?: number } };
  }

  it("speeds up and says what the value now is", async () => {
    const result = await say("mluv rychleji");
    assert.equal(result.ok, true);
    // A number the user cannot see is not one they can steer, so the value has to
    // be in what she says — in whatever language she is speaking.
    assert.equal(result.data?.percent, 130);
    assert.match(result.message ?? "", /130/);
  });

  it("says when it cannot go any faster, rather than doing nothing", async () => {
    for (let i = 0; i < 10; i += 1) await say("rychleji");
    const result = await say("rychleji");
    assert.equal(result.data?.voiceSpeechRate, 2);
    assert.match(result.message ?? "", /as fast as I go/i);
  });

  it("returns to normal on request", async () => {
    const result = await say("mluv normálně");
    assert.equal(result.data?.voiceSpeechRate, 1);
    assert.equal(result.data?.percent, 100);
  });

  it("says when it cannot go any slower", async () => {
    for (let i = 0; i < 10; i += 1) await say("pomaleji");
    const result = await say("pomaleji");
    assert.equal(result.data?.voiceSpeechRate, 0.5);
    assert.match(result.message ?? "", /as slow as I go/i);
  });

  it("says the value in Czech to a Czech-speaking user", async () => {
    const admin = await prisma.user.findFirstOrThrow({ where: { email: "admin@test.local" } });
    await prisma.user.update({ where: { id: admin.id }, data: { voiceLanguage: "cs-CZ", voiceSpeechRate: 1 } });
    const result = await say("mluv rychleji");
    assert.match(result.message ?? "", /procent/i);
    assert.match(result.message ?? "", /115/);
    // The range is stated too, so "faster" has a frame of reference.
    assert.match(result.message ?? "", /Rozsah/i);
  });
});
