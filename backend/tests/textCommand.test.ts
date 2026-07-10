import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import request from "supertest";
import { createServer } from "../src/server.js";
import { prisma } from "../src/db.js";
import { resetDb, seedCompanyAndAdmin } from "./setup.js";

const app = createServer();

async function loginAs(email: string) {
  const res = await request(app).post("/auth/login").send({ email, password: "Password123!" });
  return res.body.token as string;
}

describe("command/text", () => {
  let adminToken: string;
  let workerToken: string;

  before(async () => {
    await resetDb();
    await seedCompanyAndAdmin();
    adminToken = await loginAs("admin@test.local");
    // worker has empty permissions in setup.ts — used for the permission-denied case.
    workerToken = await loginAs("worker@test.local");
  });
  after(async () => {
    await resetDb();
    await prisma.$disconnect();
  });

  it("rejects a command without voice.execute permission (403)", async () => {
    const res = await request(app)
      .post("/command/text")
      .set("Authorization", `Bearer ${workerToken}`)
      .send({ text: "list clients" });
    assert.equal(res.status, 403);
  });

  it("creates a client via a text command and audits it", async () => {
    const res = await request(app)
      .post("/command/text")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ text: "create client Command Client, email cmd@example.com" });
    assert.equal(res.status, 201);
    assert.equal(res.body.intent, "create_client");
    assert.equal(res.body.ok, true);
    assert.equal(res.body.data.displayName, "Command Client");

    const audit = await prisma.auditLog.findFirst({
      where: { actionName: "execute_text_command", result: "success" },
      orderBy: { createdAt: "desc" },
    });
    assert.ok(audit);
    assert.equal(audit?.interpretedIntent, "create_client");
  });

  it("creates a job via text command by resolving the client name", async () => {
    const res = await request(app)
      .post("/command/text")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ text: "create job Fence repair for Command Client" });
    assert.equal(res.status, 201);
    assert.equal(res.body.data.jobTitle, "Fence repair");
    assert.equal(res.body.data.jobStatus, "nova");
  });

  it("changes job status via text command with a human status word", async () => {
    const res = await request(app)
      .post("/command/text")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ text: "set job Fence repair as scheduled" });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.jobStatus, "naplanovano");
  });

  it("returns CLIENT_NOT_FOUND when the referenced client doesn't exist", async () => {
    const res = await request(app)
      .post("/command/text")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ text: "create job Something for Nonexistent Person" });
    assert.equal(res.status, 404);
    assert.equal(res.body.error, "CLIENT_NOT_FOUND");
  });

  it("returns AMBIGUOUS_REFERENCE when multiple clients match", async () => {
    await request(app)
      .post("/crm/clients")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ display_name: "Command Client Two" });

    const res = await request(app)
      .post("/command/text")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ text: "create job Painting for Command" });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, "AMBIGUOUS_REFERENCE");
  });

  it("returns UNSUPPORTED_ACTION for unrecognized text and audits the failure", async () => {
    const res = await request(app)
      .post("/command/text")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ text: "do something vague" });
    assert.equal(res.status, 422);
    assert.equal(res.body.error, "UNSUPPORTED_ACTION");

    const audit = await prisma.auditLog.findFirst({
      where: { actionName: "execute_text_command", result: "error" },
      orderBy: { createdAt: "desc" },
    });
    assert.ok(audit);
  });

  it("lists clients via a text command", async () => {
    const res = await request(app)
      .post("/command/text")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ text: "list clients" });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.data));
    assert.ok(res.body.data.length >= 1);
  });
});
