import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import request from "supertest";
import { prisma } from "../src/db.js";
import { createServer } from "../src/server.js";
import { resetDb, seedCompanyAndAdmin } from "./setup.js";

const app = createServer();

async function login(email: string) {
  const response = await request(app).post("/auth/login").send({ email, password: "Password123!" });
  return response.body.token as string;
}

describe("Reference activity catalogue", () => {
  let adminToken: string;
  let workerToken: string;

  before(async () => {
    await resetDb();
    await seedCompanyAndAdmin();
    adminToken = await login("admin@test.local");
    workerToken = await login("worker@test.local");
  });

  after(async () => {
    await resetDb();
    await prisma.$disconnect();
  });

  it("requires CRM read permission", async () => {
    const response = await request(app)
      .get("/service-catalogue/reference-activities")
      .set("Authorization", `Bearer ${workerToken}`);
    assert.equal(response.status, 403);
  });

  it("loads and deduplicates the supplied catalogue with complete diagnostics", async () => {
    const response = await request(app)
      .get("/service-catalogue/reference-activities?limit=25")
      .set("Authorization", `Bearer ${adminToken}`);
    assert.equal(response.status, 200);
    assert.equal(response.body.items.length, 25);
    assert.equal(response.body.catalogue.rawRowCount, 1817);
    assert.equal(response.body.catalogue.uniqueActivityCount, 1810);
    assert.equal(response.body.catalogue.duplicateRowCount, 7);
    assert.equal(response.body.catalogue.industryCount, 14);
    assert.equal(response.body.industries.length, 14);
    assert.ok(response.body.catalogue.pricingDisclaimer.includes("never copied"));
  });

  it("searches by code and returns a duplicated source activity only once", async () => {
    const code = "cleaning_waste_and_exterior_washing.pressure_washing.driveway_cleaning";
    const response = await request(app)
      .get(`/service-catalogue/reference-activities?search=${encodeURIComponent(code)}`)
      .set("Authorization", `Bearer ${adminToken}`);
    assert.equal(response.status, 200);
    assert.equal(response.body.total, 1);
    assert.equal(response.body.items[0].activityCode, code);
  });

  it("does not activate an activity or reference price before explicit confirmation", async () => {
    const code = "garden_landscaping_tree_and_outdoor_work.landscaping.garden_maintenance";
    const response = await request(app)
      .post(`/service-catalogue/reference-activities/${code}/activate`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ confirmed: false });
    assert.equal(response.status, 409);
    assert.equal(response.body.error, "CONFIRMATION_REQUIRED");
    assert.equal(response.body.preview.activity.oxfordshireRateGbp, 60);
    assert.equal(response.body.preview.referenceRateAppliedToCompanyPrice, false);
    assert.equal(await prisma.serviceCatalogueItem.count(), 0);
    assert.equal(await prisma.industry.count(), 0);
  });

  it("activates one confirmed activity, creates its industry link and leaves company price unknown", async () => {
    const code = "garden_landscaping_tree_and_outdoor_work.landscaping.garden_maintenance";
    const response = await request(app)
      .post(`/service-catalogue/reference-activities/${code}/activate`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ confirmed: true });
    assert.equal(response.status, 201);
    assert.equal(response.body.service.name, "Garden maintenance");
    assert.equal(response.body.service.category, "Landscaping");
    assert.equal(response.body.service.basePriceMin, null);
    assert.equal(response.body.service.basePriceMax, null);
    assert.equal(response.body.service.priceUnit, null);
    assert.equal(response.body.service.referenceRateGbp, 60);
    assert.equal(response.body.service.referenceActivityCode, code);
    assert.equal(response.body.service.source, "confirmed_reference_activity");
    assert.equal(response.body.industry.name, "Garden, Landscaping, Tree And Outdoor Work");
    assert.equal(response.body.industry.verificationStatus, "confirmed");
    assert.equal(response.body.link.industryId, response.body.industry.id);
    assert.equal(response.body.link.serviceCatalogueItemId, response.body.service.id);

    const listed = await request(app)
      .get(`/service-catalogue/reference-activities?search=${encodeURIComponent(code)}`)
      .set("Authorization", `Bearer ${adminToken}`);
    assert.equal(listed.body.items[0].activatedServiceId, response.body.service.id);
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { actionName: "activate_reference_activity", result: "success" },
    });
    assert.equal((audit.inputPayload as any).companyPriceEntered, false);
  });

  it("rejects duplicate activation and accepts only explicitly entered company pricing", async () => {
    const existingCode = "garden_landscaping_tree_and_outdoor_work.landscaping.garden_maintenance";
    const duplicate = await request(app)
      .post(`/service-catalogue/reference-activities/${existingCode}/activate`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ confirmed: true });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error, "REFERENCE_ACTIVITY_ALREADY_ACTIVATED");

    const pricedCode = "garden_landscaping_tree_and_outdoor_work.landscaping.weeding";
    const priced = await request(app)
      .post(`/service-catalogue/reference-activities/${pricedCode}/activate`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ confirmed: true, base_price_min: 25, base_price_max: 35, price_unit: "GBP/h" });
    assert.equal(priced.status, 201);
    assert.equal(priced.body.service.basePriceMin, 25);
    assert.equal(priced.body.service.basePriceMax, 35);
    assert.equal(priced.body.service.priceUnit, "GBP/h");
    assert.equal(priced.body.service.referenceRateGbp, 24);
    assert.equal(await prisma.industry.count(), 1, "activities in the same industry reuse the confirmed industry");
  });
});
