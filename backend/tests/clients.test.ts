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

  it("rejects invalid email and invalid phone values", async () => {
    const invalidEmail = await request(app)
      .post("/crm/clients")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ display_name: "Bad Email", email_primary: "not-an-email" });
    assert.equal(invalidEmail.status, 400);
    assert.equal(invalidEmail.body.error, "VALIDATION_FAILED");
    assert.deepEqual(invalidEmail.body.invalidFields, ["email_primary"]);
    assert.match(invalidEmail.body.message, /Bad Email was not created/i);

    const invalidPhone = await request(app)
      .post("/crm/clients")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ display_name: "Bad Phone", phone_primary: "123" });
    assert.equal(invalidPhone.status, 400);
    assert.equal(invalidPhone.body.error, "VALIDATION_FAILED");
    assert.deepEqual(invalidPhone.body.invalidFields, ["phone_primary"]);
    assert.match(invalidPhone.body.message, /Bad Phone was not created/i);
    assert.equal(await prisma.client.count({ where: { displayName: { in: ["Bad Email", "Bad Phone"] } } }), 0);
  });

  it("rejects assigning an application user's email to a client", async () => {
    const res = await request(app)
      .post("/crm/clients")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ display_name: "Wrong Identity", email_primary: "ADMIN@test.local" });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, "EMAIL_BELONGS_TO_USER");
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

  it("updates a client through the validated service", async () => {
    const existing = await prisma.client.findFirstOrThrow({ where: { displayName: "Jane Smith" } });
    const res = await request(app)
      .put(`/crm/clients/${existing.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ display_name: "Jane Brown", email_primary: "JANE.BROWN@EXAMPLE.COM", phone_primary: "+44 7700 900003" });
    assert.equal(res.status, 200);
    assert.equal(res.body.displayName, "Jane Brown");
    assert.equal(res.body.emailPrimary, "jane.brown@example.com");
    assert.equal(res.body.phonePrimary, "+447700900003");
  });

  it("requires confirmation to archive a client and preserves the database row", async () => {
    const existing = await prisma.client.findFirstOrThrow({ where: { displayName: "Jane Brown" } });
    const preview = await request(app)
      .delete(`/crm/clients/${existing.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ confirmed: false });
    assert.equal(preview.status, 409);
    assert.equal(preview.body.error, "CONFIRMATION_REQUIRED");
    assert.equal((await prisma.client.findUniqueOrThrow({ where: { id: existing.id } })).isActive, true);

    const confirmed = await request(app)
      .delete(`/crm/clients/${existing.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ confirmed: true });
    assert.equal(confirmed.status, 200);
    assert.equal((await prisma.client.findUniqueOrThrow({ where: { id: existing.id } })).isActive, false);

    const activeList = await request(app).get("/crm/clients").set("Authorization", `Bearer ${adminToken}`);
    assert.equal(activeList.body.some((client: { id: string }) => client.id === existing.id), false);
  });
});
