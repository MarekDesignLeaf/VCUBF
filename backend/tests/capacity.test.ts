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

describe("Job Allocation and Capacity Management Module", () => {
  let adminToken: string;
  let workerId: string;
  let clientId: string;

  before(async () => {
    await resetDb();
    const { worker } = await seedCompanyAndAdmin();
    workerId = worker.id;
    // Give the worker real capacity data: a declared weekly capacity and one skill.
    await prisma.user.update({
      where: { id: worker.id },
      data: { weeklyCapacityHours: 10, skills: ["plastering"] },
    });
    adminToken = await loginAs("admin@test.local");

    const clientRes = await request(app)
      .post("/crm/clients")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ display_name: "Capacity Test Client" });
    clientId = clientRes.body.id;
  });

  after(async () => {
    await prisma.$disconnect();
  });

  it("lists employees with their current workload attached", async () => {
    const res = await request(app).get("/crm/employees").set("Authorization", `Bearer ${adminToken}`);
    assert.equal(res.status, 200);
    const worker = res.body.find((e: any) => e.id === workerId);
    assert.ok(worker, "worker should be in the list");
    assert.equal(worker.weeklyCapacityHours, 10);
    assert.deepEqual(worker.skills, ["plastering"]);
    assert.equal(worker.capacity.currentLoadHours, 0);
    assert.equal(worker.capacity.overloaded, false);
  });

  it("assigns a job within capacity with no warning", async () => {
    const monday = nextMonday();
    const jobRes = await request(app)
      .post("/crm/jobs")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        client_id: clientId,
        job_title: "Small plaster patch",
        job_status: "prijato",
        planned_start_at: monday.toISOString(),
        estimated_duration_hours: 4,
        required_skills: ["plastering"],
      });
    assert.equal(jobRes.status, 201);

    const assignRes = await request(app)
      .put(`/crm/jobs/${jobRes.body.id}/assign`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ assigned_user_id: workerId });
    assert.equal(assignRes.status, 200);
    assert.equal(assignRes.body.job.assignedUserId, workerId);
    assert.equal(assignRes.body.capacityWarning, null);
    assert.deepEqual(assignRes.body.missingSkills, []);
  });

  it("warns on overload when the projected load exceeds weekly capacity", async () => {
    const monday = nextMonday();
    // Worker capacity is 10h/week; this job alone is 12h -> should overload.
    const jobRes = await request(app)
      .post("/crm/jobs")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        client_id: clientId,
        job_title: "Big re-plaster job",
        job_status: "prijato",
        planned_start_at: monday.toISOString(),
        estimated_duration_hours: 12,
      });
    assert.equal(jobRes.status, 201);

    const assignRes = await request(app)
      .put(`/crm/jobs/${jobRes.body.id}/assign`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ assigned_user_id: workerId });
    assert.equal(assignRes.status, 200);
    assert.equal(assignRes.body.capacityWarning.type, "OVERLOAD");
  });

  it("flags a skill gap without blocking the assignment", async () => {
    const jobRes = await request(app)
      .post("/crm/jobs")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ client_id: clientId, job_title: "Electrical rewire", job_status: "prijato", required_skills: ["electrical"] });
    assert.equal(jobRes.status, 201);

    const assignRes = await request(app)
      .put(`/crm/jobs/${jobRes.body.id}/assign`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ assigned_user_id: workerId });
    assert.equal(assignRes.status, 200);
    assert.deepEqual(assignRes.body.missingSkills, ["electrical"]);
    // No planned date on this job -> capacity explicitly not evaluated, not guessed.
    assert.equal(assignRes.body.capacityWarning.type, "NO_PLANNED_DATE");
  });

  it("rejects assigning to an employee outside the company", async () => {
    const jobRes = await request(app)
      .post("/crm/jobs")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ client_id: clientId, job_title: "Orphan job", job_status: "prijato" });

    const assignRes = await request(app)
      .put(`/crm/jobs/${jobRes.body.id}/assign`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ assigned_user_id: "00000000-0000-0000-0000-000000000099" });
    assert.equal(assignRes.status, 404);
    assert.equal(assignRes.body.error, "EMPLOYEE_NOT_FOUND");
  });

  it("check_capacity endpoint returns the same computed data", async () => {
    const res = await request(app)
      .get(`/crm/employees/${workerId}/capacity`)
      .set("Authorization", `Bearer ${adminToken}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.employeeId, workerId);
    assert.equal(res.body.weeklyCapacityHours, 10);
    assert.ok(typeof res.body.overloaded === "boolean");
  });
});

function nextMonday(): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7 || 7));
  d.setUTCHours(9, 0, 0, 0);
  return d;
}
