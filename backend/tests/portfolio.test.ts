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

describe("Portfolio and Photo Intelligence Module", () => {
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

  it("rejects logging a photo without crm.manage permission (403)", async () => {
    const res = await request(app)
      .post("/portfolio")
      .set("Authorization", `Bearer ${workerToken}`)
      .send({ filename: "IMG_001.jpg", source: "employee_upload" });
    assert.equal(res.status, 403);
  });

  it("validates required fields", async () => {
    const res = await request(app)
      .post("/portfolio")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ caption: "Missing filename and source" });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "VALIDATION_FAILED");
  });

  it("rejects an unknown source value", async () => {
    const res = await request(app)
      .post("/portfolio")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ filename: "IMG_001.jpg", source: "invented_source" });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "VALIDATION_FAILED");
  });

  it("returns CLIENT_NOT_FOUND for an unknown client id", async () => {
    const res = await request(app)
      .post("/portfolio")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        filename: "IMG_001.jpg",
        source: "employee_upload",
        client_id: "00000000-0000-0000-0000-000000000099",
      });
    assert.equal(res.status, 404);
    assert.equal(res.body.error, "CLIENT_NOT_FOUND");
  });

  it("returns JOB_NOT_FOUND for an unknown job id", async () => {
    const res = await request(app)
      .post("/portfolio")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        filename: "IMG_001.jpg",
        source: "employee_upload",
        client_id: clientId,
        job_id: "00000000-0000-0000-0000-000000000099",
      });
    assert.equal(res.status, 404);
    assert.equal(res.body.error, "JOB_NOT_FOUND");
  });

  let photoId: string;

  it("creates a photo record from real, user-entered data and records an audit entry", async () => {
    const res = await request(app)
      .post("/portfolio")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        client_id: clientId,
        job_id: jobId,
        filename: "IMG_001.jpg",
        caption: "Kitchen before refit",
        tags: ["kitchen", "before"],
        source: "employee_upload",
        usable_for_marketing: false,
      });
    assert.equal(res.status, 201);
    assert.equal(res.body.filename, "IMG_001.jpg");
    assert.equal(res.body.source, "employee_upload");
    assert.equal(res.body.usableForMarketing, false);
    assert.equal(res.body.client.id, clientId);
    assert.equal(res.body.job.id, jobId);
    photoId = res.body.id;

    const audit = await prisma.auditLog.findFirst({ where: { actionName: "log_portfolio_photo", result: "success" } });
    assert.ok(audit);
    assert.equal((audit?.dataAfter as any)?.id, photoId);
    assert.equal(audit?.riskLevel, 1);
  });

  it("allows logging a photo with no client or job at all", async () => {
    const res = await request(app)
      .post("/portfolio")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ filename: "IMG_999.jpg", source: "other", caption: "General site photo" });
    assert.equal(res.status, 201);
    assert.equal(res.body.client, null);
    assert.equal(res.body.job, null);
  });

  it("gets a single photo record", async () => {
    const res = await request(app).get(`/portfolio/${photoId}`).set("Authorization", `Bearer ${adminToken}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.id, photoId);
  });

  it("returns PORTFOLIO_PHOTO_NOT_FOUND for a get on a nonexistent record", async () => {
    const res = await request(app)
      .get("/portfolio/00000000-0000-0000-0000-000000000099")
      .set("Authorization", `Bearer ${adminToken}`);
    assert.equal(res.status, 404);
    assert.equal(res.body.error, "PORTFOLIO_PHOTO_NOT_FOUND");
  });

  it("lists photos and can filter by client, job, tag, source and usableForMarketing", async () => {
    await request(app)
      .post("/portfolio")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        client_id: clientId,
        filename: "IMG_002.jpg",
        caption: "Kitchen after refit — client approved for marketing",
        tags: ["kitchen", "after"],
        source: "before_after",
        usable_for_marketing: true,
        usable_for_marketing_notes: "Client gave written permission",
      });

    const all = await request(app).get("/portfolio").set("Authorization", `Bearer ${adminToken}`);
    assert.equal(all.status, 200);
    assert.ok(all.body.length >= 3);

    const byClient = await request(app)
      .get(`/portfolio?client_id=${clientId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    assert.ok(byClient.body.every((r: any) => r.client.id === clientId));

    const byJob = await request(app)
      .get(`/portfolio?job_id=${jobId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    assert.equal(byJob.body.length, 1);
    assert.equal(byJob.body[0].id, photoId);

    const byTag = await request(app)
      .get("/portfolio?tag=after")
      .set("Authorization", `Bearer ${adminToken}`);
    assert.ok(byTag.body.every((r: any) => r.tags.includes("after")));
    assert.ok(byTag.body.length >= 1);

    const bySource = await request(app)
      .get("/portfolio?source=before_after")
      .set("Authorization", `Bearer ${adminToken}`);
    assert.ok(bySource.body.every((r: any) => r.source === "before_after"));

    const byMarketing = await request(app)
      .get("/portfolio?usable_for_marketing=true")
      .set("Authorization", `Bearer ${adminToken}`);
    assert.ok(byMarketing.body.every((r: any) => r.usableForMarketing === true));
    assert.ok(byMarketing.body.length >= 1);
  });

  it("updates a photo record and records before/after in the audit log", async () => {
    const res = await request(app)
      .put(`/portfolio/${photoId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ usable_for_marketing: true, usable_for_marketing_notes: "Approved after review" });
    assert.equal(res.status, 200);
    assert.equal(res.body.usableForMarketing, true);
    assert.equal(res.body.usableForMarketingNotes, "Approved after review");

    const audit = await prisma.auditLog.findFirst({
      where: { actionName: "update_portfolio_photo", result: "success" },
      orderBy: { createdAt: "desc" },
    });
    assert.equal((audit?.dataBefore as any)?.usableForMarketing, false);
    assert.equal((audit?.dataAfter as any)?.usableForMarketing, true);
    assert.equal(audit?.riskLevel, 1);
  });

  it("rejects invalid update input", async () => {
    const res = await request(app)
      .put(`/portfolio/${photoId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ source: "not_a_real_source" });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "VALIDATION_FAILED");
  });

  it("returns PORTFOLIO_PHOTO_NOT_FOUND for an update to a nonexistent record", async () => {
    const res = await request(app)
      .put("/portfolio/00000000-0000-0000-0000-000000000099")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ caption: "x" });
    assert.equal(res.status, 404);
    assert.equal(res.body.error, "PORTFOLIO_PHOTO_NOT_FOUND");
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
      .post("/portfolio")
      .set("Authorization", `Bearer ${tokenB}`)
      .send({ client_id: clientB.id, filename: "OTHERCO.jpg", source: "employee_upload" });
    assert.equal(createRes.status, 201);
    const photoBId = createRes.body.id;

    // Company A cannot see company B's record.
    const getAsA = await request(app).get(`/portfolio/${photoBId}`).set("Authorization", `Bearer ${adminToken}`);
    assert.equal(getAsA.status, 404);

    // Company A cannot update company B's record.
    const updateAsA = await request(app)
      .put(`/portfolio/${photoBId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ caption: "hijacked" });
    assert.equal(updateAsA.status, 404);

    // Company A's list never includes company B's record.
    const listAsA = await request(app).get("/portfolio").set("Authorization", `Bearer ${adminToken}`);
    assert.ok(!listAsA.body.some((r: any) => r.id === photoBId));

    // Company A cannot log a photo against company B's client.
    const crossClientRes = await request(app)
      .post("/portfolio")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ client_id: clientB.id, filename: "SHOULD_FAIL.jpg", source: "other" });
    assert.equal(crossClientRes.status, 404);
    assert.equal(crossClientRes.body.error, "CLIENT_NOT_FOUND");
  });
});
