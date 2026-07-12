import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import request from "supertest";
import { createServer } from "../src/server.js";
import { prisma } from "../src/db.js";
import { resetDb, seedCompanyAndAdmin } from "./setup.js";

const app = createServer();

describe("auth", () => {
  before(async () => {
    await resetDb();
    await seedCompanyAndAdmin();
  });
  after(async () => {
    await resetDb();
    await prisma.$disconnect();
  });

  it("logs in with valid credentials", async () => {
    const res = await request(app)
      .post("/auth/login")
      .send({ email: "admin@test.local", password: "Password123!" });
    assert.equal(res.status, 200);
    assert.ok(res.body.token);
    assert.equal(res.body.user.email, "admin@test.local");
  });

  it("rejects invalid credentials", async () => {
    const res = await request(app)
      .post("/auth/login")
      .send({ email: "admin@test.local", password: "wrong" });
    assert.equal(res.status, 401);
    assert.equal(res.body.error, "INVALID_CREDENTIALS");
  });

  it("rejects malformed login payload", async () => {
    const res = await request(app).post("/auth/login").send({ email: "not-an-email" });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "VALIDATION_FAILED");
  });

  it("rate limits repeated failed login attempts without revealing account existence", async () => {
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      const res = await request(app)
        .post("/auth/login")
        .set("X-Forwarded-For", "203.0.113.10")
        .send({ email: "blocked@test.local", password: "wrong" });
      assert.equal(res.status, 401);
      assert.equal(res.body.error, "INVALID_CREDENTIALS");
    }
    const blocked = await request(app)
      .post("/auth/login")
      .set("X-Forwarded-For", "203.0.113.10")
      .send({ email: "blocked@test.local", password: "wrong" });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.error, "TOO_MANY_LOGIN_ATTEMPTS");
    assert.ok(blocked.headers["ratelimit"]);
    const otherNetwork = await request(app)
      .post("/auth/login")
      .set("X-Forwarded-For", "203.0.113.11")
      .send({ email: "blocked@test.local", password: "wrong" });
    assert.equal(otherNetwork.status, 401);
  });

  it("returns 401 for /auth/me without a token", async () => {
    const res = await request(app).get("/auth/me");
    assert.equal(res.status, 401);
  });

  it("requires authentication to change a password", async () => {
    const res = await request(app).post("/auth/change-password").send({ current_password: "Password123!", new_password: "AValidPassword456" });
    assert.equal(res.status, 401);
  });

  it("stores per-user wake-word and continuous-listening preferences", async () => {
    const login = await request(app).post("/auth/login").send({ email: "admin@test.local", password: "Password123!" });
    assert.equal(login.body.user.voiceWakeWord, "Emma");
    assert.equal(login.body.user.voiceContinuous, false);
    const updated = await request(app).put("/auth/voice-preferences").set("Authorization", `Bearer ${login.body.token}`).send({ wake_word: "Ema Assistant", continuous_listening: true, language: "en-US" });
    assert.equal(updated.status, 200);
    assert.deepEqual(updated.body, { voiceWakeWord: "Ema Assistant", voiceContinuous: true, voiceLanguage: "en-US" });
    const me = await request(app).get("/auth/me").set("Authorization", `Bearer ${login.body.token}`);
    assert.equal(me.body.voiceWakeWord, "Ema Assistant");
    const invalid = await request(app).put("/auth/voice-preferences").set("Authorization", `Bearer ${login.body.token}`).send({ wake_word: "!", continuous_listening: true, language: "cs-CZ" });
    assert.equal(invalid.status, 400);
    const audit = await prisma.auditLog.findFirst({ where: { actionName: "update_voice_preferences", userId: me.body.id }, orderBy: { createdAt: "desc" } });
    assert.equal((audit?.dataAfter as any)?.voiceWakeWord, "Ema Assistant");
  });

  it("pairs the Windows companion through a one-time browser approval", async () => {
    const started=await request(app).post("/auth/device/start").send({});
    assert.equal(started.status,201);assert.match(started.body.code,/^[A-Z2-9]{8}$/);assert.ok(started.body.secret);
    const pending=await request(app).post("/auth/device/token").send({pairing_id:started.body.pairing_id,secret:started.body.secret});assert.equal(pending.status,202);
    const wrong=await request(app).post("/auth/device/token").send({pairing_id:started.body.pairing_id,secret:"x".repeat(43)});assert.equal(wrong.status,401);
    const login=await request(app).post("/auth/login").send({email:"admin@test.local",password:"Password123!"});
    const approved=await request(app).post("/auth/device/approve").set("Authorization",`Bearer ${login.body.token}`).send({code:started.body.code});assert.equal(approved.status,200);
    const connected=await request(app).post("/auth/device/token").send({pairing_id:started.body.pairing_id,secret:started.body.secret});assert.equal(connected.status,200);assert.ok(connected.body.token);assert.equal(connected.body.user.email,"admin@test.local");
    const reused=await request(app).post("/auth/device/token").send({pairing_id:started.body.pairing_id,secret:started.body.secret});assert.equal(reused.status,409);assert.equal(reused.body.error,"PAIRING_ALREADY_USED");
    const audit=await prisma.auditLog.findFirst({where:{actionName:"approve_device_pairing"}});assert.equal(audit?.confirmed,true);
  });

  it("rejects a weak new password without storing password values in audit", async () => {
    const login = await request(app).post("/auth/login").send({ email: "admin@test.local", password: "Password123!" });
    const res = await request(app).post("/auth/change-password").set("Authorization", `Bearer ${login.body.token}`).send({ current_password: "Password123!", new_password: "short" });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "VALIDATION_FAILED");
    const audit = await prisma.auditLog.findFirst({ where: { actionName: "change_own_password", errorMessage: "VALIDATION_FAILED" }, orderBy: { createdAt: "desc" } });
    assert.deepEqual(audit?.inputPayload, { passwordFieldsRedacted: true });
  });

  it("rejects an incorrect current password", async () => {
    const login = await request(app).post("/auth/login").send({ email: "admin@test.local", password: "Password123!" });
    const res = await request(app).post("/auth/change-password").set("Authorization", `Bearer ${login.body.token}`).send({ current_password: "NotThePassword1", new_password: "AValidPassword456" });
    assert.equal(res.status, 401);
    assert.equal(res.body.error, "CURRENT_PASSWORD_INVALID");
  });

  it("changes the authenticated user's password, audits safely and invalidates the old credential", async () => {
    const login = await request(app).post("/auth/login").send({ email: "admin@test.local", password: "Password123!" });
    const changed = await request(app).post("/auth/change-password").set("Authorization", `Bearer ${login.body.token}`).send({ current_password: "Password123!", new_password: "AValidPassword456" });
    assert.equal(changed.status, 204);
    const oldSession = await request(app).get("/auth/me").set("Authorization", `Bearer ${login.body.token}`);
    assert.equal(oldSession.status, 401);
    const oldLogin = await request(app).post("/auth/login").send({ email: "admin@test.local", password: "Password123!" });
    assert.equal(oldLogin.status, 401);
    const newLogin = await request(app).post("/auth/login").send({ email: "admin@test.local", password: "AValidPassword456" });
    assert.equal(newLogin.status, 200);
    const newSession = await request(app).get("/auth/me").set("Authorization", `Bearer ${newLogin.body.token}`);
    assert.equal(newSession.status, 200);
    const audit = await prisma.auditLog.findFirst({ where: { actionName: "change_own_password", result: "success" }, orderBy: { createdAt: "desc" } });
    assert.deepEqual(audit?.inputPayload, { passwordFieldsRedacted: true });
    assert.deepEqual(audit?.dataAfter, { passwordChanged: true });
  });
});
