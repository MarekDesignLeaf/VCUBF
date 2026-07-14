import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import request from "supertest";
import { createServer } from "../src/server.js";
import { prisma } from "../src/db.js";
import { resetDb } from "./setup.js";

const app = createServer();

describe("Company-first setup", () => {
  let administratorToken = "";

  before(async () => {
    await resetDb();
  });

  after(async () => {
    await prisma.$disconnect();
  });

  it("requires setup before any company account exists", async () => {
    const status = await request(app).get("/auth/setup-status");
    assert.equal(status.status, 200);
    assert.deepEqual(status.body, { setupRequired: true });
  });

  it("creates a company and its primary administrator atomically", async () => {
    const setup = await request(app).post("/auth/setup").send({
      company_name: "Northwind Electrical",
      administrator_name: "Ava Owner",
      administrator_email: "ava@northwind.example",
      administrator_password: "SetupPassword456A",
    });
    assert.equal(setup.status, 201);
    assert.equal(setup.body.user.role, "administrator");
    assert.ok(setup.body.user.permissions.includes("company.manage"));
    administratorToken = setup.body.token;

    const company = await prisma.company.findFirstOrThrow({ include: { primaryAdministrator: true, systemSetup: true } });
    assert.equal(company.name, "Northwind Electrical");
    assert.equal(company.primaryAdministrator?.email, "ava@northwind.example");
    assert.equal(company.systemSetup?.id, "primary");
  });

  it("does not allow a second anonymous company setup", async () => {
    const retry = await request(app).post("/auth/setup").send({
      company_name: "Other Company",
      administrator_name: "Other Owner",
      administrator_email: "other@example.test",
      administrator_password: "SetupPassword456A",
    });
    assert.equal(retry.status, 409);
    assert.equal(retry.body.error, "SETUP_ALREADY_COMPLETED");
    assert.equal(await prisma.company.count(), 1);
  });

  it("lets the administrator maintain the company profile after setup", async () => {
    const current = await request(app).get("/company").set("Authorization", `Bearer ${administratorToken}`);
    assert.equal(current.status, 200);
    assert.equal(current.body.primaryAdministrator.role, "administrator");

    const changed = await request(app).put("/company").set("Authorization", `Bearer ${administratorToken}`).send({ name: "Northwind Electrical Ltd" });
    assert.equal(changed.status, 200);
    assert.equal(changed.body.name, "Northwind Electrical Ltd");
  });
});
