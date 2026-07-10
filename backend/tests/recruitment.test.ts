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

describe("Recruitment and Workforce Expansion Module", () => {
  let adminToken: string;
  let workerToken: string;

  before(async () => {
    await resetDb();
    await seedCompanyAndAdmin();
    adminToken = await loginAs("admin@test.local");
    workerToken = await loginAs("worker@test.local");
  });

  after(async () => {
    await prisma.$disconnect();
  });

  it("rejects job opening creation without recruitment.manage permission (403)", async () => {
    const res = await request(app)
      .post("/recruitment/job-openings")
      .set("Authorization", `Bearer ${workerToken}`)
      .send({ title: "Fencer" });
    assert.equal(res.status, 403);
  });

  it("creates a job opening with real, user-entered data and defaults to draft/medium", async () => {
    const res = await request(app)
      .post("/recruitment/job-openings")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        title: "Fencing labourer",
        reason: "Too much fencing work to handle with current team",
        skills_required: ["fencing", "manual labour"],
        min_experience_years: 1,
        expected_tasks: "Install and repair timber fence panels",
      });
    assert.equal(res.status, 201);
    assert.equal(res.body.openingStatus, "draft");
    assert.equal(res.body.urgency, "medium");
    assert.deepEqual(res.body.skillsRequired, ["fencing", "manual labour"]);

    const audit = await prisma.auditLog.findFirst({ where: { actionName: "create_job_opening", result: "success" } });
    assert.ok(audit);
  });

  it("validates required fields", async () => {
    const res = await request(app)
      .post("/recruitment/job-openings")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ reason: "no title given" });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "VALIDATION_FAILED");
  });

  it("moves a job opening from draft to open via update, recording before/after", async () => {
    const opening = await prisma.jobOpening.findFirst({ where: { title: "Fencing labourer" } });
    const res = await request(app)
      .put(`/recruitment/job-openings/${opening!.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ opening_status: "open" });
    assert.equal(res.status, 200);
    assert.equal(res.body.openingStatus, "open");

    const audit = await prisma.auditLog.findFirst({
      where: { actionName: "update_job_opening", result: "success" },
      orderBy: { createdAt: "desc" },
    });
    assert.equal((audit?.dataBefore as any)?.openingStatus, "draft");
    assert.equal((audit?.dataAfter as any)?.openingStatus, "open");
  });

  it("returns JOB_OPENING_NOT_FOUND for an update to a nonexistent id", async () => {
    const res = await request(app)
      .put("/recruitment/job-openings/00000000-0000-0000-0000-000000000099")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ title: "x" });
    assert.equal(res.status, 404);
    assert.equal(res.body.error, "JOB_OPENING_NOT_FOUND");
  });

  it("drafts a job advert built only from the opening's real fields, with no wage/terms invented", async () => {
    const opening = await prisma.jobOpening.findFirst({ where: { title: "Fencing labourer" } });
    const res = await request(app)
      .post(`/recruitment/job-openings/${opening!.id}/draft-advert`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    assert.equal(res.status, 200);
    assert.ok(res.body.draftAdvertText.includes("Fencing labourer"));
    assert.ok(res.body.draftAdvertText.includes("fencing, manual labour"));
    assert.ok(res.body.draftAdvertText.includes("Install and repair timber fence panels"));
    assert.ok(!/£|\$|salary|wage/i.test(res.body.draftAdvertText));

    const audit = await prisma.auditLog.findFirst({ where: { actionName: "draft_job_advert", result: "success" } });
    assert.ok(audit);
  });

  it("returns JOB_OPENING_NOT_FOUND when drafting an advert for a nonexistent opening", async () => {
    const res = await request(app)
      .post("/recruitment/job-openings/00000000-0000-0000-0000-000000000099/draft-advert")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    assert.equal(res.status, 404);
    assert.equal(res.body.error, "JOB_OPENING_NOT_FOUND");
  });

  it("adds a candidate to a job opening's pipeline, defaulting to stage 'new'", async () => {
    const opening = await prisma.jobOpening.findFirst({ where: { title: "Fencing labourer" } });
    const res = await request(app)
      .post(`/recruitment/job-openings/${opening!.id}/candidates`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Alex Carpenter", email: "alex@example.com", phone: "07700900123" });
    assert.equal(res.status, 201);
    assert.equal(res.body.stage, "new");
    assert.equal(res.body.jobOpeningId, opening!.id);

    const audit = await prisma.auditLog.findFirst({ where: { actionName: "create_candidate", result: "success" } });
    assert.ok(audit);
  });

  it("returns JOB_OPENING_NOT_FOUND when adding a candidate to an unknown opening", async () => {
    const res = await request(app)
      .post("/recruitment/job-openings/00000000-0000-0000-0000-000000000099/candidates")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Nobody" });
    assert.equal(res.status, 404);
    assert.equal(res.body.error, "JOB_OPENING_NOT_FOUND");
  });

  it("moves a candidate through the pipeline and records before/after in the audit log", async () => {
    const candidate = await prisma.candidate.findFirst({ where: { name: "Alex Carpenter" } });
    const res = await request(app)
      .put(`/recruitment/candidates/${candidate!.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ stage: "interview", notes: "Strong references, available immediately" });
    assert.equal(res.status, 200);
    assert.equal(res.body.stage, "interview");

    const audit = await prisma.auditLog.findFirst({
      where: { actionName: "update_candidate", result: "success" },
      orderBy: { createdAt: "desc" },
    });
    assert.equal((audit?.dataBefore as any)?.stage, "new");
    assert.equal((audit?.dataAfter as any)?.stage, "interview");
  });

  it("rejects an invalid candidate stage", async () => {
    const candidate = await prisma.candidate.findFirst({ where: { name: "Alex Carpenter" } });
    const res = await request(app)
      .put(`/recruitment/candidates/${candidate!.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ stage: "not_a_real_stage" });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "VALIDATION_FAILED");
  });

  it("moving a candidate to 'hired' only updates the pipeline record, never creates an employee account", async () => {
    const candidate = await prisma.candidate.findFirst({ where: { name: "Alex Carpenter" } });
    const usersBefore = await prisma.user.count();
    const res = await request(app)
      .put(`/recruitment/candidates/${candidate!.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ stage: "hired" });
    assert.equal(res.status, 200);
    assert.equal(res.body.stage, "hired");
    const usersAfter = await prisma.user.count();
    assert.equal(usersAfter, usersBefore);
  });

  it("returns CANDIDATE_NOT_FOUND for an update to a nonexistent candidate", async () => {
    const res = await request(app)
      .put("/recruitment/candidates/00000000-0000-0000-0000-000000000099")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ stage: "screening" });
    assert.equal(res.status, 404);
    assert.equal(res.body.error, "CANDIDATE_NOT_FOUND");
  });

  it("lists job openings and can filter by status, and gets a single opening with its candidates", async () => {
    const listRes = await request(app).get("/recruitment/job-openings").set("Authorization", `Bearer ${adminToken}`);
    assert.equal(listRes.status, 200);
    assert.ok(listRes.body.length >= 1);

    const openRes = await request(app)
      .get("/recruitment/job-openings?status=open")
      .set("Authorization", `Bearer ${adminToken}`);
    assert.ok(openRes.body.every((o: any) => o.openingStatus === "open"));

    const opening = await prisma.jobOpening.findFirst({ where: { title: "Fencing labourer" } });
    const getRes = await request(app)
      .get(`/recruitment/job-openings/${opening!.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    assert.equal(getRes.status, 200);
    assert.equal(getRes.body.candidates.length, 1);
    assert.equal(getRes.body.candidates[0].name, "Alex Carpenter");
  });

  it("returns JOB_OPENING_NOT_FOUND for a get on a nonexistent opening", async () => {
    const res = await request(app)
      .get("/recruitment/job-openings/00000000-0000-0000-0000-000000000099")
      .set("Authorization", `Bearer ${adminToken}`);
    assert.equal(res.status, 404);
    assert.equal(res.body.error, "JOB_OPENING_NOT_FOUND");
  });
});
