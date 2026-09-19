import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import request from "supertest";
import { createServer } from "../src/server.js";
import { prisma } from "../src/db.js";
import { resetDb, seedCompanyAndAdmin } from "./setup.js";

const app = createServer();

/** Smallest buffer the route accepts as a WAV. */
function wav(): Buffer {
  const buffer = Buffer.alloc(64);
  buffer.write("RIFF", 0, "ascii");
  buffer.write("WAVE", 8, "ascii");
  return buffer;
}

describe("Voice language changes apply immediately", () => {
  let token: string;
  const realFetch = globalThis.fetch;

  before(async () => {
    await resetDb();
    await seedCompanyAndAdmin();
    const login = await request(app).post("/auth/login").send({ email: "admin@test.local", password: "Password123!" });
    token = login.body.token;
    process.env.OPENAI_API_KEY = "test-key";
  });

  after(async () => {
    globalThis.fetch = realFetch;
    await prisma.$disconnect();
  });

  async function transcribeAndCaptureLanguage(): Promise<string> {
    let seen = "";
    globalThis.fetch = (async (_url: unknown, init: { body?: unknown }) => {
      seen = String((init?.body as FormData).get("language"));
      return new Response(JSON.stringify({ text: "Emma, ukaž klienty" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const res = await request(app)
      .post("/command/transcribe?wake_word=Emma")
      .set("Authorization", `Bearer ${token}`)
      .set("Content-Type", "audio/wav")
      .send(wav());
    assert.equal(res.status, 200);
    return seen;
  }

  it("uses the language stored on the account, not the one in the token", async () => {
    const admin = await prisma.user.findFirstOrThrow({ where: { email: "admin@test.local" } });

    await prisma.user.update({ where: { id: admin.id }, data: { voiceLanguage: "cs-CZ" } });
    assert.equal(await transcribeAndCaptureLanguage(), "cs");

    // Same token throughout: it still carries the language from sign-in. If the
    // route read the token, this would keep saying "cs" and the user would have
    // to sign in again for every language change.
    await prisma.user.update({ where: { id: admin.id }, data: { voiceLanguage: "pl-PL" } });
    assert.equal(await transcribeAndCaptureLanguage(), "pl");

    await prisma.user.update({ where: { id: admin.id }, data: { voiceLanguage: "en-GB" } });
    assert.equal(await transcribeAndCaptureLanguage(), "en");
  });
});
