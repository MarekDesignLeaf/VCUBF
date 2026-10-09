import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import bcrypt from "bcryptjs";
import request from "supertest";
import { z } from "zod";
import { createServer } from "../src/server.js";
import { prisma } from "../src/db.js";
import { prepareReviewedAction, type ReviewedActionDefinition } from "../src/lib/executionEngine.js";
import { resetDb, seedCompanyAndAdmin } from "./setup.js";

// Agent Control Tower v1 — masterplan layer I, project description §57.
const app = createServer();

const REVIEW: ReviewedActionDefinition<{ secret: string }> = {
  actionType: "control_tower_test_review",
  lifetimeMs: 5 * 60 * 1000,
  payloadSchema: z.object({ secret: z.string() }),
};

function run(companyId: string, userId: string, overrides: Record<string, unknown> = {}) {
  return {
    companyId, userId, mode: "shadow", channel: "text", language: "en-GB",
    inputFingerprint: "fp", catalogueVersion: "v", catalogueFingerprint: "c", toolsetFingerprint: "t",
    build: "b", model: "m", status: "completed", steps: 1,
    proposedTools: [{ tool: "run_command", kind: "bridge", key: "k", valid: true, argumentsFingerprint: "a1b2" }],
    parserIntent: "list_clients", parserAction: null, agreement: "match", tokensIn: 100, tokensOut: 10, durationMs: 50,
    ...overrides,
  };
}

describe("Agent Control Tower", () => {
  let adminToken: string;
  let workerToken: string;
  let admin: { id: string; companyId: string };

  const login = async (email: string) => (await request(app).post("/auth/login").send({ email, password: "Password123!" })).body.token as string;

  before(async () => {
    await resetDb();
    const seeded = await seedCompanyAndAdmin();
    admin = { id: seeded.admin.id, companyId: seeded.admin.companyId };
    adminToken = await login("admin@test.local");
    workerToken = await login("worker@test.local");
  });

  after(async () => { await prisma.$disconnect(); });

  it("is for administrators only", async () => {
    const denied = await request(app).get("/audit/control-tower").set("Authorization", `Bearer ${workerToken}`);
    assert.equal(denied.status, 403);
  });

  it("shows state, what waits for a yes and the latest runs — without any payload or argument fingerprint", async () => {
    await prepareReviewedAction(admin, REVIEW, { secret: "never shown in the control tower" });
    await prisma.agentRun.createMany({
      data: [
        run(admin.companyId, admin.id),
        run(admin.companyId, admin.id, { agreement: "error", status: "error", errorCode: "OPENAI_REQUEST_FAILED_503", proposedTools: [] }),
      ],
    });
    // Another company's run must not appear.
    const other = await prisma.company.create({ data: { name: "Other Co" } });
    const otherUser = await prisma.user.create({
      data: { companyId: other.id, email: "tower-other@test.local", passwordHash: await bcrypt.hash("Password123!", 10), displayName: "Other", role: "admin", permissions: ["users.manage"] },
    });
    await prisma.agentRun.create({ data: run(other.id, otherUser.id, { parserIntent: "other_company_intent" }) });

    const res = await request(app).get("/audit/control-tower").set("Authorization", `Bearer ${adminToken}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const body = res.body;
    assert.deepEqual(body.safeMode, { enabled: false, since: null });
    assert.equal(body.shadow.enabled, false);
    assert.ok(body.models.some((entry: { task: string }) => entry.task === "agent_plan"));
    assert.equal(typeof body.build, "string");

    assert.deepEqual(body.pendingReviews.map((entry: { actionType: string; waiting: number }) => [entry.actionType, entry.waiting]), [[REVIEW.actionType, 1]]);
    assert.equal(JSON.stringify(body).includes("never shown in the control tower"), false, "a waiting payload must never be shown");

    assert.equal(body.recentRuns.length, 2);
    assert.ok(body.recentRuns.every((entry: { parserIntent: string }) => entry.parserIntent !== "other_company_intent"));
    const proposed = body.recentRuns.find((entry: { agreement: string }) => entry.agreement === "match");
    assert.deepEqual(proposed.proposedTools, [{ tool: "run_command", kind: "bridge", valid: true }]);
    assert.equal(proposed.userName, "Test Admin");
    assert.equal(JSON.stringify(body).includes("a1b2"), false, "argument fingerprints are not shown");
    assert.deepEqual(body.lastDay, { runs: 2, errors: 1, tokensIn: 200, tokensOut: 20 });
  });

  it("shows the orchestrator's routing as the specialists it chose, not as a tool (F3)", async () => {
    await prisma.agentRun.create({
      data: run(admin.companyId, admin.id, {
        mode: "proposal", channel: "assistant", parserIntent: "assistant_plan", agreement: "not_compared",
        proposedTools: [
          { tool: "choose_specialists", kind: "orchestrator", key: "communication+scheduling", valid: true, argumentsFingerprint: "r1", use: "route" },
          { tool: "run_command", kind: "command", key: "list_clients", valid: true, argumentsFingerprint: "c1", use: "read" },
        ],
      }),
    });
    const res = await request(app).get("/audit/control-tower").set("Authorization", `Bearer ${adminToken}`);
    const acting = res.body.recentRuns.find((entry: { parserIntent: string }) => entry.parserIntent === "assistant_plan");
    assert.deepEqual(acting.proposedTools, [
      { tool: "specialists: communication+scheduling", kind: "orchestrator", valid: true },
      { tool: "run_command", kind: "command", valid: true },
    ]);
  });

  it("reflects the emergency stop", async () => {
    const on = await request(app).put("/company/safe-mode").set("Authorization", `Bearer ${adminToken}`).send({ enabled: true });
    assert.equal(on.status, 200);
    const res = await request(app).get("/audit/control-tower").set("Authorization", `Bearer ${adminToken}`);
    assert.equal(res.body.safeMode.enabled, true);
    await request(app).put("/company/safe-mode").set("Authorization", `Bearer ${adminToken}`).send({ enabled: false });
  });
});
