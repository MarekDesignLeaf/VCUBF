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

describe("Calendar and Scheduling Intelligence Module", () => {
  let adminToken: string;
  let workerId: string;
  let clientId: string;

  before(async () => {
    await resetDb();
    const { worker } = await seedCompanyAndAdmin();
    workerId = worker.id;
    await prisma.user.update({
      where: { id: worker.id },
      data: { weeklyCapacityHours: 10, skills: ["plastering"] },
    });
    adminToken = await loginAs("admin@test.local");

    const clientRes = await request(app)
      .post("/crm/clients")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ display_name: "Calendar Test Client" });
    clientId = clientRes.body.id;
  });

  after(async () => {
    await prisma.$disconnect();
  });

  it("returns planned jobs within a date window", async () => {
    const monday = nextMonday();
    const jobRes = await request(app)
      .post("/crm/jobs")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ client_id: clientId, job_title: "Agenda job", planned_start_at: monday.toISOString() });
    assert.equal(jobRes.status, 201);

    const from = new Date(monday);
    from.setUTCDate(from.getUTCDate() - 1);
    const to = new Date(monday);
    to.setUTCDate(to.getUTCDate() + 1);

    const res = await request(app)
      .get(`/calendar/jobs?from=${from.toISOString()}&to=${to.toISOString()}`)
      .set("Authorization", `Bearer ${adminToken}`);
    assert.equal(res.status, 200);
    assert.ok(res.body.some((j: any) => j.id === jobRes.body.id));
  });

  it("rejects a calendar query with an invalid date range", async () => {
    const res = await request(app)
      .get(`/calendar/jobs?from=not-a-date&to=also-not-a-date`)
      .set("Authorization", `Bearer ${adminToken}`);
    assert.equal(res.status, 400);
  });

  it("detects upcoming overload and attaches the standard mitigation menu", async () => {
    const monday = nextMonday();
    const jobRes = await request(app)
      .post("/crm/jobs")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        client_id: clientId,
        job_title: "Overload-causing job",
        job_status: "prijato",
        planned_start_at: monday.toISOString(),
        estimated_duration_hours: 20,
      });
    await request(app)
      .put(`/crm/jobs/${jobRes.body.id}/assign`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ assigned_user_id: workerId });

    const res = await request(app)
      .get("/calendar/overload?weeks_ahead=4")
      .set("Authorization", `Bearer ${adminToken}`);
    assert.equal(res.status, 200);
    assert.ok(res.body.overloadedWeeks.some((w: any) => w.employeeId === workerId));
    assert.ok(res.body.suggestions.length > 0);
  });

  it("suggests employees for a new job ranked by real spare capacity and skill fit", async () => {
    const res = await request(app)
      .get("/calendar/suggest?estimated_duration_hours=3&required_skills=plastering")
      .set("Authorization", `Bearer ${adminToken}`);
    assert.equal(res.status, 200);
    const worker = res.body.find((e: any) => e.employeeId === workerId);
    assert.ok(worker);
    assert.equal(worker.hasAllRequiredSkills, true);
  });

  it("reports missing skills without excluding the employee from suggestions", async () => {
    const res = await request(app)
      .get("/calendar/suggest?estimated_duration_hours=2&required_skills=electrical")
      .set("Authorization", `Bearer ${adminToken}`);
    assert.equal(res.status, 200);
    const worker = res.body.find((e: any) => e.employeeId === workerId);
    assert.ok(worker);
    assert.equal(worker.hasAllRequiredSkills, false);
    assert.deepEqual(worker.missingSkills, ["electrical"]);
  });
});
