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

describe("Basic Industry Model", () => {
  let adminToken: string; let workerToken: string; let companyId: string;
  let serviceId: string; let industryId: string; let linkId: string;
  before(async () => {
    await resetDb();
    const seeded = await seedCompanyAndAdmin(); companyId = seeded.company.id;
    adminToken = await loginAs("admin@test.local"); workerToken = await loginAs("worker@test.local");
    const service = await prisma.serviceCatalogueItem.create({
      data: { companyId, name: "Office refurbishment", defaultRequiredSkills: ["plastering"] },
    });
    serviceId = service.id;
  });
  after(async () => { await resetDb(); await prisma.$disconnect(); });

  it("enforces crm permissions", async () => {
    const list = await request(app).get("/industries").set("Authorization", `Bearer ${workerToken}`);
    assert.equal(list.status, 403);
    const create = await request(app).post("/industries").set("Authorization", `Bearer ${workerToken}`).send({ name: "Offices" });
    assert.equal(create.status, 403);
  });

  it("creates an explicit sourced industry and audit evidence", async () => {
    const res = await request(app).post("/industries").set("Authorization", `Bearer ${adminToken}`).send({
      name: "Commercial offices", description: "Office property clients", source: "user_input",
      verification_status: "confirmed", notes: "Confirmed by owner",
    });
    assert.equal(res.status, 201); assert.equal(res.body.name, "Commercial offices");
    assert.equal(res.body.verificationStatus, "confirmed"); industryId = res.body.id;
    const audit = await prisma.auditLog.findFirst({ where: { actionName: "create_industry", result: "success" } });
    assert.equal((audit?.dataAfter as any)?.id, industryId);
  });

  it("rejects a case-insensitive duplicate industry", async () => {
    const res = await request(app).post("/industries").set("Authorization", `Bearer ${adminToken}`).send({ name: "commercial OFFICES" });
    assert.equal(res.status, 409); assert.equal(res.body.error, "INDUSTRY_ALREADY_EXISTS");
  });

  it("links a real catalogue service and includes it in industry reads", async () => {
    const linked = await request(app).post(`/industries/${industryId}/services`).set("Authorization", `Bearer ${adminToken}`).send({
      service_catalogue_item_id: serviceId, notes: "Common service for this industry",
    });
    assert.equal(linked.status, 201); assert.equal(linked.body.serviceCatalogueItemId, serviceId); linkId = linked.body.id;
    const get = await request(app).get(`/industries/${industryId}`).set("Authorization", `Bearer ${adminToken}`);
    assert.equal(get.status, 200); assert.equal(get.body.serviceLinks.length, 1);
    assert.equal(get.body.serviceLinks[0].serviceCatalogueItem.name, "Office refurbishment");
  });

  it("archives and restores a service link without deleting evidence", async () => {
    const archived = await request(app).put(`/industries/service-links/${linkId}`).set("Authorization", `Bearer ${adminToken}`).send({ is_active: false });
    assert.equal(archived.status, 200); assert.equal(archived.body.isActive, false);
    const restored = await request(app).post(`/industries/${industryId}/services`).set("Authorization", `Bearer ${adminToken}`).send({ service_catalogue_item_id: serviceId });
    assert.equal(restored.status, 200); assert.equal(restored.body.id, linkId); assert.equal(restored.body.isActive, true);
  });

  it("rejects foreign services and keeps industries tenant-isolated", async () => {
    const companyB = await prisma.company.create({ data: { name: "Other Industry Co" } });
    const passwordHash = await bcrypt.hash("Password123!", 10);
    await prisma.user.create({ data: { companyId: companyB.id, email: "industries-b@test.local", passwordHash, displayName: "Other Admin", role: "admin", permissions: ["crm.read", "crm.manage"] } });
    const serviceB = await prisma.serviceCatalogueItem.create({ data: { companyId: companyB.id, name: "Foreign service" } });
    const tokenB = await loginAs("industries-b@test.local");
    const get = await request(app).get(`/industries/${industryId}`).set("Authorization", `Bearer ${tokenB}`);
    assert.equal(get.status, 404);
    const foreignService = await request(app).post(`/industries/${industryId}/services`).set("Authorization", `Bearer ${adminToken}`).send({ service_catalogue_item_id: serviceB.id });
    assert.equal(foreignService.status, 404); assert.equal(foreignService.body.error, "SERVICE_NOT_FOUND");
  });

  it("updates and archives an industry", async () => {
    const res = await request(app).put(`/industries/${industryId}`).set("Authorization", `Bearer ${adminToken}`).send({ description: "Updated explicit description", is_active: false });
    assert.equal(res.status, 200); assert.equal(res.body.isActive, false);
    const active = await request(app).get("/industries?active_only=true").set("Authorization", `Bearer ${adminToken}`);
    assert.ok(!active.body.some((industry: any) => industry.id === industryId));
  });
});
