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

describe("Document Registry", () => {
  let adminToken: string;
  let workerToken: string;
  let companyId: string;
  let clientAId: string;
  let clientBId: string;
  let jobId: string;
  let documentId: string;

  before(async () => {
    await resetDb();
    const seeded = await seedCompanyAndAdmin();
    companyId = seeded.company.id;
    adminToken = await loginAs("admin@test.local");
    workerToken = await loginAs("worker@test.local");
    const clientA = await prisma.client.create({ data: { companyId, displayName: "Document Client A" } });
    const clientB = await prisma.client.create({ data: { companyId, displayName: "Document Client B" } });
    clientAId = clientA.id;
    clientBId = clientB.id;
    const job = await prisma.job.create({ data: { companyId, clientId: clientA.id, jobTitle: "Document Job" } });
    jobId = job.id;
  });

  after(async () => {
    await resetDb();
    await prisma.$disconnect();
  });

  it("enforces crm permissions", async () => {
    const list = await request(app).get("/documents").set("Authorization", `Bearer ${workerToken}`);
    assert.equal(list.status, 403);
    const create = await request(app)
      .post("/documents")
      .set("Authorization", `Bearer ${workerToken}`)
      .send({ title: "No access", document_type: "other", document_reference: "ref" });
    assert.equal(create.status, 403);
  });

  it("validates fixed classifications and date order", async () => {
    const invalid = await request(app)
      .post("/documents")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        title: "Invalid",
        document_type: "invented",
        document_reference: "ref",
        issued_at: "2026-02-02T00:00:00.000Z",
        expires_at: "2026-01-01T00:00:00.000Z",
      });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error, "VALIDATION_FAILED");
  });

  it("rejects inconsistent client and job relations", async () => {
    const res = await request(app)
      .post("/documents")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        client_id: clientBId,
        job_id: jobId,
        title: "Wrong client",
        document_type: "contract",
        document_reference: "contracts/wrong.pdf",
      });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, "RELATED_RECORD_MISMATCH");
  });

  it("registers metadata, derives the job client and records audit evidence", async () => {
    const res = await request(app)
      .post("/documents")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        job_id: jobId,
        title: "Signed works contract",
        document_type: "contract",
        document_reference: "sharepoint:item:contract-42",
        source: "external_storage",
        sensitivity: "legal",
        verification_status: "confirmed",
        issued_at: "2026-01-01T00:00:00.000Z",
        expires_at: "2027-01-01T00:00:00.000Z",
      });
    assert.equal(res.status, 201);
    assert.equal(res.body.clientId, clientAId);
    assert.equal(res.body.jobId, jobId);
    assert.equal(res.body.sensitivity, "legal");
    assert.equal(res.body.documentReference, "sharepoint:item:contract-42");
    assert.equal(res.body.fileContents, undefined);
    documentId = res.body.id;

    const audit = await prisma.auditLog.findFirst({ where: { actionName: "create_document_record", result: "success" } });
    assert.equal((audit?.dataAfter as any)?.id, documentId);
  });

  it("lists and filters document metadata", async () => {
    const list = await request(app)
      .get(`/documents?client_id=${clientAId}&job_id=${jobId}&document_type=contract&sensitivity=legal&active_only=true`)
      .set("Authorization", `Bearer ${adminToken}`);
    assert.equal(list.status, 200);
    assert.equal(list.body.length, 1);
    assert.equal(list.body[0].id, documentId);
    assert.equal(list.body[0].job.jobTitle, "Document Job");
  });

  it("updates and archives metadata with safe date validation", async () => {
    const badDate = await request(app)
      .put(`/documents/${documentId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ expires_at: "2025-01-01T00:00:00.000Z" });
    assert.equal(badDate.status, 400);

    const update = await request(app)
      .put(`/documents/${documentId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ notes: "Reviewed by owner", is_active: false });
    assert.equal(update.status, 200);
    assert.equal(update.body.notes, "Reviewed by owner");
    assert.equal(update.body.isActive, false);
  });

  it("keeps document records isolated between tenants", async () => {
    const companyB = await prisma.company.create({ data: { name: "Other Document Co" } });
    const passwordHash = await bcrypt.hash("Password123!", 10);
    await prisma.user.create({
      data: {
        companyId: companyB.id,
        email: "documents-b@test.local",
        passwordHash,
        displayName: "Other Admin",
        role: "admin",
        permissions: ["crm.read", "crm.manage"],
      },
    });
    const tokenB = await loginAs("documents-b@test.local");
    const get = await request(app).get(`/documents/${documentId}`).set("Authorization", `Bearer ${tokenB}`);
    assert.equal(get.status, 404);
    const foreignJob = await request(app)
      .post("/documents")
      .set("Authorization", `Bearer ${tokenB}`)
      .send({ title: "Foreign", document_type: "other", document_reference: "foreign", job_id: jobId });
    assert.equal(foreignJob.status, 404);
    assert.equal(foreignJob.body.error, "JOB_NOT_FOUND");
  });
});
