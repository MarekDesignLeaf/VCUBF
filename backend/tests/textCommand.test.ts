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

  it("assigns a job to an employee via a text command, resolving both by name", async () => {
    const res = await request(app)
      .post("/command/text")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ text: "assign job Fence repair to Test Admin" });
    assert.equal(res.status, 200);
    assert.equal(res.body.intent, "assign_job");
    assert.equal(res.body.ok, true);
    assert.equal(res.body.data.job.jobTitle, "Fence repair");
  });

  it("returns EMPLOYEE_NOT_FOUND when assigning to an unknown employee name", async () => {
    const res = await request(app)
      .post("/command/text")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ text: "assign job Fence repair to Nobody Here" });
    assert.equal(res.status, 404);
    assert.equal(res.body.error, "EMPLOYEE_NOT_FOUND");
  });

  it("detects overload via a text command", async () => {
    const res = await request(app)
      .post("/command/text")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ text: "show overload" });
    assert.equal(res.status, 200);
    assert.equal(res.body.intent, "detect_overload");
    assert.ok(Array.isArray(res.body.data.overloadedWeeks));
  });

  it("creates a service catalogue item via a text command", async () => {
    const res = await request(app)
      .post("/command/text")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ text: "create service Gutter cleaning, category Roofing" });
    assert.equal(res.status, 201);
    assert.equal(res.body.intent, "create_service");
    assert.equal(res.body.data.name, "Gutter cleaning");
    assert.equal(res.body.data.category, "Roofing");
  });

  it("lists quotes for a specific client via a text command", async () => {
    const clientRes = await request(app)
      .post("/crm/clients")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ display_name: "Text Command Quote Client" });
    const clientId = clientRes.body.id;
    await request(app)
      .post("/quotes")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        client_id: clientId,
        title: "Voice quote",
        items: [{ description: "Job", unit_price: 100, unit_cost: 60 }],
      });

    const res = await request(app)
      .post("/command/text")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ text: "list quotes for Text Command Quote Client" });
    assert.equal(res.status, 200);
    assert.equal(res.body.intent, "list_quotes");
    assert.ok(res.body.data.length >= 1);
    assert.ok(res.body.data.every((q: any) => q.clientId === clientId));
  });

  it("returns AMBIGUOUS_REFERENCE when 'list quotes for X' matches multiple clients", async () => {
    await request(app)
      .post("/crm/clients")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ display_name: "Ambiguous Quote Co" });
    await request(app)
      .post("/crm/clients")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ display_name: "Ambiguous Quote Co Ltd" });

    const res = await request(app)
      .post("/command/text")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ text: "list quotes for Ambiguous Quote Co" });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, "AMBIGUOUS_REFERENCE");
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
