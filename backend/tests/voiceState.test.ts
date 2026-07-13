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
    const updated = await request(app).put("/command/voice-state").set("Authorization", `Bearer ${token}`).send({ status: "hearing", mode: "realtime", listening: true, last_transcript: "show my jobs" });
    assert.equal(updated.status, 200); assert.equal(updated.body.lastTranscript, "show my jobs");
    const control = await request(app).post("/command/voice-state/control").set("Authorization", `Bearer ${token}`).send({ control: "pause" });
    assert.equal(control.status, 202); assert.equal(control.body.pendingControl, "pause");
    const ack = await request(app).put("/command/voice-state").set("Authorization", `Bearer ${token}`).send({ status: "paused", mode: "wake_word", listening: false, ack_control: "pause" });
    assert.equal(ack.body.pendingControl, null); assert.equal(ack.body.status, "paused");
    const cleared = await request(app).delete("/command/voice-state/history").set("Authorization", `Bearer ${token}`);
    assert.equal(cleared.status, 200); assert.equal(cleared.body.lastTranscript, null);
    const audit = await prisma.auditLog.findFirst({ where: { actionName: "control_voice_device", interpretedIntent: "pause" } });
    assert.ok(audit);
    assert.ok(await prisma.auditLog.findFirst({ where: { actionName: "clear_voice_device_history" } }));
  });
});
