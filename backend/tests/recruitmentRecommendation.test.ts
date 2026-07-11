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
function mondayOffset(weeks: number) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + ((8 - date.getUTCDay()) % 7 || 7) + weeks * 7);
  date.setUTCHours(9, 0, 0, 0);
  return date;
}

describe("Capacity-backed recruitment recommendation", () => {
  let adminToken: string; let workerToken: string; let companyId: string; let workerId: string; let clientId: string;
  before(async () => {
    await resetDb();
    const seeded = await seedCompanyAndAdmin(); companyId = seeded.company.id; workerId = seeded.worker.id;
    await prisma.user.update({ where: { id: workerId }, data: { weeklyCapacityHours: 5, skills: ["electrical"] } });
    const client = await prisma.client.create({ data: { companyId, displayName: "Capacity Client" } }); clientId = client.id;
    adminToken = await loginAs("admin@test.local"); workerToken = await loginAs("worker@test.local");
  });
  after(async () => { await resetDb(); await prisma.$disconnect(); });

  it("requires recruitment.manage permission", async () => {
    const res = await request(app).get("/recruitment/capacity-recommendation").set("Authorization", `Bearer ${workerToken}`);
    assert.equal(res.status, 403);
  });

  it("does not recommend recruitment without repeated overload evidence", async () => {
    const job = await prisma.job.create({ data: {
      companyId, clientId, jobTitle: "First electrical installation", jobStatus: "prijato",
      assignedUserId: workerId, plannedStartAt: mondayOffset(0), estimatedDurationHours: 8, requiredSkills: ["electrical"],
    } });
    const res = await request(app).get("/recruitment/capacity-recommendation?weeks_ahead=6").set("Authorization", `Bearer ${adminToken}`);
    assert.equal(res.status, 200); assert.equal(res.body.decision, "not_recommended");
    assert.equal(res.body.evidence.distinctOverloadedWeeks, 1); assert.equal(res.body.recommendation, null);
    assert.ok(job.id);
  });

  it("recommends a role, skills, tasks, urgency and fastest route after repeated insufficiency", async () => {
    const second = await prisma.job.create({ data: {
      companyId, clientId, jobTitle: "Second electrical installation", jobStatus: "prijato",
      assignedUserId: workerId, plannedStartAt: mondayOffset(1), estimatedDurationHours: 9, requiredSkills: ["electrical"],
    } });
    const openingsBefore = await prisma.jobOpening.count({ where: { companyId } });
    const res = await request(app).get("/recruitment/capacity-recommendation?weeks_ahead=6&minimum_repeated_weeks=2").set("Authorization", `Bearer ${adminToken}`);
    assert.equal(res.status, 200); assert.equal(res.body.decision, "recommend_recruitment_review");
    assert.equal(res.body.recommendation.role, "Electrical specialist");
    assert.deepEqual(res.body.recommendation.requiredSkills, ["electrical"]);
    assert.ok(res.body.recommendation.expectedTasks.includes("First electrical installation"));
    assert.ok(res.body.recommendation.expectedTasks.includes("Second electrical installation"));
    assert.equal(res.body.recommendation.urgency, "high");
    assert.ok(res.body.recommendation.fastestRoute.includes("temporary worker"));
    assert.ok(res.body.evidence.sourceJobIds.includes(second.id));
    assert.equal(await prisma.jobOpening.count({ where: { companyId } }), openingsBefore, "recommendation must not create an opening");
    const audit = await prisma.auditLog.findFirst({ where: { actionName: "get_recruitment_recommendation", result: "success" }, orderBy: { createdAt: "desc" } });
    assert.ok(audit);
  });

  it("validates evidence thresholds", async () => {
    const res = await request(app).get("/recruitment/capacity-recommendation?weeks_ahead=1&minimum_repeated_weeks=1").set("Authorization", `Bearer ${adminToken}`);
    assert.equal(res.status, 400); assert.equal(res.body.error, "VALIDATION_FAILED");
  });
});
