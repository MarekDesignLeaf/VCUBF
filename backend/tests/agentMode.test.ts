import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import request from "supertest";
import { createServer } from "../src/server.js";
import { prisma } from "../src/db.js";
import { agentMayActFor } from "../src/agents/agentMode.js";
import { AGENT_TOOLSET_FINGERPRINT } from "../src/agents/shadowAgent.js";
import { buildId } from "../src/lib/buildInfo.js";
import { modelFor } from "../src/lib/modelGateway.js";
import { resetDb, seedCompanyAndAdmin, TEST_COMPANY_ID } from "./setup.js";

// The per-company agent switch — masterplan F2, project description §39.
const app = createServer();

describe("agent switch", () => {
  let adminToken: string;
  let workerToken: string;
  let adminId: string;
  const previousBuild = process.env.RAILWAY_GIT_COMMIT_SHA;

  const login = async (email: string) => (await request(app).post("/auth/login").send({ email, password: "Password123!" })).body.token as string;
  const as = (token: string) => ({ Authorization: `Bearer ${token}` });
  const switchTo = (enabled: boolean, token = adminToken) => request(app).put("/company/agent-mode").set(as(token)).send({ enabled, reason: "test" });

  before(async () => {
    // Acceptance is only possible on an identified build.
    process.env.RAILWAY_GIT_COMMIT_SHA = "agentswitchtestbuild";
    await resetDb();
    const seeded = await seedCompanyAndAdmin();
    adminId = seeded.admin.id;
    adminToken = await login("admin@test.local");
    workerToken = await login("worker@test.local");
  });

  after(async () => {
    if (previousBuild === undefined) delete process.env.RAILWAY_GIT_COMMIT_SHA;
    else process.env.RAILWAY_GIT_COMMIT_SHA = previousBuild;
    await prisma.$disconnect();
  });

  it("is off by default, readable by administrators of users, switched only by an administrator", async () => {
    assert.equal((await request(app).get("/company/agent-mode").set(as(workerToken))).status, 403);
    assert.equal((await switchTo(true, workerToken)).status, 403);
    const state = await request(app).get("/company/agent-mode").set(as(adminToken));
    assert.equal(state.status, 200);
    assert.equal(state.body.enabled, false);
    assert.deepEqual(state.body.effective, []);
    assert.deepEqual(await agentMayActFor(TEST_COMPANY_ID, "en-GB", "text"), { allowed: false, reason: "AGENT_OFF" });
  });

  it("switched on, it still acts nowhere until a language and path passed the shadow acceptance", async () => {
    const on = await switchTo(true);
    assert.equal(on.status, 200, JSON.stringify(on.body));
    assert.equal(on.body.enabled, true);
    assert.deepEqual(on.body.effective, []);
    assert.equal((await switchTo(true)).status, 200);
    assert.equal(await prisma.auditLog.count({ where: { actionName: "set_company_agent_mode" } }), 1, "only a real change is audited");
    assert.deepEqual(await agentMayActFor(TEST_COMPANY_ID, "en-GB", "text"), { allowed: false, reason: "NOT_ACCEPTED" });

    // English typed commands pass the acceptance on the current cohort.
    const template = {
      companyId: TEST_COMPANY_ID, userId: adminId, mode: "shadow", channel: "text", language: "en-GB",
      inputFingerprint: "f", catalogueVersion: "1.1.0", catalogueFingerprint: "c",
      toolsetFingerprint: AGENT_TOOLSET_FINGERPRINT, build: buildId(), model: modelFor("agent_plan"),
      status: "completed", steps: 1, proposedTools: [], durationMs: 1,
    };
    await prisma.agentRun.createMany({
      data: [
        ...Array.from({ length: 80 }, () => ({ ...template, agreement: "match", parserIntent: "execute_action", parserAction: "execute_action:create_task" })),
        ...Array.from({ length: 40 }, () => ({ ...template, agreement: "both_none", parserIntent: "unrecognized", parserAction: null })),
      ],
    });
    assert.deepEqual(await agentMayActFor(TEST_COMPANY_ID, "en-GB", "text"), { allowed: true });
    // English typed commands never vouch for Czech, nor for the voice assistant.
    assert.deepEqual(await agentMayActFor(TEST_COMPANY_ID, "cs-CZ", "text"), { allowed: false, reason: "NOT_ACCEPTED" });
    assert.deepEqual(await agentMayActFor(TEST_COMPANY_ID, "en-GB", "assistant"), { allowed: false, reason: "NOT_ACCEPTED" });
    const state = await request(app).get("/company/agent-mode").set(as(adminToken));
    assert.deepEqual(state.body.effective, [{ language: "en-GB", channel: "text" }]);
  });

  it("an emergency stop overrides it; during the stop it can be switched off but not on", async () => {
    assert.equal((await request(app).put("/company/safe-mode").set(as(adminToken)).send({ enabled: true })).status, 200);
    assert.deepEqual(await agentMayActFor(TEST_COMPANY_ID, "en-GB", "text"), { allowed: false, reason: "SAFE_MODE" });
    assert.deepEqual((await request(app).get("/company/agent-mode").set(as(adminToken))).body.effective, []);

    const off = await switchTo(false);
    assert.equal(off.status, 200, JSON.stringify(off.body));
    assert.equal(off.body.enabled, false);
    const on = await switchTo(true);
    assert.equal(on.status, 423, JSON.stringify(on.body));
    assert.equal(on.body.error, "SAFE_MODE_ACTIVE");

    assert.equal((await request(app).put("/company/safe-mode").set(as(adminToken)).send({ enabled: false })).status, 200);
    const tower = await request(app).get("/audit/control-tower").set(as(adminToken));
    assert.equal(tower.body.agent.enabled, false);
  });
});
