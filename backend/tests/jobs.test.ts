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

describe("crm/jobs", () => {
  let adminToken: string;
  let workerToken: string;
  let clientId: string;

  before(async () => {
    await resetDb();
    await seedCompanyAndAdmin();
    adminToken = await loginAs("admin@test.local");
    workerToken = await loginAs("worker@test.local");

    const clientRes = await request(app)
      .post("/crm/clients")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ display_name: "Job Test Client" });
    clientId = clientRes.body.id;
  });
  after(async () => {
    await resetDb();
    await prisma.$disconnect();
  });

  it("rejects creating a job without crm.manage permission (403)", async () => {
    const res = await request(app)
      .post("/crm/jobs")
      .set("Authorization", `Bearer ${workerToken}`)
      .send({ client_id: clientId, job_title: "Should fail" });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, "MISSING_PERMISSION");
  });

  it("rejects a job with missing job_title (400)", async () => {
    const res = await request(app)
      .post("/crm/jobs")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ client_id: clientId });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "VALIDATION_FAILED");
  });

  it("rejects a job for a client_id that doesn't exist (404 CLIENT_NOT_FOUND)", async () => {
    const res = await request(app)
      .post("/crm/jobs")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ client_id: "00000000-0000-0000-0000-000000000099", job_title: "Ghost client job" });
    assert.equal(res.status, 404);
    assert.equal(res.body.error, "CLIENT_NOT_FOUND");
  });

  let jobId: string;

  it("creates a job on the success path with default status and writes an audit entry", async () => {
    const res = await request(app)
      .post("/crm/jobs")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ client_id: clientId, job_title: "Hedge trimming" });
    assert.equal(res.status, 201);
    assert.equal(res.body.jobStatus, "nova");
    jobId = res.body.id;

    const audit = await prisma.auditLog.findFirst({
      where: { actionName: "create_job", result: "success" },
      orderBy: { createdAt: "desc" },
    });
    assert.ok(audit, "expected an audit log entry for create_job");
  });

  it("lists jobs filtered by client_id", async () => {
    const res = await request(app)
      .get(`/crm/jobs?client_id=${clientId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    assert.equal(res.status, 200);
    assert.ok(res.body.some((j: { id: string }) => j.id === jobId));
  });

  it("rejects an invalid status transition value (400)", async () => {
    const res = await request(app)
      .put(`/crm/jobs/${jobId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ job_status: "not_a_real_status" });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "VALIDATION_FAILED");
  });

  it("changes job status on the success path and logs before/after in audit", async () => {
    const res = await request(app)
      .put(`/crm/jobs/${jobId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ job_status: "naplanovano" });
    assert.equal(res.status, 200);
    assert.equal(res.body.jobStatus, "naplanovano");

    const audit = await prisma.auditLog.findFirst({
      where: { actionName: "change_job_status", result: "success" },
      orderBy: { createdAt: "desc" },
    });
    assert.ok(audit);
    const before = audit?.dataBefore as { jobStatus?: string } | null;
    const after = audit?.dataAfter as { jobStatus?: string } | null;
    assert.equal(before?.jobStatus, "nova");
    assert.equal(after?.jobStatus, "naplanovano");
  });

  it("returns 404 for a job status change on an unknown job", async () => {
    const res = await request(app)
      .put("/crm/jobs/00000000-0000-0000-0000-000000000099")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ job_status: "dokonceno" });
    assert.equal(res.status, 404);
    assert.equal(res.body.error, "JOB_NOT_FOUND");
  });
});
