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
        .send({ email: "blocked@test.local", password: "wrong" });
      assert.equal(res.status, 401);
      assert.equal(res.body.error, "INVALID_CREDENTIALS");
    }
    const blocked = await request(app)
      .post("/auth/login")
      .send({ email: "blocked@test.local", password: "wrong" });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.error, "TOO_MANY_LOGIN_ATTEMPTS");
    assert.ok(blocked.headers["ratelimit"]);
  });

  it("returns 401 for /auth/me without a token", async () => {
    const res = await request(app).get("/auth/me");
    assert.equal(res.status, 401);
  });

  it("requires authentication to change a password", async () => {
    const res = await request(app).post("/auth/change-password").send({ current_password: "Password123!", new_password: "AValidPassword456" });
    assert.equal(res.status, 401);
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
