import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import request from "supertest";
import { createServer } from "../src/server.js";
import { prisma } from "../src/db.js";
import { getWeekRange } from "../src/services/capacityService.js";
import { resetDb, seedCompanyAndAdmin, TEST_COMPANY_ID } from "./setup.js";

const app = createServer();

describe("Measurement and KPI Module", () => {
  let adminToken: string;
  let workerToken: string;

  before(async () => {
    await resetDb();
    const { admin, worker } = await seedCompanyAndAdmin();
    const adminLogin = await request(app).post("/auth/login").send({ email: admin.email, password: "Password123!" });
    const workerLogin = await request(app).post("/auth/login").send({ email: worker.email, password: "Password123!" });
    adminToken = adminLogin.body.token;
    workerToken = workerLogin.body.token;

    await prisma.lead.createMany({ data: [
      { companyId: TEST_COMPANY_ID, name: "One", source: "Google", leadStatus: "lost" },
      { companyId: TEST_COMPANY_ID, name: "Two", source: "Google", leadStatus: "lost" },
      { companyId: TEST_COMPANY_ID, name: "Three", source: "Referral", leadStatus: "converted" },
      { companyId: TEST_COMPANY_ID, name: "Four", source: "Referral", leadStatus: "qualified" },
      { companyId: TEST_COMPANY_ID, name: "Five", source: null, leadStatus: "new" },
      { companyId: TEST_COMPANY_ID, name: "Six", source: "Google", leadStatus: "lost" },
    ] });
    const client = await prisma.client.create({ data: { companyId: TEST_COMPANY_ID, displayName: "Metrics Client" } });
    const service = await prisma.serviceCatalogueItem.create({ data: { companyId: TEST_COMPANY_ID, name: "Fencing" } });
    for (const [index, status] of ["accepted", "rejected", "rejected", "expired"].entries()) {
      const items = index === 0
        ? [{ description: "Costed work", quantity: 1, unitPrice: 100, unitCost: 60, serviceCatalogueItemId: service.id, sortOrder: 0 }, { description: "Uncosted work", quantity: 1, unitPrice: 50, serviceCatalogueItemId: service.id, sortOrder: 1 }]
        : [{ description: "Work", quantity: 1, unitPrice: 100 + index * 100, sortOrder: 0 }];
      await prisma.quote.create({ data: { companyId: TEST_COMPANY_ID, clientId: client.id, title: `Quote ${index}`, quoteStatus: status, items: { create: items } } });
    }
    const previousCreatedAt = new Date(Date.now() - 45 * 86_400_000);
    await prisma.lead.create({ data: { companyId: TEST_COMPANY_ID, name: "Previous lead", leadStatus: "converted", createdAt: previousCreatedAt } });
    await prisma.quote.create({ data: { companyId: TEST_COMPANY_ID, clientId: client.id, title: "Previous quote", quoteStatus: "accepted", createdAt: previousCreatedAt, items: { create: [{ description: "Previous work", quantity: 1, unitPrice: 500, sortOrder: 0 }] } } });
    await prisma.job.create({ data: { companyId: TEST_COMPANY_ID, clientId: client.id, jobTitle: "Previous completed job", jobStatus: "dokonceno", createdAt: previousCreatedAt } });
    await prisma.user.updateMany({ where: { companyId: TEST_COMPANY_ID }, data: { weeklyCapacityHours: 20 } });
    const { weekStart } = getWeekRange();
    await prisma.job.create({ data: { companyId: TEST_COMPANY_ID, clientId: client.id, jobTitle: "Capacity job", jobStatus: "naplanovano", assignedUserId: admin.id, estimatedDurationHours: 35, plannedStartAt: new Date(weekStart.getTime() + 86_400_000) } });
  });

  after(async () => { await prisma.$disconnect(); });

  it("requires crm.read", async () => {
    const res = await request(app).get("/metrics/overview").set("Authorization", `Bearer ${workerToken}`);
    assert.equal(res.status, 403);
  });

  it("validates the selected period", async () => {
    const res = await request(app).get("/metrics/overview?from=2026-07-11T00:00:00.000Z&to=2026-07-01T00:00:00.000Z").set("Authorization", `Bearer ${adminToken}`);
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "VALIDATION_FAILED");
  });

  it("computes real company KPIs, reports unavailable fields and gives evidenced recommendations", async () => {
    const res = await request(app).get("/metrics/overview").set("Authorization", `Bearer ${adminToken}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.leads.newCount, 6);
    assert.deepEqual(res.body.leads.sources, [
      { source: "Google", count: 3, convertedCount: 0, lostCount: 3, conversionRatePct: 0, lossRatePct: 100 },
      { source: "Referral", count: 2, convertedCount: 1, lostCount: 0, conversionRatePct: 50, lossRatePct: 0 },
      { source: "Unknown", count: 1, convertedCount: 0, lostCount: 0, conversionRatePct: 0, lossRatePct: 0 },
    ]);
    assert.equal(res.body.quotes.conversionRatePct, 25);
    assert.equal(res.body.quotes.averageValueGbp, 262.5);
    assert.deepEqual(res.body.trends.newLeads, { current: 6, previous: 1, delta: 5 });
    assert.equal(res.body.trends.quoteConversionRatePct.previous, 100);
    assert.deepEqual(res.body.revenueByService.rows, [{ serviceId: res.body.revenueByService.rows[0].serviceId, serviceName: "Fencing", acceptedValueGbp: 150, lineCount: 2, linesWithKnownCost: 1, costKnown: false, marginGbp: null, marginPct: null }]);
    assert.equal(res.body.revenueByService.unlinkedAcceptedValueGbp, 0);
    assert.equal(res.body.capacity.available, true);
    assert.equal(res.body.capacity.utilizationPct, 88);
    assert.equal(res.body.unavailableMetrics.unpaidInvoices, "No invoice/payment module exists.");
    assert.ok(res.body.recommendations.some((item: any) => item.title === "Lead loss is elevated"));
    assert.ok(res.body.recommendations.some((item: any) => item.title === "Quote conversion is below 40%"));
    assert.ok(res.body.recommendations.some((item: any) => item.title === "Current team capacity is tight"));
    assert.ok(res.body.recommendations.some((item: any) => item.title === "Lead source needs review: Google"));
  });
});
