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
});
