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

describe("crm/clients", () => {
  let adminToken: string;
  let workerToken: string;

  before(async () => {
    await resetDb();
    await seedCompanyAndAdmin();
    adminToken = await loginAs("admin@test.local");
    workerToken = await loginAs("worker@test.local");
  });
  after(async () => {
    await resetDb();
    await prisma.$disconnect();
  });

  it("rejects creating a client without a token (401)", async () => {
    const res = await request(app).post("/crm/clients").send({ display_name: "No Auth" });
    assert.equal(res.status, 401);
  });

  it("rejects creating a client without crm.manage permission (403)", async () => {
    const res = await request(app)
      .post("/crm/clients")
      .set("Authorization", `Bearer ${workerToken}`)
      .send({ display_name: "Should Fail" });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, "MISSING_PERMISSION");
  });

  it("rejects a client with missing display_name (400)", async () => {
    const res = await request(app)
      .post("/crm/clients")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ email_primary: "no-name@example.com" });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "VALIDATION_FAILED");
  });

  it("creates a client on the success path and writes an audit entry", async () => {
    const res = await request(app)
      .post("/crm/clients")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ display_name: "Jane Smith", email_primary: "jane@example.com", phone_primary: "07700900000" });
    assert.equal(res.status, 201);
    assert.equal(res.body.display_name ?? res.body.displayName, "Jane Smith");

    const audit = await prisma.auditLog.findFirst({
      where: { actionName: "create_client", result: "success" },
      orderBy: { createdAt: "desc" },
    });
    assert.ok(audit, "expected an audit log entry for create_client");
    assert.equal(audit?.riskLevel, 2);
  });

  it("detects a duplicate client by email (409) and logs a rejected audit entry", async () => {
    const res = await request(app)
      .post("/crm/clients")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ display_name: "Jane Smith Again", email_primary: "jane@example.com" });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, "DUPLICATE_CLIENT_POSSIBLE");

    const audit = await prisma.auditLog.findFirst({
      where: { actionName: "create_client", result: "rejected" },
      orderBy: { createdAt: "desc" },
    });
    assert.ok(audit, "expected a rejected audit log entry for the duplicate attempt");
  });

  it("lists clients for the company", async () => {
    const res = await request(app).get("/crm/clients").set("Authorization", `Bearer ${adminToken}`);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body));
    assert.ok(res.body.length >= 1);
  });
});
