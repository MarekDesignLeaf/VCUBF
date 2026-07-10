import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import request from "supertest";
import bcrypt from "bcryptjs";
import { createServer } from "../src/server.js";
import { prisma } from "../src/db.js";
import { resetDb, seedCompanyAndAdmin } from "./setup.js";

const app = createServer();

async function loginAs(email: string) {
  const res = await request(app).post("/auth/login").send({ email, password: "Password123!" });
  return res.body.token as string;
}

describe("Communication Log Module", () => {
  let adminToken: string;
  let workerToken: string;
  let clientId: string;
  let jobId: string;

  before(async () => {
    await resetDb();
    await seedCompanyAndAdmin();
    adminToken = await loginAs("admin@test.local");
    workerToken = await loginAs("worker@test.local");

    const clientRes = await request(app)
      .post("/crm/clients")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ display_name: "Riverside Apartments Ltd", email_primary: "riverside@example.com" });
    clientId = clientRes.body.id;

    const jobRes = await request(app)
      .post("/crm/jobs")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ client_id: clientId, job_title: "Kitchen refit" });
    jobId = jobRes.body.id;
  });

  after(async () => {
    await resetDb();
    await prisma.$disconnect();
  });

  it("rejects logging a communication without crm.manage permission (403)", async () => {
    const res = await request(app)
      .post("/communications")
      .set("Authorization", `Bearer ${workerToken}`)
      .send({
        client_id: clientId,
        channel: "phone_call",
        direction: "outbound",
        summary: "Called to confirm start date",
        occurred_at: new Date().toISOString(),
      });
    assert.equal(res.status, 403);
  });

  it("validates required fields", async () => {
    const res = await request(app)
      .post("/communications")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ client_id: clientId, channel: "email" });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "VALIDATION_FAILED");
  });

  it("returns CLIENT_NOT_FOUND for an unknown client id", async () => {
    const res = await request(app)
      .post("/communications")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        client_id: "00000000-0000-0000-0000-000000000099",
        channel: "email",
        direction: "outbound",
        summary: "Sent a quote",
        occurred_at: new Date().toISOString(),
      });
    assert.equal(res.status, 404);
    assert.equal(res.body.error, "CLIENT_NOT_FOUND");
  });

  it("returns JOB_NOT_FOUND for an unknown job id", async () => {
    const res = await request(app)
      .post("/communications")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        client_id: clientId,
        job_id: "00000000-0000-0000-0000-000000000099",
        channel: "email",
        direction: "outbound",
        summary: "Sent a quote",
        occurred_at: new Date().toISOString(),
      });
    assert.equal(res.status, 404);
    assert.equal(res.body.error, "JOB_NOT_FOUND");
  });

  let recordId: string;

  it("creates a communication record from real, user-entered data and records an audit entry", async () => {
    const occurredAt = new Date("2026-07-08T10:00:00.000Z").toISOString();
    const res = await request(app)
      .post("/communications")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        client_id: clientId,
        job_id: jobId,
        channel: "phone_call",
        direction: "outbound",
        summary: "Discussed timeline, promised a written quote by Friday",
        full_text: "Full call notes go here.",
        occurred_at: occurredAt,
        follow_up_needed: true,
        follow_up_due_at: new Date("2026-07-09T09:00:00.000Z").toISOString(),
      });
    assert.equal(res.status, 201);
    assert.equal(res.body.channel, "phone_call");
    assert.equal(res.body.direction, "outbound");
    assert.equal(res.body.followUpNeeded, true);
    assert.equal(res.body.client.id, clientId);
    recordId = res.body.id;

    const audit = await prisma.auditLog.findFirst({ where: { actionName: "log_communication", result: "success" } });
    assert.ok(audit);
    assert.equal((audit?.dataAfter as any)?.id, recordId);
  });

  it("gets a single communication record", async () => {
    const res = await request(app)
      .get(`/communications/${recordId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.id, recordId);
  });

  it("returns COMMUNICATION_RECORD_NOT_FOUND for a get on a nonexistent record", async () => {
    const res = await request(app)
      .get("/communications/00000000-0000-0000-0000-000000000099")
      .set("Authorization", `Bearer ${adminToken}`);
    assert.equal(res.status, 404);
    assert.equal(res.body.error, "COMMUNICATION_RECORD_NOT_FOUND");
  });

  it("lists communications and can filter by client, job, channel and followUpNeeded", async () => {
    // A second record, different channel, no follow-up, to exercise filters.
    await request(app)
      .post("/communications")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        client_id: clientId,
        channel: "email",
        direction: "inbound",
        summary: "Client emailed asking about materials",
        occurred_at: new Date("2026-07-09T08:00:00.000Z").toISOString(),
      });

    const all = await request(app).get("/communications").set("Authorization", `Bearer ${adminToken}`);
    assert.equal(all.status, 200);
    assert.ok(all.body.length >= 2);

    const byClient = await request(app)
      .get(`/communications?client_id=${clientId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    assert.ok(byClient.body.every((r: any) => r.client.id === clientId));

    const byJob = await request(app)
      .get(`/communications?job_id=${jobId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    assert.equal(byJob.body.length, 1);
    assert.equal(byJob.body[0].id, recordId);

    const byChannel = await request(app)
      .get("/communications?channel=email")
      .set("Authorization", `Bearer ${adminToken}`);
    assert.ok(byChannel.body.every((r: any) => r.channel === "email"));

    const byFollowUp = await request(app)
      .get("/communications?follow_up_needed=true")
      .set("Authorization", `Bearer ${adminToken}`);
    assert.ok(byFollowUp.body.every((r: any) => r.followUpNeeded === true));
    assert.equal(byFollowUp.body[0].id, recordId);
  });

  it("lists follow-ups due (past-due or no due date), company-scoped", async () => {
    const res = await request(app).get("/communications/follow-ups-due").set("Authorization", `Bearer ${adminToken}`);
    assert.equal(res.status, 200);
    assert.ok(res.body.some((r: any) => r.id === recordId));
  });

  it("updates a communication record and records before/after in the audit log", async () => {
    const res = await request(app)
      .put(`/communications/${recordId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ follow_up_needed: false, summary: "Quote sent — no further follow-up needed" });
    assert.equal(res.status, 200);
    assert.equal(res.body.followUpNeeded, false);
    assert.equal(res.body.summary, "Quote sent — no further follow-up needed");

    const audit = await prisma.auditLog.findFirst({
      where: { actionName: "update_communication_record", result: "success" },
      orderBy: { createdAt: "desc" },
    });
    assert.equal((audit?.dataBefore as any)?.followUpNeeded, true);
    assert.equal((audit?.dataAfter as any)?.followUpNeeded, false);
  });

  it("rejects invalid update input", async () => {
    const res = await request(app)
      .put(`/communications/${recordId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ channel: "carrier_pigeon" });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "VALIDATION_FAILED");
  });

  it("returns COMMUNICATION_RECORD_NOT_FOUND for an update to a nonexistent record", async () => {
    const res = await request(app)
      .put("/communications/00000000-0000-0000-0000-000000000099")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ summary: "x" });
    assert.equal(res.status, 404);
    assert.equal(res.body.error, "COMMUNICATION_RECORD_NOT_FOUND");
  });

  it("never shows a company B record to company A, and company A cannot update it", async () => {
    const companyB = await prisma.company.create({ data: { name: "Other Co" } });
    const passwordHash = await bcrypt.hash("Password123!", 10);
    await prisma.user.create({
      data: {
        companyId: companyB.id,
        email: "admin-b@test.local",
        passwordHash,
        displayName: "Other Admin",
        role: "admin",
        permissions: ["crm.read", "crm.manage"],
      },
    });
    const clientB = await prisma.client.create({
      data: { companyId: companyB.id, displayName: "Other Co Client" },
    });
    const tokenB = await loginAs("admin-b@test.local");

    const createRes = await request(app)
      .post("/communications")
      .set("Authorization", `Bearer ${tokenB}`)
      .send({
        client_id: clientB.id,
        channel: "email",
        direction: "outbound",
        summary: "Company B's own communication",
        occurred_at: new Date().toISOString(),
      });
    assert.equal(createRes.status, 201);
    const recordBId = createRes.body.id;

    // Company A cannot see company B's record.
    const getAsA = await request(app)
      .get(`/communications/${recordBId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    assert.equal(getAsA.status, 404);

    // Company A cannot update company B's record.
    const updateAsA = await request(app)
      .put(`/communications/${recordBId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ summary: "hijacked" });
    assert.equal(updateAsA.status, 404);

    // Company A's list never includes company B's record.
    const listAsA = await request(app).get("/communications").set("Authorization", `Bearer ${adminToken}`);
    assert.ok(!listAsA.body.some((r: any) => r.id === recordBId));

    // Company A cannot log a communication against company B's client.
    const crossClientRes = await request(app)
      .post("/communications")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        client_id: clientB.id,
        channel: "email",
        direction: "outbound",
        summary: "Should not be allowed",
        occurred_at: new Date().toISOString(),
      });
    assert.equal(crossClientRes.status, 404);
    assert.equal(crossClientRes.body.error, "CLIENT_NOT_FOUND");
  });
});
