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

function nextMonday(): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7 || 7));
  d.setUTCHours(9, 0, 0, 0);
  return d;
}

describe("Notification and Escalation Module", () => {
  let adminToken: string;
  let workerToken: string;
  let workerId: string;
  let clientId: string;
  let followUpCommId: string;
  let expiredQuoteId: string;
  let overloadJobId: string;

  before(async () => {
    await resetDb();
    const { worker } = await seedCompanyAndAdmin();
    workerId = worker.id;
    await prisma.user.update({ where: { id: worker.id }, data: { weeklyCapacityHours: 10 } });
    adminToken = await loginAs("admin@test.local");
    workerToken = await loginAs("worker@test.local");

    const clientRes = await request(app)
      .post("/crm/clients")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ display_name: "Attention Feed Client" });
    clientId = clientRes.body.id;

    // A communication whose follow-up is overdue.
    const commRes = await request(app)
      .post("/communications")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        client_id: clientId,
        channel: "phone_call",
        direction: "outbound",
        summary: "Promised a written quote",
        occurred_at: new Date("2026-06-01T09:00:00.000Z").toISOString(),
        follow_up_needed: true,
        follow_up_due_at: new Date("2026-06-05T09:00:00.000Z").toISOString(),
      });
    followUpCommId = commRes.body.id;

    // A draft quote that has already expired.
    const quoteRes = await request(app)
      .post("/quotes")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        client_id: clientId,
        title: "Expired quote",
        valid_until: new Date("2026-01-01T00:00:00.000Z").toISOString(),
        items: [{ description: "Work", unit_price: 100 }],
      });
    expiredQuoteId = quoteRes.body.id;

    // A job that overloads the worker's declared weekly capacity.
    const monday = nextMonday();
    const jobRes = await request(app)
      .post("/crm/jobs")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        client_id: clientId,
        job_title: "Overload-causing job",
        job_status: "prijato",
        planned_start_at: monday.toISOString(),
        estimated_duration_hours: 20,
      });
    overloadJobId = jobRes.body.id;
    await request(app)
      .put(`/crm/jobs/${overloadJobId}/assign`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ assigned_user_id: workerId });
  });

  after(async () => {
    await resetDb();
    await prisma.$disconnect();
  });

  it("rejects reading the feed without crm.read permission (401/403 depending on auth state)", async () => {
    const res = await request(app).get("/notifications");
    assert.equal(res.status, 401);
  });

  it("surfaces an overdue follow-up as an urgent, real, non-invented item", async () => {
    const res = await request(app).get("/notifications").set("Authorization", `Bearer ${adminToken}`);
    assert.equal(res.status, 200);
    const item = res.body.find((n: any) => n.key === `follow_up:${followUpCommId}`);
    assert.ok(item, "expected the overdue follow-up to appear in the feed");
    assert.equal(item.type, "follow_up_due");
    assert.equal(item.severity, "urgent");
    assert.equal(item.entity.id, followUpCommId);
    assert.equal(item.acknowledged, false);
  });

  it("surfaces a real capacity overload week computed from actual job/employee data", async () => {
    const res = await request(app).get("/notifications").set("Authorization", `Bearer ${adminToken}`);
    assert.equal(res.status, 200);
    const item = res.body.find((n: any) => n.type === "capacity_overload" && n.entity.id.startsWith(workerId));
    assert.ok(item, "expected an overload finding to appear in the feed");
    assert.ok(item.message.includes("20"));
  });

  it("surfaces an expired quote as urgent", async () => {
    const res = await request(app).get("/notifications").set("Authorization", `Bearer ${adminToken}`);
    assert.equal(res.status, 200);
    const item = res.body.find((n: any) => n.key === `quote_expiring:${expiredQuoteId}`);
    assert.ok(item, "expected the expired quote to appear in the feed");
    assert.equal(item.severity, "urgent");
  });

  it("sorts urgent items before warning items", async () => {
    const res = await request(app).get("/notifications").set("Authorization", `Bearer ${adminToken}`);
    const severities = res.body.map((n: any) => n.severity);
    const firstWarningIdx = severities.indexOf("warning");
    const lastUrgentIdx = severities.lastIndexOf("urgent");
    if (firstWarningIdx !== -1 && lastUrgentIdx !== -1) {
      assert.ok(lastUrgentIdx < firstWarningIdx);
    }
  });

  it("rejects acknowledging without crm.manage permission (403)", async () => {
    const res = await request(app)
      .post("/notifications/acknowledge")
      .set("Authorization", `Bearer ${workerToken}`)
      .send({ notification_key: `follow_up:${followUpCommId}` });
    assert.equal(res.status, 403);
  });

  it("validates that notification_key is required", async () => {
    const res = await request(app)
      .post("/notifications/acknowledge")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "VALIDATION_FAILED");
  });

  it("acknowledging an item removes it from the default feed without changing the underlying record", async () => {
    const key = `follow_up:${followUpCommId}`;
    const ackRes = await request(app)
      .post("/notifications/acknowledge")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ notification_key: key });
    assert.equal(ackRes.status, 200);

    const feedRes = await request(app).get("/notifications").set("Authorization", `Bearer ${adminToken}`);
    assert.ok(!feedRes.body.some((n: any) => n.key === key));

    // The underlying communication record itself is untouched.
    const commRes = await request(app)
      .get(`/communications/${followUpCommId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    assert.equal(commRes.status, 200);
    assert.equal(commRes.body.followUpNeeded, true);

    // Still visible when explicitly including acknowledged items.
    const fullFeedRes = await request(app)
      .get("/notifications?include_acknowledged=true")
      .set("Authorization", `Bearer ${adminToken}`);
    const ackedItem = fullFeedRes.body.find((n: any) => n.key === key);
    assert.ok(ackedItem);
    assert.equal(ackedItem.acknowledged, true);

    // Records an audit entry for the acknowledgement.
    const audits = await prisma.auditLog.findMany({ where: { actionName: "acknowledge_notification" } });
    assert.ok(audits.length > 0);
  });

  it("unacknowledging brings the item back into the default feed (reversible)", async () => {
    const key = `follow_up:${followUpCommId}`;
    const res = await request(app)
      .post(`/notifications/${encodeURIComponent(key)}/unacknowledge`)
      .set("Authorization", `Bearer ${adminToken}`);
    assert.equal(res.status, 200);

    const feedRes = await request(app).get("/notifications").set("Authorization", `Bearer ${adminToken}`);
    assert.ok(feedRes.body.some((n: any) => n.key === key));
  });

  it("unacknowledging a never-acknowledged key is idempotent (no error)", async () => {
    const res = await request(app)
      .post(`/notifications/${encodeURIComponent("quote_expiring:does-not-exist")}/unacknowledge`)
      .set("Authorization", `Bearer ${adminToken}`);
    assert.equal(res.status, 200);
  });

  describe("Portfolio marketing-readiness gap source", () => {
    let completedJobNoPhotosId: string;
    let completedJobWithPhotoId: string;
    let notCompletedJobId: string;

    before(async () => {
      const jobNoPhotos = await request(app)
        .post("/crm/jobs")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ client_id: clientId, job_title: "Finished job, no photos" });
      completedJobNoPhotosId = jobNoPhotos.body.id;
      await request(app)
        .put(`/crm/jobs/${completedJobNoPhotosId}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ job_status: "dokonceno" });

      const jobWithPhoto = await request(app)
        .post("/crm/jobs")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ client_id: clientId, job_title: "Finished job, has a photo" });
      completedJobWithPhotoId = jobWithPhoto.body.id;
      await request(app)
        .put(`/crm/jobs/${completedJobWithPhotoId}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ job_status: "dokonceno" });
      await request(app)
        .post("/portfolio")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          job_id: completedJobWithPhotoId,
          filename: "after.jpg",
          source: "employee_upload",
        });

      const notCompletedJob = await request(app)
        .post("/crm/jobs")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ client_id: clientId, job_title: "Still in progress, no photos" });
      notCompletedJobId = notCompletedJob.body.id;
      await request(app)
        .put(`/crm/jobs/${notCompletedJobId}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ job_status: "v_realizaci" });
    });

    it("surfaces a completed job with zero logged photos as an info-severity portfolio gap", async () => {
      const res = await request(app).get("/notifications").set("Authorization", `Bearer ${adminToken}`);
      assert.equal(res.status, 200);
      const item = res.body.find((n: any) => n.key === `portfolio_gap:${completedJobNoPhotosId}`);
      assert.ok(item, "expected the completed job with no photos to appear as a portfolio gap");
      assert.equal(item.type, "portfolio_gap");
      assert.equal(item.severity, "info");
      assert.equal(item.entity.id, completedJobNoPhotosId);
    });

    it("does not flag a completed job that already has at least one logged photo", async () => {
      const res = await request(app).get("/notifications").set("Authorization", `Bearer ${adminToken}`);
      assert.equal(res.status, 200);
      const item = res.body.find((n: any) => n.key === `portfolio_gap:${completedJobWithPhotoId}`);
      assert.ok(!item, "did not expect a portfolio gap for a completed job that already has a photo");
    });

    it("never flags a job that is not marked completed, regardless of photo count", async () => {
      const res = await request(app).get("/notifications").set("Authorization", `Bearer ${adminToken}`);
      assert.equal(res.status, 200);
      const item = res.body.find((n: any) => n.key === `portfolio_gap:${notCompletedJobId}`);
      assert.ok(!item, "did not expect a portfolio gap for a job that is not marked complete");
    });
  });

  describe("Stale lead source", () => {
    let staleOpenLeadId: string;
    let freshOpenLeadId: string;
    let staleConvertedLeadId: string;
    let staleLostLeadId: string;

    before(async () => {
      const STALE_LEAD_THRESHOLD_DAYS = 14;
      const longAgo = new Date(Date.now() - (STALE_LEAD_THRESHOLD_DAYS + 5) * 24 * 60 * 60 * 1000);
      const recently = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);

      const staleOpen = await request(app)
        .post("/crm/leads")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ name: "Stale Open Lead" });
      staleOpenLeadId = staleOpen.body.id;
      await prisma.lead.update({ where: { id: staleOpenLeadId }, data: { createdAt: longAgo } });

      const freshOpen = await request(app)
        .post("/crm/leads")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ name: "Fresh Open Lead" });
      freshOpenLeadId = freshOpen.body.id;
      await prisma.lead.update({ where: { id: freshOpenLeadId }, data: { createdAt: recently } });

      const staleConverted = await request(app)
        .post("/crm/leads")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ name: "Stale Converted Lead" });
      staleConvertedLeadId = staleConverted.body.id;
      await prisma.lead.update({
        where: { id: staleConvertedLeadId },
        data: { createdAt: longAgo, leadStatus: "converted" },
      });

      const staleLost = await request(app)
        .post("/crm/leads")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ name: "Stale Lost Lead" });
      staleLostLeadId = staleLost.body.id;
      await prisma.lead.update({
        where: { id: staleLostLeadId },
        data: { createdAt: longAgo, leadStatus: "lost" },
      });
    });

    it("surfaces a lead still open long past the threshold as a stale_lead item", async () => {
      const res = await request(app).get("/notifications").set("Authorization", `Bearer ${adminToken}`);
      assert.equal(res.status, 200);
      const item = res.body.find((n: any) => n.key === `stale_lead:${staleOpenLeadId}`);
      assert.ok(item, "expected the stale open lead to appear in the feed");
      assert.equal(item.type, "stale_lead");
      assert.equal(item.entity.id, staleOpenLeadId);
    });

    it("does not flag a recently created open lead", async () => {
      const res = await request(app).get("/notifications").set("Authorization", `Bearer ${adminToken}`);
      const item = res.body.find((n: any) => n.key === `stale_lead:${freshOpenLeadId}`);
      assert.ok(!item, "did not expect a fresh lead to be flagged as stale");
    });

    it("never flags a converted lead as stale, regardless of age", async () => {
      const res = await request(app).get("/notifications").set("Authorization", `Bearer ${adminToken}`);
      const item = res.body.find((n: any) => n.key === `stale_lead:${staleConvertedLeadId}`);
      assert.ok(!item, "did not expect a converted lead to be flagged as stale");
    });

    it("never flags a lost lead as stale, regardless of age", async () => {
      const res = await request(app).get("/notifications").set("Authorization", `Bearer ${adminToken}`);
      const item = res.body.find((n: any) => n.key === `stale_lead:${staleLostLeadId}`);
      assert.ok(!item, "did not expect a lost lead to be flagged as stale");
    });
  });

  describe("Stuck job source", () => {
    let stuckJobId: string;
    let recentlyChangedJobId: string;
    let doneStuckJobId: string;
    let cancelledStuckJobId: string;

    before(async () => {
      const STUCK_JOB_THRESHOLD_DAYS = 10;
      const longAgo = new Date(Date.now() - (STUCK_JOB_THRESHOLD_DAYS + 5) * 24 * 60 * 60 * 1000);

      // A job with no change_job_status audit entry at all — measured from
      // Job.createdAt, which is backdated past the threshold.
      const stuckJob = await request(app)
        .post("/crm/jobs")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ client_id: clientId, job_title: "Stuck job, never changed" });
      stuckJobId = stuckJob.body.id;
      await prisma.job.update({ where: { id: stuckJobId }, data: { createdAt: longAgo } });

      // A job that was created long ago but had its status changed just now
      // via a real change_job_status call — must NOT be flagged, proving the
      // source reads the AuditLog trail rather than just Job.createdAt.
      const recentlyChangedJob = await request(app)
        .post("/crm/jobs")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ client_id: clientId, job_title: "Old job, recently changed status" });
      recentlyChangedJobId = recentlyChangedJob.body.id;
      await prisma.job.update({ where: { id: recentlyChangedJobId }, data: { createdAt: longAgo } });
      await request(app)
        .put(`/crm/jobs/${recentlyChangedJobId}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ job_status: "naplanovano" });

      // A completed job, backdated past the threshold — terminal status,
      // must never be flagged regardless of age.
      const doneJob = await request(app)
        .post("/crm/jobs")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ client_id: clientId, job_title: "Done long ago" });
      doneStuckJobId = doneJob.body.id;
      await request(app)
        .put(`/crm/jobs/${doneStuckJobId}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ job_status: "dokonceno" });
      await prisma.job.update({ where: { id: doneStuckJobId }, data: { createdAt: longAgo } });

      // A cancelled job, backdated past the threshold — terminal status,
      // must never be flagged regardless of age.
      const cancelledJob = await request(app)
        .post("/crm/jobs")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ client_id: clientId, job_title: "Cancelled long ago" });
      cancelledStuckJobId = cancelledJob.body.id;
      await request(app)
        .put(`/crm/jobs/${cancelledStuckJobId}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ job_status: "zruseno" });
      await prisma.job.update({ where: { id: cancelledStuckJobId }, data: { createdAt: longAgo } });
    });

    it("surfaces a non-terminal job with no recent status change as a stuck_job item", async () => {
      const res = await request(app).get("/notifications").set("Authorization", `Bearer ${adminToken}`);
      assert.equal(res.status, 200);
      const item = res.body.find((n: any) => n.key === `stuck_job:${stuckJobId}`);
      assert.ok(item, "expected the stuck job to appear in the feed");
      assert.equal(item.type, "stuck_job");
      assert.equal(item.entity.id, stuckJobId);
    });

    it("does not flag a job whose status was changed recently, even if the job itself is old", async () => {
      const res = await request(app).get("/notifications").set("Authorization", `Bearer ${adminToken}`);
      const item = res.body.find((n: any) => n.key === `stuck_job:${recentlyChangedJobId}`);
      assert.ok(!item, "did not expect a recently status-changed job to be flagged as stuck");
    });

    it("never flags a done (terminal-status) job as stuck, regardless of age", async () => {
      const res = await request(app).get("/notifications").set("Authorization", `Bearer ${adminToken}`);
      const item = res.body.find((n: any) => n.key === `stuck_job:${doneStuckJobId}`);
      assert.ok(!item, "did not expect a completed job to be flagged as stuck");
    });

    it("never flags a cancelled (terminal-status) job as stuck, regardless of age", async () => {
      const res = await request(app).get("/notifications").set("Authorization", `Bearer ${adminToken}`);
      const item = res.body.find((n: any) => n.key === `stuck_job:${cancelledStuckJobId}`);
      assert.ok(!item, "did not expect a cancelled job to be flagged as stuck");
    });
  });
});
