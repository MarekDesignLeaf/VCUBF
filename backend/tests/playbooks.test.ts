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

describe("Playbook Engine", () => {
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

  it("rejects playbook creation without voice.execute permission (403)", async () => {
    const res = await request(app)
      .post("/playbooks")
      .set("Authorization", `Bearer ${workerToken}`)
      .send({ name: "New client onboarding", step_templates: ["create client {client_name}"] });
    assert.equal(res.status, 403);
  });

  it("validates that at least one step template is required", async () => {
    const res = await request(app)
      .post("/playbooks")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Empty playbook", step_templates: [] });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "VALIDATION_FAILED");
  });

  it("creates a playbook with real step templates", async () => {
    const res = await request(app)
      .post("/playbooks")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        name: "New client + job",
        description: "Create a client then a job for them",
        step_templates: ["create client {client_name}", "create job {job_title} for {client_name}"],
      });
    assert.equal(res.status, 201);
    assert.equal(res.body.isActive, true);
    assert.equal(res.body.stepTemplates.length, 2);

    const audit = await prisma.auditLog.findFirst({ where: { actionName: "create_playbook", result: "success" } });
    assert.ok(audit);
  });

  it("returns MISSING_VARIABLE when running a playbook without all required variables", async () => {
    const playbook = await prisma.playbook.findFirst({ where: { name: "New client + job" } });
    const res = await request(app)
      .post(`/playbooks/${playbook!.id}/run`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ variables: { client_name: "Riverside Apartments" } });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "MISSING_VARIABLE");
    assert.ok(res.body.missingVariables.includes("job_title"));
  });

  it("returns a resolved-step preview and CONFIRMATION_REQUIRED when not confirmed", async () => {
    const playbook = await prisma.playbook.findFirst({ where: { name: "New client + job" } });
    const res = await request(app)
      .post(`/playbooks/${playbook!.id}/run`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ variables: { client_name: "Riverside Apartments", job_title: "Gutter clean" } });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, "CONFIRMATION_REQUIRED");
    assert.equal(res.body.preview.steps.length, 2);
    assert.equal(res.body.preview.steps[0].resolvedText, "create client Riverside Apartments");
    assert.equal(res.body.preview.steps[0].interpretedIntent, "create_client");
    assert.equal(res.body.preview.steps[1].resolvedText, "create job Gutter clean for Riverside Apartments");

    // Nothing should have been created yet.
    const client = await prisma.client.findFirst({ where: { displayName: "Riverside Apartments" } });
    assert.equal(client, null);

    const audit = await prisma.auditLog.findFirst({
      where: { actionName: "run_playbook", errorMessage: "CONFIRMATION_REQUIRED" },
    });
    assert.ok(audit);
    assert.equal(audit?.confirmed, false);
  });

  it("executes every step in order when confirmed: true, and records a PlaybookRun", async () => {
    const playbook = await prisma.playbook.findFirst({ where: { name: "New client + job" } });
    const res = await request(app)
      .post(`/playbooks/${playbook!.id}/run`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        variables: { client_name: "Riverside Apartments", job_title: "Gutter clean" },
        confirmed: true,
      });
    assert.equal(res.status, 200);
    assert.equal(res.body.overallOk, true);
    assert.equal(res.body.stepResults.length, 2);
    assert.equal(res.body.stepResults[0].intent, "create_client");
    assert.equal(res.body.stepResults[0].ok, true);
    assert.equal(res.body.stepResults[1].intent, "create_job");
    assert.equal(res.body.stepResults[1].ok, true);

    const client = await prisma.client.findFirst({ where: { displayName: "Riverside Apartments" } });
    assert.ok(client);
    const job = await prisma.job.findFirst({ where: { jobTitle: "Gutter clean" } });
    assert.ok(job);
    assert.equal(job?.clientId, client?.id);

    const audit = await prisma.auditLog.findFirst({
      where: { actionName: "run_playbook", result: "success" },
      orderBy: { createdAt: "desc" },
    });
    assert.equal(audit?.confirmed, true);

    const runs = await prisma.playbookRun.findMany({ where: { playbookId: playbook!.id } });
    assert.equal(runs.length, 1);
    assert.equal(runs[0].overallOk, true);
  });

  it("stops at the first failing step instead of continuing silently", async () => {
    const badPlaybook = await request(app)
      .post("/playbooks")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        name: "Job for missing client",
        step_templates: ["create job {job_title} for {client_name}", "create client {client_name}"],
      });
    const res = await request(app)
      .post(`/playbooks/${badPlaybook.body.id}/run`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        variables: { client_name: "Nonexistent Client Co", job_title: "Roof repair" },
        confirmed: true,
      });
    assert.equal(res.status, 200);
    assert.equal(res.body.overallOk, false);
    // Only the failing first step should be recorded — the second step never ran.
    assert.equal(res.body.stepResults.length, 1);
    assert.equal(res.body.stepResults[0].ok, false);
    assert.equal(res.body.stepResults[0].error, "CLIENT_NOT_FOUND");

    const client = await prisma.client.findFirst({ where: { displayName: "Nonexistent Client Co" } });
    assert.equal(client, null);
  });

  it("returns PLAYBOOK_NOT_FOUND when running a nonexistent playbook", async () => {
    const res = await request(app)
      .post("/playbooks/00000000-0000-0000-0000-000000000099/run")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ confirmed: true });
    assert.equal(res.status, 404);
    assert.equal(res.body.error, "PLAYBOOK_NOT_FOUND");
  });

  it("updates a playbook's step templates, recording before/after in the audit log", async () => {
    const playbook = await prisma.playbook.findFirst({ where: { name: "New client + job" } });
    const res = await request(app)
      .put(`/playbooks/${playbook!.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ step_templates: ["create client {client_name}"] });
    assert.equal(res.status, 200);
    assert.equal(res.body.stepTemplates.length, 1);

    const audit = await prisma.auditLog.findFirst({
      where: { actionName: "update_playbook", result: "success" },
      orderBy: { createdAt: "desc" },
    });
    assert.equal((audit?.dataBefore as any)?.stepTemplates.length, 2);
    assert.equal((audit?.dataAfter as any)?.stepTemplates.length, 1);
  });

  it("returns PLAYBOOK_NOT_FOUND for an update to a nonexistent id", async () => {
    const res = await request(app)
      .put("/playbooks/00000000-0000-0000-0000-000000000099")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "x" });
    assert.equal(res.status, 404);
    assert.equal(res.body.error, "PLAYBOOK_NOT_FOUND");
  });

  it("lists playbooks and their run history", async () => {
    const listRes = await request(app).get("/playbooks").set("Authorization", `Bearer ${adminToken}`);
    assert.equal(listRes.status, 200);
    assert.ok(listRes.body.length >= 2);

    const playbook = await prisma.playbook.findFirst({ where: { name: "New client + job" } });
    const runsRes = await request(app)
      .get(`/playbooks/${playbook!.id}/runs`)
      .set("Authorization", `Bearer ${adminToken}`);
    assert.equal(runsRes.status, 200);
    assert.equal(runsRes.body.length, 1);
    assert.equal(runsRes.body[0].overallOk, true);
  });
});
