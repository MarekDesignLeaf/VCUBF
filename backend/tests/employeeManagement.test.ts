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

describe("Employee and Permission Model management", () => {
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

  it("rejects employee creation without users.manage permission (403)", async () => {
    const res = await request(app)
      .post("/crm/employees")
      .set("Authorization", `Bearer ${workerToken}`)
      .send({ display_name: "New Guy", email: "newguy@test.local", password: "Password123!" });
    assert.equal(res.status, 403);
  });

  it("requires confirmation before creating an employee, returning a preview", async () => {
    const res = await request(app)
      .post("/crm/employees")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ display_name: "Jane Plasterer", email: "jane.p@test.local", password: "Password123!", skills: ["plastering"] });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, "CONFIRMATION_REQUIRED");
    assert.equal(res.body.preview.email, "jane.p@test.local");

    const noUser = await prisma.user.findUnique({ where: { email: "jane.p@test.local" } });
    assert.equal(noUser, null, "nothing should be created before confirmation");
  });

  it("creates the employee once confirmed: true is sent", async () => {
    const res = await request(app)
      .post("/crm/employees")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        display_name: "Jane Plasterer",
        email: "jane.p@test.local",
        password: "Password123!",
        skills: ["plastering"],
        weekly_capacity_hours: 35,
        confirmed: true,
      });
    assert.equal(res.status, 201);
    assert.equal(res.body.email, "jane.p@test.local");
    assert.equal(res.body.weeklyCapacityHours, 35);

    const audit = await prisma.auditLog.findFirst({
      where: { actionName: "create_employee", result: "success" },
      orderBy: { createdAt: "desc" },
    });
    assert.ok(audit);
    assert.equal(audit?.confirmed, true);
  });

  it("rejects creating a second employee with the same email", async () => {
    const res = await request(app)
      .post("/crm/employees")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ display_name: "Dup", email: "jane.p@test.local", password: "Password123!", confirmed: true });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, "EMAIL_ALREADY_EXISTS");
  });

  it("requires confirmation before updating an employee, returning a before/after preview", async () => {
    const employee = await prisma.user.findUnique({ where: { email: "jane.p@test.local" } });
    const res = await request(app)
      .put(`/crm/employees/${employee!.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ weekly_capacity_hours: 20 });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, "CONFIRMATION_REQUIRED");
    assert.equal(res.body.preview.before.weeklyCapacityHours, 35);
    assert.equal(res.body.preview.changes.weeklyCapacityHours, 20);

    const unchanged = await prisma.user.findUnique({ where: { id: employee!.id } });
    assert.equal(unchanged?.weeklyCapacityHours, 35, "nothing should change before confirmation");
  });

  it("updates the employee once confirmed: true is sent, and audits before/after", async () => {
    const employee = await prisma.user.findUnique({ where: { email: "jane.p@test.local" } });
    const res = await request(app)
      .put(`/crm/employees/${employee!.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ weekly_capacity_hours: 20, permissions: ["crm.read"], confirmed: true });
    assert.equal(res.status, 200);
    assert.equal(res.body.weeklyCapacityHours, 20);
    assert.deepEqual(res.body.permissions, ["crm.read"]);

    const audit = await prisma.auditLog.findFirst({
      where: { actionName: "update_employee", result: "success" },
      orderBy: { createdAt: "desc" },
    });
    assert.ok(audit);
    assert.equal((audit?.dataBefore as any)?.weeklyCapacityHours, 35);
    assert.equal((audit?.dataAfter as any)?.weeklyCapacityHours, 20);
  });

  it("can deactivate an employee via is_active, and the management view still finds them", async () => {
    const employee = await prisma.user.findUnique({ where: { email: "jane.p@test.local" } });
    const res = await request(app)
      .put(`/crm/employees/${employee!.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ is_active: false, confirmed: true });
    assert.equal(res.status, 200);
    assert.equal(res.body.isActive, false);

    const listRes = await request(app).get("/crm/employees").set("Authorization", `Bearer ${adminToken}`);
    assert.ok(!listRes.body.some((e: any) => e.id === employee!.id), "inactive employee should not appear in the active list");

    const manageRes = await request(app)
      .get(`/crm/employees/${employee!.id}/manage`)
      .set("Authorization", `Bearer ${adminToken}`);
    assert.equal(manageRes.status, 200);
    assert.equal(manageRes.body.isActive, false);
  });

  it("returns the known permission list for the UI", async () => {
    const res = await request(app).get("/crm/employees/meta/permissions").set("Authorization", `Bearer ${adminToken}`);
    assert.equal(res.status, 200);
    assert.ok(res.body.includes("crm.manage"));
  });
});
