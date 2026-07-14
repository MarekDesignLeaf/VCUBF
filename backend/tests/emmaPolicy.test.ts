import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import request from "supertest";
import { createServer } from "../src/server.js";
import { prisma } from "../src/db.js";
import { EMMA_CAPABILITIES, evaluateEmmaCommand } from "../src/services/emmaPolicyService.js";
import { resetDb, seedCompanyAndAdmin } from "./setup.js";

const app = createServer();

describe("company Emma capability policy", () => {
  let administratorToken = "";
  let nonAdministratorToken = "";
  let adminUser: Awaited<ReturnType<typeof seedCompanyAndAdmin>>["admin"];

  before(async () => {
    await resetDb();
    const seeded = await seedCompanyAndAdmin();
    adminUser = seeded.admin;
    await prisma.user.update({
      where: { id: seeded.worker.id },
      data: { permissions: ["company.manage", "voice.execute"] },
    });
    const adminLogin = await request(app).post("/auth/login").send({ email: "admin@test.local", password: "Password123!" });
    const workerLogin = await request(app).post("/auth/login").send({ email: "worker@test.local", password: "Password123!" });
    administratorToken = adminLogin.body.token;
    nonAdministratorToken = workerLogin.body.token;
  });

  after(async () => {
    await prisma.$disconnect();
  });

  it("is visible only to an administrator even when another role has company.manage", async () => {
    const denied = await request(app).get("/company/emma-policy").set("Authorization", `Bearer ${nonAdministratorToken}`);
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error, "ADMINISTRATOR_REQUIRED");

    const allowed = await request(app).get("/company/emma-policy").set("Authorization", `Bearer ${administratorToken}`);
    assert.equal(allowed.status, 200);
    assert.equal(allowed.body.capabilities.length, EMMA_CAPABILITIES.length);
    assert.ok(allowed.body.capabilities.every((item: { enabled: boolean }) => item.enabled));
  });

  it("blocks a disabled Emma action before execution and audits the policy change", async () => {
    const changed = await request(app)
      .put("/company/emma-policy")
      .set("Authorization", `Bearer ${administratorToken}`)
      .send({ disabled_capabilities: ["page.quotes"] });
    assert.equal(changed.status, 200);
    assert.equal(changed.body.capabilities.find((item: { id: string }) => item.id === "page.quotes").enabled, false);

    const blocked = await request(app)
      .post("/command/text")
      .set("Authorization", `Bearer ${administratorToken}`)
      .send({ text: "open quotes", input_method: "voice_transcript" });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.error, "EMMA_CAPABILITY_DISABLED");
    assert.equal(blocked.body.capabilityId, "page.quotes");

    const policyAudit = await prisma.auditLog.findFirst({
      where: { companyId: adminUser.companyId, actionName: "update_emma_company_policy" },
      orderBy: { createdAt: "desc" },
    });
    assert.equal(policyAudit?.result, "success");
  });

  it("always permits safe cancellation of a pending action", async () => {
    const decision = await evaluateEmmaCommand({
      id: adminUser.id,
      companyId: adminUser.companyId,
      email: adminUser.email,
      displayName: adminUser.displayName,
      role: adminUser.role,
      permissions: adminUser.permissions,
      mustChangePassword: adminUser.mustChangePassword,
      voiceWakeWord: adminUser.voiceWakeWord,
      voiceContinuous: adminUser.voiceContinuous,
      voiceLanguage: adminUser.voiceLanguage,
    }, "cancel_gmail_message");
    assert.equal(decision.allowed, true);
  });

  it("controls client and contact create, edit and archive permissions independently", async () => {
    const changed = await request(app)
      .put("/company/emma-policy")
      .set("Authorization", `Bearer ${administratorToken}`)
      .send({ disabled_capabilities: ["action.create_client", "action.archive_contact"] });
    assert.equal(changed.status, 200);

    const authedUser = {
      id: adminUser.id,
      companyId: adminUser.companyId,
      email: adminUser.email,
      displayName: adminUser.displayName,
      role: adminUser.role,
      permissions: adminUser.permissions,
      mustChangePassword: adminUser.mustChangePassword,
      voiceWakeWord: adminUser.voiceWakeWord,
      voiceContinuous: adminUser.voiceContinuous,
      voiceLanguage: adminUser.voiceLanguage,
    };
    assert.equal((await evaluateEmmaCommand(authedUser, "create_client")).allowed, false);
    assert.equal((await evaluateEmmaCommand(authedUser, "update_client")).allowed, true);
    assert.equal((await evaluateEmmaCommand(authedUser, "prepare_archive_client")).allowed, true);
    assert.equal((await evaluateEmmaCommand(authedUser, "create_contact")).allowed, true);
    assert.equal((await evaluateEmmaCommand(authedUser, "update_contact")).allowed, true);
    assert.equal((await evaluateEmmaCommand(authedUser, "prepare_archive_contact")).allowed, false);
    assert.equal((await evaluateEmmaCommand(authedUser, "cancel_archive_contact")).allowed, true);
  });
});
