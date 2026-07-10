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

describe("crm/leads", () => {
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

  it("rejects creating a lead without crm.manage permission (403)", async () => {
    const res = await request(app)
      .post("/crm/leads")
      .set("Authorization", `Bearer ${workerToken}`)
      .send({ name: "Should fail" });
    assert.equal(res.status, 403);
  });

  it("rejects a lead with missing name (400)", async () => {
    const res = await request(app)
      .post("/crm/leads")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ phone: "07700900000" });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "VALIDATION_FAILED");
  });

  let leadId: string;

  it("creates a lead on the success path with default status 'new'", async () => {
    const res = await request(app)
      .post("/crm/leads")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Alice Green", email: "alice@example.com", service_requested: "fencing" });
    assert.equal(res.status, 201);
    assert.equal(res.body.leadStatus, "new");
    leadId = res.body.id;

    const audit = await prisma.auditLog.findFirst({
      where: { actionName: "create_lead", result: "success" },
      orderBy: { createdAt: "desc" },
    });
    assert.ok(audit);
  });

  it("lists leads", async () => {
    const res = await request(app).get("/crm/leads").set("Authorization", `Bearer ${adminToken}`);
    assert.equal(res.status, 200);
    assert.ok(res.body.some((l: { id: string }) => l.id === leadId));
  });

  it("returns 404 converting an unknown lead", async () => {
    const res = await request(app)
      .post("/crm/leads/00000000-0000-0000-0000-000000000099/convert")
      .set("Authorization", `Bearer ${adminToken}`);
    assert.equal(res.status, 404);
    assert.equal(res.body.error, "LEAD_NOT_FOUND");
  });

  it("converts a lead into a client and links them", async () => {
    const res = await request(app)
      .post(`/crm/leads/${leadId}/convert`)
      .set("Authorization", `Bearer ${adminToken}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.lead.leadStatus, "converted");
    assert.equal(res.body.lead.convertedClientId, res.body.client.id);
    assert.equal(res.body.client.emailPrimary, "alice@example.com");
    assert.equal(res.body.client.source, `lead:${leadId}`);

    const audit = await prisma.auditLog.findFirst({
      where: { actionName: "convert_lead_to_client", result: "success" },
      orderBy: { createdAt: "desc" },
    });
    assert.ok(audit);
  });

  it("rejects converting the same lead twice (409)", async () => {
    const res = await request(app)
      .post(`/crm/leads/${leadId}/convert`)
      .set("Authorization", `Bearer ${adminToken}`);
    assert.equal(res.status, 409);
    assert.equal(res.body.error, "UNSUPPORTED_ACTION");
  });

  it("reuses an existing client with the same email instead of creating a duplicate", async () => {
    const leadRes = await request(app)
      .post("/crm/leads")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Alice Green Again", email: "alice@example.com" });
    const secondLeadId = leadRes.body.id;

    const convertRes = await request(app)
      .post(`/crm/leads/${secondLeadId}/convert`)
      .set("Authorization", `Bearer ${adminToken}`);
    assert.equal(convertRes.status, 200);

    const firstConvert = await request(app)
      .get(`/crm/leads/${leadId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    assert.equal(convertRes.body.client.id, firstConvert.body.convertedClientId);
  });
});
