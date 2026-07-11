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

describe("Business Context Layer", () => {
  let adminToken: string;
  let workerToken: string;
  let contextItemId: string;

  before(async () => {
    await resetDb();
    await seedCompanyAndAdmin();
    adminToken = await loginAs("admin@test.local");
    workerToken = await loginAs("worker@test.local");
  });

  after(async () => {
    await resetDb();
    await prisma.$disconnect();
  });

  it("requires crm.read to list context items", async () => {
    const res = await request(app).get("/business-context").set("Authorization", `Bearer ${workerToken}`);
    assert.equal(res.status, 403);
  });

  it("requires crm.manage to create a context item", async () => {
    const res = await request(app)
      .post("/business-context")
      .set("Authorization", `Bearer ${workerToken}`)
      .send({ category: "industry", label: "Industry", value: "Property maintenance" });
    assert.equal(res.status, 403);
  });

  it("validates category, label and value", async () => {
    const res = await request(app)
      .post("/business-context")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ category: "made_up_category", label: "", value: "" });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "VALIDATION_FAILED");
  });

  it("creates a business context item with source and verification status, and records audit", async () => {
    const res = await request(app)
      .post("/business-context")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        category: "industry",
        label: "Primary industry",
        value: "Property maintenance and refurbishment",
        source: "user_input",
        verification_status: "confirmed",
        notes: "Confirmed by owner",
      });
    assert.equal(res.status, 201);
    assert.equal(res.body.category, "industry");
    assert.equal(res.body.source, "user_input");
    assert.equal(res.body.verificationStatus, "confirmed");
    assert.equal(res.body.isActive, true);
    contextItemId = res.body.id;

    const audit = await prisma.auditLog.findFirst({
      where: { actionName: "create_business_context_item", result: "success" },
    });
    assert.ok(audit);
    assert.equal((audit?.dataAfter as any)?.id, contextItemId);
    assert.equal(audit?.riskLevel, 2);
  });

  it("gets a single context item and returns not found for an unknown id", async () => {
    const ok = await request(app).get(`/business-context/${contextItemId}`).set("Authorization", `Bearer ${adminToken}`);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.id, contextItemId);

    const missing = await request(app)
      .get("/business-context/00000000-0000-0000-0000-000000000099")
      .set("Authorization", `Bearer ${adminToken}`);
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error, "BUSINESS_CONTEXT_ITEM_NOT_FOUND");
  });

  it("lists context items and filters by category and active_only", async () => {
    await request(app)
      .post("/business-context")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ category: "region", label: "Service area", value: "Birmingham and surrounding areas" });

    const all = await request(app).get("/business-context").set("Authorization", `Bearer ${adminToken}`);
    assert.equal(all.status, 200);
    assert.ok(all.body.length >= 2);

    const industries = await request(app)
      .get("/business-context?category=industry")
      .set("Authorization", `Bearer ${adminToken}`);
    assert.equal(industries.status, 200);
    assert.ok(industries.body.every((item: any) => item.category === "industry"));

    const activeOnly = await request(app)
      .get("/business-context?active_only=true")
      .set("Authorization", `Bearer ${adminToken}`);
    assert.equal(activeOnly.status, 200);
    assert.ok(activeOnly.body.every((item: any) => item.isActive === true));
  });

  it("updates and archives a context item with before/after audit", async () => {
    const res = await request(app)
      .put(`/business-context/${contextItemId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        value: "Property maintenance, refurbishment and repair",
        verification_status: "confirmed",
        is_active: false,
      });
    assert.equal(res.status, 200);
    assert.equal(res.body.value, "Property maintenance, refurbishment and repair");
    assert.equal(res.body.isActive, false);

    const audit = await prisma.auditLog.findFirst({
      where: { actionName: "update_business_context_item", result: "success" },
      orderBy: { createdAt: "desc" },
    });
    assert.ok(audit);
    assert.equal((audit?.dataBefore as any)?.isActive, true);
    assert.equal((audit?.dataAfter as any)?.isActive, false);
  });

  it("rejects invalid updates and missing ids", async () => {
    const invalid = await request(app)
      .put(`/business-context/${contextItemId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ source: "invented_source" });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error, "VALIDATION_FAILED");

    const missing = await request(app)
      .put("/business-context/00000000-0000-0000-0000-000000000099")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ label: "Nope" });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error, "BUSINESS_CONTEXT_ITEM_NOT_FOUND");
  });

  it("keeps company context isolated between tenants", async () => {
    const companyB = await prisma.company.create({ data: { name: "Other Co" } });
    const passwordHash = await bcrypt.hash("Password123!", 10);
    await prisma.user.create({
      data: {
        companyId: companyB.id,
        email: "business-context-b@test.local",
        passwordHash,
        displayName: "Other Admin",
        role: "admin",
        permissions: ["crm.read", "crm.manage"],
      },
    });
    const tokenB = await loginAs("business-context-b@test.local");

    const createB = await request(app)
      .post("/business-context")
      .set("Authorization", `Bearer ${tokenB}`)
      .send({ category: "region", label: "Region B", value: "Manchester" });
    assert.equal(createB.status, 201);
    const itemBId = createB.body.id;

    const getAsA = await request(app).get(`/business-context/${itemBId}`).set("Authorization", `Bearer ${adminToken}`);
    assert.equal(getAsA.status, 404);

    const updateAsA = await request(app)
      .put(`/business-context/${itemBId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ value: "Hijacked" });
    assert.equal(updateAsA.status, 404);

    const listAsA = await request(app).get("/business-context").set("Authorization", `Bearer ${adminToken}`);
    assert.ok(!listAsA.body.some((item: any) => item.id === itemBId));
  });
});
