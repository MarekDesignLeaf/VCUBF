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

describe("Service Catalogue Module", () => {
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
      .send({ display_name: "Catalogue Test Client" });
    clientId = clientRes.body.id;
  });

  after(async () => {
    await prisma.$disconnect();
  });

  it("rejects service creation without crm.manage permission (403)", async () => {
    const res = await request(app)
      .post("/service-catalogue")
      .set("Authorization", `Bearer ${workerToken}`)
      .send({ name: "Fence repair" });
    assert.equal(res.status, 403);
  });

  it("creates a service catalogue item with real user-entered data", async () => {
    const res = await request(app)
      .post("/service-catalogue")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        name: "Fence repair",
        category: "Fencing",
        base_price_min: 150,
        base_price_max: 400,
        price_unit: "per job",
        default_duration_hours: 4,
        default_required_skills: ["fencing"],
      });
    assert.equal(res.status, 201);
    assert.equal(res.body.name, "Fence repair");
    assert.equal(res.body.isActive, true);

    const audit = await prisma.auditLog.findFirst({
      where: { actionName: "create_service_catalogue_item", result: "success" },
    });
    assert.ok(audit);
  });

  it("validates required fields", async () => {
    const res = await request(app)
      .post("/service-catalogue")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ category: "Fencing" });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "VALIDATION_FAILED");
  });

  it("lists active services by default and can filter to active_only", async () => {
    const listRes = await request(app).get("/service-catalogue").set("Authorization", `Bearer ${adminToken}`);
    assert.equal(listRes.status, 200);
    assert.ok(listRes.body.some((s: any) => s.name === "Fence repair"));

    const filteredRes = await request(app)
      .get("/service-catalogue?active_only=true")
      .set("Authorization", `Bearer ${adminToken}`);
    assert.equal(filteredRes.status, 200);
    assert.ok(filteredRes.body.every((s: any) => s.isActive === true));
  });

  it("updates a service and records before/after in the audit log", async () => {
    const service = await prisma.serviceCatalogueItem.findFirst({ where: { name: "Fence repair" } });
    const res = await request(app)
      .put(`/service-catalogue/${service!.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ base_price_min: 175 });
    assert.equal(res.status, 200);
    assert.equal(res.body.basePriceMin, 175);

    const audit = await prisma.auditLog.findFirst({
      where: { actionName: "update_service_catalogue_item", result: "success" },
      orderBy: { createdAt: "desc" },
    });
    assert.equal((audit?.dataBefore as any)?.basePriceMin, 150);
    assert.equal((audit?.dataAfter as any)?.basePriceMin, 175);
  });

  it("deactivates a service via is_active without deleting it", async () => {
    const service = await prisma.serviceCatalogueItem.findFirst({ where: { name: "Fence repair" } });
    const res = await request(app)
      .put(`/service-catalogue/${service!.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ is_active: false });
    assert.equal(res.status, 200);
    assert.equal(res.body.isActive, false);

    const stillGettable = await request(app)
      .get(`/service-catalogue/${service!.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    assert.equal(stillGettable.status, 200);
  });

  it("returns SERVICE_NOT_FOUND for an update to a nonexistent id", async () => {
    const res = await request(app)
      .put("/service-catalogue/00000000-0000-0000-0000-000000000099")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "x" });
    assert.equal(res.status, 404);
    assert.equal(res.body.error, "SERVICE_NOT_FOUND");
  });

  it("links a job to a catalogue item via service_catalogue_item_id", async () => {
    const createRes = await request(app)
      .post("/service-catalogue")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Hedge trim", default_duration_hours: 2 });
    const serviceId = createRes.body.id;

    const jobRes = await request(app)
      .post("/crm/jobs")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ client_id: clientId, job_title: "Hedge trim for Smith", service_catalogue_item_id: serviceId });
    assert.equal(jobRes.status, 201);
    assert.equal(jobRes.body.serviceCatalogueItemId, serviceId);

    const getRes = await request(app)
      .get(`/crm/jobs/${jobRes.body.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    assert.equal(getRes.body.serviceCatalogueItem.name, "Hedge trim");
  });
});
