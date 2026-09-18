import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import request from "supertest";
import { createServer } from "../src/server.js";
import { prisma } from "../src/db.js";
import { DEFAULT_NOTIFICATION_THRESHOLDS, resolveNotificationThresholds } from "../src/services/notificationThresholdService.js";
import { resetDb, seedCompanyAndAdmin, TEST_COMPANY_ID } from "./setup.js";

const app = createServer();
const day = 24 * 60 * 60 * 1000;

describe("Notification thresholds (per-company overrides)", () => {
  let adminToken: string;
  let workerToken: string;
  let leadId: string;

  before(async () => {
    await resetDb();
    await seedCompanyAndAdmin();
    adminToken = (await request(app).post("/auth/login").send({ email: "admin@test.local", password: "Password123!" })).body.token;
    workerToken = (await request(app).post("/auth/login").send({ email: "worker@test.local", password: "Password123!" })).body.token;
    // An open lead 20 days old: stale under the 14-day default, fresh under a 30-day override.
    const lead = await prisma.lead.create({ data: { companyId: TEST_COMPANY_ID, name: "Twenty-day lead", leadStatus: "new", createdAt: new Date(Date.now() - 20 * day) } });
    leadId = lead.id;
  });

  after(async () => { await prisma.$disconnect(); });

  it("resolves malformed or partial stored values back to the documented defaults", () => {
    assert.deepEqual(resolveNotificationThresholds(null), DEFAULT_NOTIFICATION_THRESHOLDS);
    assert.deepEqual(resolveNotificationThresholds({ stale_lead_days: 30, stuck_job_days: "x", quote_expiry_warning_days: 500 }), { ...DEFAULT_NOTIFICATION_THRESHOLDS, staleLeadDays: 30 });
  });

  it("reads the effective thresholds with defaults and limits (company.manage only)", async () => {
    const forbidden = await request(app).get("/company/notification-thresholds").set("Authorization", `Bearer ${workerToken}`);
    assert.equal(forbidden.status, 403);
    const res = await request(app).get("/company/notification-thresholds").set("Authorization", `Bearer ${adminToken}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.thresholds, DEFAULT_NOTIFICATION_THRESHOLDS);
    assert.equal(res.body.isDefault, true);
    assert.equal(res.body.limits.staleLeadDays.max, 365);
  });

  it("surfaces the 20-day lead as stale under the default 14-day threshold", async () => {
    const feed = await request(app).get("/notifications").set("Authorization", `Bearer ${adminToken}`);
    assert.ok(feed.body.some((item: any) => item.key === `stale_lead:${leadId}`));
  });

  it("rejects out-of-range or non-integer values and unknown keys", async () => {
    for (const body of [
      { quote_expiry_warning_days: 0, stale_lead_days: 14, stuck_job_days: 10, resource_readiness_days: 3 },
      { quote_expiry_warning_days: 7, stale_lead_days: 14.5, stuck_job_days: 10, resource_readiness_days: 3 },
      { quote_expiry_warning_days: 7, stale_lead_days: 14, stuck_job_days: 10, resource_readiness_days: 31 },
      { quote_expiry_warning_days: 7, stale_lead_days: 14, stuck_job_days: 10, resource_readiness_days: 3, extra: 1 },
    ]) {
      const res = await request(app).put("/company/notification-thresholds").set("Authorization", `Bearer ${adminToken}`).send(body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(res.body.error, "VALIDATION_FAILED");
    }
    const unchanged = await request(app).get("/company/notification-thresholds").set("Authorization", `Bearer ${adminToken}`);
    assert.equal(unchanged.body.isDefault, true);
  });

  it("updates the thresholds, audits before/after, and the feed follows the new values", async () => {
    const res = await request(app)
      .put("/company/notification-thresholds")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ quote_expiry_warning_days: 14, stale_lead_days: 30, stuck_job_days: 20, resource_readiness_days: 5 });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.thresholds, { quoteExpiryWarningDays: 14, staleLeadDays: 30, stuckJobDays: 20, resourceReadinessDays: 5 });
    assert.equal(res.body.isDefault, false);

    const audit = await prisma.auditLog.findFirst({ where: { actionName: "update_notification_thresholds", result: "success" }, orderBy: { createdAt: "desc" } });
    assert.ok(audit);
    assert.deepEqual(audit!.dataBefore, DEFAULT_NOTIFICATION_THRESHOLDS);
    assert.equal((audit!.dataAfter as any).staleLeadDays, 30);

    const feed = await request(app).get("/notifications").set("Authorization", `Bearer ${adminToken}`);
    assert.ok(!feed.body.some((item: any) => item.key === `stale_lead:${leadId}`), "a 20-day lead is not stale under a 30-day threshold");
  });

  it("keeps another company on the defaults (tenant isolation)", async () => {
    const other = await prisma.company.create({ data: { name: "Other Co" } });
    const { resolveNotificationThresholds: resolve } = await import("../src/services/notificationThresholdService.js");
    const stored = await prisma.company.findUniqueOrThrow({ where: { id: other.id }, select: { notificationThresholds: true } });
    assert.deepEqual(resolve(stored.notificationThresholds), DEFAULT_NOTIFICATION_THRESHOLDS);
  });
});
