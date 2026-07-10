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

  it("returns 401 for /auth/me without a token", async () => {
    const res = await request(app).get("/auth/me");
    assert.equal(res.status, 401);
  });
});
