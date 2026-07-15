import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import request from "supertest";
import { createServer } from "../src/server.js";
import { prisma } from "../src/db.js";
import { resetDb, seedCompanyAndAdmin } from "./setup.js";

const app = createServer();
let token = "";
let jobId = "";

describe("Job materials and resources", () => {
  before(async () => {
    await resetDb();
    const { company } = await seedCompanyAndAdmin();
    token = (await request(app).post("/auth/login").send({ email: "admin@test.local", password: "Password123!" })).body.token;
    const client = await prisma.client.create({ data: { companyId: company.id, displayName: "Resource Client" } });
    const job = await prisma.job.create({
      data: { companyId: company.id, clientId: client.id, jobTitle: "New grass", plannedStartAt: new Date(Date.now() + 86_400_000) },
    });
    jobId = job.id;
  });

  after(async () => {
    await resetDb();
    await prisma.$disconnect();
  });

  it("records real requirements and reports unknown cost", async () => {
    const response = await request(app)
      .post(`/crm/jobs/${jobId}/resources`)
      .set("Authorization", `Bearer ${token}`)
      .send({ resource_type: "material", name: "Paving slabs", quantity: 20, unit: "m2" });
    assert.equal(response.status, 201);
    const listed = await request(app).get(`/crm/jobs/${jobId}/resources`).set("Authorization", `Bearer ${token}`);
    assert.equal(listed.body.readiness.notReady, 1);
    assert.equal(listed.body.readiness.estimatedCost, null);
  });

  it("lets Emma resolve a quoted exact job title and add material to it", async () => {
    const response = await request(app)
      .post("/command/text")
      .set("Authorization", `Bearer ${token}`)
      .send({
        text: 'voice action add_job_resource {"job_title":"„New grass”","resource_type":"material","name":"Topsoil"}',
        input_method: "voice_transcript",
      });
    assert.equal(response.status, 201);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.intent, "execute_action");
    assert.equal(await prisma.jobResourceRequirement.count({ where: { jobId, name: "Topsoil" } }), 1);
  });

  it("surfaces upcoming jobs with resources not ready", async () => {
    const feed = await request(app).get("/notifications").set("Authorization", `Bearer ${token}`);
    assert.ok(feed.body.some((item: any) => item.type === "resource_not_ready" && item.entity.id === jobId));
  });

  it("marks a requirement ready", async () => {
    const requirement = await prisma.jobResourceRequirement.findFirstOrThrow({ where: { jobId } });
    await request(app)
      .put(`/crm/jobs/${jobId}/resources/${requirement.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ requirement_status: "ready", actual_cost: 300 });
    const listed = await request(app).get(`/crm/jobs/${jobId}/resources`).set("Authorization", `Bearer ${token}`);
    assert.equal(listed.body.readiness.actualCost, null);
    assert.equal(listed.body.items.find((item: { id: string }) => item.id === requirement.id).requirementStatus, "ready");
  });
});
