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

function nextMonday() {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + ((8 - date.getUTCDay()) % 7 || 7));
  date.setUTCHours(9, 0, 0, 0);
  return date;
}

describe("Task Management", () => {
  let adminToken: string;
  let workerToken: string;
  let companyId: string;
  let workerId: string;
  let clientAId: string;
  let clientBId: string;
  let jobId: string;
  let communicationId: string;
  let taskId: string;
  const monday = nextMonday();

  before(async () => {
    await resetDb();
    const seeded = await seedCompanyAndAdmin();
    companyId = seeded.company.id;
    workerId = seeded.worker.id;
    await prisma.user.update({
      where: { id: workerId },
      data: { weeklyCapacityHours: 3 },
    });
    adminToken = await loginAs("admin@test.local");
    workerToken = await loginAs("worker@test.local");

    const clientA = await prisma.client.create({ data: { companyId, displayName: "Task Client A" } });
    const clientB = await prisma.client.create({ data: { companyId, displayName: "Task Client B" } });
    clientAId = clientA.id;
    clientBId = clientB.id;
    const job = await prisma.job.create({
      data: { companyId, clientId: clientA.id, jobTitle: "Task-linked job" },
    });
    jobId = job.id;
    const communication = await prisma.communicationRecord.create({
      data: {
        companyId,
        clientId: clientA.id,
        jobId: job.id,
        channel: "email",
        direction: "inbound",
        summary: "Client requested a follow-up",
        occurredAt: new Date(),
      },
    });
    communicationId = communication.id;
  });

  after(async () => {
    await resetDb();
    await prisma.$disconnect();
  });

  it("requires crm.read and crm.manage permissions", async () => {
    const list = await request(app).get("/tasks").set("Authorization", `Bearer ${workerToken}`);
    assert.equal(list.status, 403);

    const create = await request(app)
      .post("/tasks")
      .set("Authorization", `Bearer ${workerToken}`)
      .send({ title: "Not allowed" });
    assert.equal(create.status, 403);
  });

  it("validates required fields and fixed status/priority values", async () => {
    const missing = await request(app)
      .post("/tasks")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ title: "", priority: "made_up" });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error, "VALIDATION_FAILED");
  });

  it("rejects inconsistent client and job links", async () => {
    const res = await request(app)
      .post("/tasks")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        title: "Mismatched task",
        client_id: clientBId,
        job_id: jobId,
      });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, "RELATED_RECORD_MISMATCH");
  });

  it("creates an assigned job task, derives its client and records audit evidence", async () => {
    const res = await request(app)
      .post("/tasks")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        title: "Prepare materials",
        job_id: jobId,
        assigned_user_id: workerId,
        due_at: monday.toISOString(),
        estimated_duration_hours: 2,
        priority: "high",
        category: "job_work",
        source: "job_workflow",
      });
    assert.equal(res.status, 201);
    assert.equal(res.body.task.clientId, clientAId);
    assert.equal(res.body.task.jobId, jobId);
    assert.equal(res.body.task.assignedUserId, workerId);
    assert.equal(res.body.task.taskStatus, "open");
    assert.equal(res.body.capacityWarning, null);
    taskId = res.body.task.id;

    const audit = await prisma.auditLog.findFirst({
      where: { actionName: "create_task", result: "success" },
      orderBy: { createdAt: "desc" },
    });
    assert.ok(audit);
    assert.equal((audit?.dataAfter as any)?.id, taskId);
  });

  it("derives client and job linkage from a communication follow-up", async () => {
    const res = await request(app)
      .post("/tasks")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        title: "Reply to client",
        communication_record_id: communicationId,
        category: "client_follow_up",
        source: "communication_follow_up",
      });
    assert.equal(res.status, 201);
    assert.equal(res.body.task.clientId, clientAId);
    assert.equal(res.body.task.jobId, jobId);
    assert.equal(res.body.task.communicationRecordId, communicationId);
  });

  it("includes entered task hours in capacity and warns when tasks overload the employee", async () => {
    const res = await request(app)
      .post("/tasks")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        title: "Second scheduled task",
        assigned_user_id: workerId,
        due_at: monday.toISOString(),
        estimated_duration_hours: 2,
      });
    assert.equal(res.status, 201);
    assert.equal(res.body.capacityWarning.type, "OVERLOAD");
    assert.equal(res.body.capacityWarning.currentLoadHours, 4);

    const capacity = await request(app)
      .get(`/crm/employees/${workerId}/capacity?week=${encodeURIComponent(monday.toISOString())}`)
      .set("Authorization", `Bearer ${adminToken}`);
    assert.equal(capacity.status, 200);
    assert.equal(capacity.body.currentLoadHours, 4);
    assert.equal(capacity.body.tasksCountedInLoad, 2);
    assert.equal(capacity.body.tasksMissingEstimate, 0);
    assert.equal(capacity.body.overloaded, true);
  });

  it("lists and filters tasks and returns one task", async () => {
    const list = await request(app)
      .get(`/tasks?status=open&assigned_user_id=${workerId}&priority=high`)
      .set("Authorization", `Bearer ${adminToken}`);
    assert.equal(list.status, 200);
    assert.equal(list.body.length, 1);
    assert.equal(list.body[0].id, taskId);

    const detail = await request(app)
      .get(`/tasks/${taskId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.assignedUser.displayName, "Test Worker");
    assert.equal(detail.body.job.jobTitle, "Task-linked job");
  });

  it("places due tasks in the Secretary calendar", async () => {
    const from = new Date(monday);
    from.setUTCDate(from.getUTCDate() - 1);
    const to = new Date(monday);
    to.setUTCDate(to.getUTCDate() + 1);
    const res = await request(app)
      .get(`/calendar/tasks?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`)
      .set("Authorization", `Bearer ${adminToken}`);
    assert.equal(res.status, 200);
    assert.ok(res.body.some((task: any) => task.id === taskId));
  });

  it("completes and reopens a task with before/after audit evidence", async () => {
    const completed = await request(app)
      .put(`/tasks/${taskId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ task_status: "completed" });
    assert.equal(completed.status, 200);
    assert.equal(completed.body.task.taskStatus, "completed");
    assert.ok(completed.body.task.completedAt);

    const reopened = await request(app)
      .put(`/tasks/${taskId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ task_status: "in_progress", priority: "urgent" });
    assert.equal(reopened.status, 200);
    assert.equal(reopened.body.task.completedAt, null);
    assert.equal(reopened.body.task.priority, "urgent");

    const audit = await prisma.auditLog.findFirst({
      where: { actionName: "update_task", result: "success" },
      orderBy: { createdAt: "desc" },
    });
    assert.equal((audit?.dataBefore as any)?.taskStatus, "completed");
    assert.equal((audit?.dataAfter as any)?.taskStatus, "in_progress");
  });

  it("finds overdue unfinished tasks but excludes completed tasks", async () => {
    const overdue = await request(app)
      .post("/tasks")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ title: "Overdue task", due_at: "2020-01-01T09:00:00.000Z" });
    const completed = await request(app)
      .post("/tasks")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ title: "Completed old task", due_at: "2020-01-01T10:00:00.000Z" });
    await request(app)
      .put(`/tasks/${completed.body.task.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ task_status: "completed" });

    const list = await request(app)
      .get("/tasks?overdue=true")
      .set("Authorization", `Bearer ${adminToken}`);
    assert.ok(list.body.some((task: any) => task.id === overdue.body.task.id));
    assert.ok(!list.body.some((task: any) => task.id === completed.body.task.id));

    const notifications = await request(app)
      .get("/notifications")
      .set("Authorization", `Bearer ${adminToken}`);
    assert.ok(
      notifications.body.some(
        (item: any) => item.type === "overdue_task" && item.entity.id === overdue.body.task.id
      )
    );
    assert.ok(!notifications.body.some((item: any) => item.entity.id === completed.body.task.id));
  });

  it("keeps tasks and related IDs isolated between companies", async () => {
    const companyB = await prisma.company.create({ data: { name: "Other Task Co" } });
    const passwordHash = await bcrypt.hash("Password123!", 10);
    await prisma.user.create({
      data: {
        companyId: companyB.id,
        email: "tasks-b@test.local",
        passwordHash,
        displayName: "Task Admin B",
        role: "admin",
        permissions: ["crm.read", "crm.manage"],
      },
    });
    const tokenB = await loginAs("tasks-b@test.local");

    const getB = await request(app)
      .get(`/tasks/${taskId}`)
      .set("Authorization", `Bearer ${tokenB}`);
    assert.equal(getB.status, 404);

    const assignForeign = await request(app)
      .post("/tasks")
      .set("Authorization", `Bearer ${tokenB}`)
      .send({ title: "Foreign assignment", assigned_user_id: workerId });
    assert.equal(assignForeign.status, 404);
    assert.equal(assignForeign.body.error, "EMPLOYEE_NOT_FOUND");
  });
});
