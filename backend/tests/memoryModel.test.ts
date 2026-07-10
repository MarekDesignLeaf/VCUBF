import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
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

// Seeds `count` occurrences of the consecutive sequence create_client ->
// create_job for the given user, each occurrence a fixed number of minutes
// apart, plus one unrelated action in between occurrences so the "*next*
// consecutive pair*" logic in memoryModelService only ever sees the intended
// pairs when scanning that user's own chronological timeline.
async function seedSequenceOccurrences(
  companyId: string,
  userId: string,
  count: number,
  startMinutesAgo: number
) {
  const base = Date.now() - startMinutesAgo * 60 * 1000;
  for (let i = 0; i < count; i++) {
    const t0 = new Date(base + i * 20 * 60 * 1000);
    const t1 = new Date(t0.getTime() + 60 * 1000);
    await prisma.auditLog.create({
      data: {
        companyId,
        userId,
        actionName: "create_client",
        riskLevel: 2,
        result: "success",
        createdAt: t0,
      },
    });
    await prisma.auditLog.create({
      data: {
        companyId,
        userId,
        actionName: "create_job",
        riskLevel: 2,
        result: "success",
        createdAt: t1,
      },
    });
  }
}

describe("Memory Model — Pattern Detection (read-only)", () => {
  let adminToken: string;
  let workerToken: string;
  let adminId: string;
  let companyId: string;

  before(async () => {
    await resetDb();
    const { company, admin } = await seedCompanyAndAdmin();
    companyId = company.id;
    adminId = admin.id;
    adminToken = await loginAs("admin@test.local");
    workerToken = await loginAs("worker@test.local");
  });

  after(async () => {
    await resetDb();
    await prisma.$disconnect();
  });

  it("rejects reading patterns without audit.read permission (401/403 depending on auth state)", async () => {
    const res = await request(app).get("/memory-model/patterns");
    assert.equal(res.status, 401);
  });

  it("rejects a user without audit.read permission (403)", async () => {
    const res = await request(app).get("/memory-model/patterns").set("Authorization", `Bearer ${workerToken}`);
    assert.equal(res.status, 403);
  });

  it("detects a sequence repeated at least MIN_PATTERN_OCCURRENCES (3) times", async () => {
    await seedSequenceOccurrences(companyId, adminId, 3, 60);

    const res = await request(app).get("/memory-model/patterns").set("Authorization", `Bearer ${adminToken}`);
    assert.equal(res.status, 200);
    const pattern = res.body.find(
      (p: any) => p.actionSequence.join(">") === "create_client>create_job"
    );
    assert.ok(pattern, "expected the 3x-repeated create_client -> create_job sequence to be detected");
    assert.equal(pattern.occurrenceCount, 3);
    assert.equal(pattern.exampleTimestamps.length, 3);
  });

  it("does not flag a sequence that only recurs 1-2 times (below threshold)", async () => {
    await resetDb();
    const { company, admin } = await seedCompanyAndAdmin();
    companyId = company.id;
    adminId = admin.id;
    adminToken = await loginAs("admin@test.local");

    await seedSequenceOccurrences(companyId, adminId, 2, 60);

    const res = await request(app).get("/memory-model/patterns").set("Authorization", `Bearer ${adminToken}`);
    assert.equal(res.status, 200);
    const pattern = res.body.find(
      (p: any) => p.actionSequence.join(">") === "create_client>create_job"
    );
    assert.ok(!pattern, "did not expect a 2x-only sequence to be surfaced as a candidate pattern");
  });

  it("never leaks company A's patterns into company B's results (tenant isolation)", async () => {
    await resetDb();
    const { company: companyA, admin: adminA } = await seedCompanyAndAdmin();
    const tokenA = await loginAs("admin@test.local");
    await seedSequenceOccurrences(companyA.id, adminA.id, 3, 60);

    const companyB = await prisma.company.create({ data: { name: "Other Co" } });
    const passwordHash = await bcrypt.hash("Password123!", 10);
    const adminB = await prisma.user.create({
      data: {
        companyId: companyB.id,
        email: "admin-b@test.local",
        passwordHash,
        displayName: "Other Admin",
        role: "admin",
        permissions: ["crm.read", "crm.manage", "audit.read"],
      },
    });
    const tokenB = await loginAs("admin-b@test.local");
    // Company B never performed this sequence at all.

    const resA = await request(app).get("/memory-model/patterns").set("Authorization", `Bearer ${tokenA}`);
    assert.equal(resA.status, 200);
    assert.ok(resA.body.some((p: any) => p.actionSequence.join(">") === "create_client>create_job"));

    const resB = await request(app).get("/memory-model/patterns").set("Authorization", `Bearer ${tokenB}`);
    assert.equal(resB.status, 200);
    assert.ok(
      !resB.body.some((p: any) => p.actionSequence.join(">") === "create_client>create_job"),
      "company B must never see company A's detected pattern"
    );
    assert.equal(resB.body.length, 0);
  });
});
