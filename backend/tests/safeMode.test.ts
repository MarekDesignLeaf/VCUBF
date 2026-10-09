import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import request from "supertest";
import { z } from "zod";
import { createServer } from "../src/server.js";
import { prisma } from "../src/db.js";
import { claimReviewedAction, prepareReviewedAction, type ReviewedActionDefinition } from "../src/lib/executionEngine.js";
import { mutationAllowedInSafeMode, SafeModeActiveError } from "../src/lib/safeMode.js";
import { commandAllowedInSafeMode } from "../src/lib/safeModeCommands.js";
import type { ParsedCommand } from "../src/lib/commandParser.js";
import { runNotificationDigestSweep } from "../src/services/notificationDigestService.js";
import { resetDb, seedCompanyAndAdmin, TEST_COMPANY_ID } from "./setup.js";

// Emergency stop — masterplan layer H, project description §49.
const app = createServer();

const REVIEW: ReviewedActionDefinition<{ note: string }> = {
  actionType: "safe_mode_test_review",
  lifetimeMs: 5 * 60 * 1000,
  payloadSchema: z.object({ note: z.string().min(1) }),
};

describe("emergency stop (safe mode)", () => {
  let adminToken: string;
  let workerToken: string;
  let admin: { id: string; companyId: string };
  let workerId: string;

  const as = (token: string) => ({ Authorization: `Bearer ${token}` });
  const text = (value: string) => request(app).post("/command/text").set(as(adminToken)).send({ text: value });
  const switchTo = (enabled: boolean, token = adminToken) =>
    request(app).put("/company/safe-mode").set(as(token)).send({ enabled, reason: "test incident" });

  before(async () => {
    await resetDb();
    const seeded = await seedCompanyAndAdmin();
    admin = { id: seeded.admin.id, companyId: seeded.admin.companyId };
    workerId = seeded.worker.id;
    adminToken = (await request(app).post("/auth/login").send({ email: "admin@test.local", password: "Password123!" })).body.token;
    workerToken = (await request(app).post("/auth/login").send({ email: "worker@test.local", password: "Password123!" })).body.token;
  });

  after(async () => { await prisma.$disconnect(); });

  it("judges commands by mode: reads, withdrawals and own voice settings only", () => {
    const command = (value: unknown) => value as ParsedCommand;
    assert.equal(commandAllowedInSafeMode(command({ intent: "list_clients", entities: {} })), true);
    assert.equal(commandAllowedInSafeMode(command({ intent: "unrecognized", entities: {} })), true);
    assert.equal(commandAllowedInSafeMode(command({ intent: "navigate", entities: { page: "clients" } })), true);
    assert.equal(commandAllowedInSafeMode(command({ intent: "cancel_gmail_message", entities: {} })), true);
    assert.equal(commandAllowedInSafeMode(command({ intent: "set_speech_rate", entities: { direction: "faster" } })), true);
    assert.equal(commandAllowedInSafeMode(command({ intent: "execute_action", entities: { action: "get_unpaid_invoices", parameters: {} } })), true);
    assert.equal(commandAllowedInSafeMode(command({ intent: "execute_action", entities: { action: "set_task_status", parameters: {} } })), false);
    // The speaker's own voice settings, by whichever command they arrive.
    assert.equal(commandAllowedInSafeMode(command({ intent: "execute_action", entities: { action: "set_assistant_name", parameters: {} } })), true);
    assert.equal(commandAllowedInSafeMode(command({ intent: "execute_action", entities: { action: "set_speech_rate", parameters: {} } })), true);
    assert.equal(commandAllowedInSafeMode(command({ intent: "create_client", entities: { display_name: "X" } })), false);
    assert.equal(commandAllowedInSafeMode(command({ intent: "confirm_create_client", entities: {} })), false);
    assert.equal(commandAllowedInSafeMode(command({ intent: "confirm_gmail_message", entities: {} })), false);
    assert.equal(commandAllowedInSafeMode(command({ intent: "prepare_whatsapp_message", entities: {} })), false);
  });

  it("lets only the way out, the way in, commands, voice bookkeeping and containment write over HTTP", () => {
    const allowed = (method: string, path: string, extra: { body?: unknown; role?: string } = {}) =>
      mutationAllowedInSafeMode({ method, path, role: "field_worker", ...extra });
    assert.equal(allowed("GET", "/crm/clients"), true);
    assert.equal(allowed("PUT", "/company/safe-mode"), true);
    assert.equal(allowed("POST", "/auth/change-password"), true);
    assert.equal(allowed("POST", "/command/text"), true);
    assert.equal(allowed("PUT", "/command/voice-state"), true);
    assert.equal(allowed("POST", "/crm/clients"), false);
    assert.equal(allowed("PUT", "/company"), false);
    assert.equal(allowed("POST", "/command/aliases"), false);
    assert.equal(allowed("POST", "/notifications/digest/send"), false);
    // Evidence stays: the voice history cannot be cleared during a stop.
    assert.equal(allowed("DELETE", "/command/voice-state/history"), false);
    // No new device credentials, whatever the spelling.
    assert.equal(allowed("POST", "/auth/device/approve"), false);
    assert.equal(allowed("POST", "/Auth/Device/Approve"), false);
    assert.equal(allowed("POST", "/auth/device/key"), true);
    // Containment: administrators only, and only steps that take access away.
    const admin = { role: "administrator" };
    assert.equal(allowed("POST", "/connectors/sources/abc/disable", admin), true);
    assert.equal(allowed("POST", "/connectors/sources/abc/disable"), false);
    assert.equal(allowed("POST", "/connectors/sources/abc/enable", admin), false);
    assert.equal(allowed("POST", "/crm/employees/abc/reset-password", admin), true);
    assert.equal(allowed("PUT", "/crm/employees/abc", { ...admin, body: { is_active: false } }), true);
    assert.equal(allowed("PUT", "/crm/employees/abc", { ...admin, body: { is_active: false, confirmed: true } }), true);
    assert.equal(allowed("PUT", "/crm/employees/abc", { ...admin, body: { is_active: true } }), false);
    assert.equal(allowed("PUT", "/crm/employees/abc", { ...admin, body: { is_active: false, role: "administrator" } }), false);
    assert.equal(allowed("PUT", "/crm/employees/abc", { body: { is_active: false } }), false);
  });

  it("is visible to everyone signed in, but only an administrator switches it", async () => {
    const seen = await request(app).get("/company/safe-mode").set(as(workerToken));
    assert.equal(seen.status, 200);
    assert.deepEqual(seen.body, { enabled: false, since: null });
    const refused = await switchTo(true, workerToken);
    assert.equal(refused.status, 403);
    assert.equal((await request(app).get("/company/safe-mode").set(as(adminToken))).body.enabled, false);
  });

  it("stops writes, commands, confirmations and scheduled sends — reads keep working", async () => {
    // A review prepared before the stop: it must neither run nor be lost.
    await prepareReviewedAction(admin, REVIEW, { note: "waiting before the stop" });
    const preview = await text("create client Before Stop, email before.stop@example.com, phone 07700 900701");
    assert.equal(preview.status, 202, JSON.stringify(preview.body));

    const on = await switchTo(true);
    assert.equal(on.status, 200, JSON.stringify(on.body));
    assert.equal(on.body.enabled, true);
    assert.ok(on.body.since);
    // Switching on again changes nothing and is not audited twice.
    assert.equal((await switchTo(true)).body.since, on.body.since);
    const audits = await prisma.auditLog.findMany({ where: { companyId: TEST_COMPANY_ID, actionName: "set_company_safe_mode" } });
    assert.equal(audits.length, 1);
    assert.equal(audits[0].riskLevel, 4);
    assert.deepEqual(audits[0].inputPayload, { enabled: true, reason: "test incident" });

    // Layer 1: a direct write is refused and leaves no idempotency record.
    const write = await request(app).post("/crm/clients").set(as(adminToken)).set("Idempotency-Key", "safe-mode-1")
      .send({ display_name: "Blocked Client" });
    assert.equal(write.status, 423, JSON.stringify(write.body));
    assert.equal(write.body.error, "SAFE_MODE_ACTIVE");
    // The guard releases the key when the response finishes; give it a moment.
    let kept = 1;
    for (let attempt = 0; attempt < 20 && kept > 0; attempt += 1) {
      kept = await prisma.idempotencyRecord.count({ where: { key: "safe-mode-1" } });
      if (kept > 0) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(kept, 0);
    assert.equal(await prisma.client.count({ where: { displayName: "Blocked Client" } }), 0);
    // Reading still works.
    assert.equal((await request(app).get("/crm/clients").set(as(adminToken))).status, 200);

    // Layer 2: a write command is refused in words; a read command answers.
    const create = await text("create client During Stop, email during.stop@example.com, phone 07700 900702");
    assert.equal(create.status, 423, JSON.stringify(create.body));
    assert.equal(create.body.error, "SAFE_MODE_ACTIVE");
    assert.match(create.body.message, /Emergency stop is on/);
    const listed = await text("list clients");
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.equal(listed.body.intent, "list_clients");

    // A yes executes nothing; the waiting review stays and can still be withdrawn.
    const yes = await text("yes");
    assert.equal(yes.status, 423, JSON.stringify(yes.body));
    assert.equal(await prisma.client.count({ where: { displayName: "Before Stop" } }), 0);
    const no = await text("no");
    assert.notEqual(no.status, 423, JSON.stringify(no.body));
    assert.equal(no.body.ok, true, JSON.stringify(no.body));

    // Layer 3: the engine itself refuses, before touching the review.
    await assert.rejects(claimReviewedAction(admin, REVIEW), SafeModeActiveError);
    const waiting = await prisma.voicePendingAction.findFirst({ where: { companyId: admin.companyId, actionType: REVIEW.actionType } });
    assert.equal(waiting?.status, "pending");

    // Layer 4: no scheduled digest is even considered for the company.
    await prisma.user.updateMany({ where: { companyId: TEST_COMPANY_ID }, data: { digestEnabled: true, digestHourUtc: 0 } });
    const sweep = await runNotificationDigestSweep(new Date("2026-10-09T12:00:00Z"));
    assert.equal(sweep.considered, 0);
    await prisma.user.updateMany({ where: { companyId: TEST_COMPANY_ID }, data: { digestEnabled: false } });

    // The administrator's own settings are writes too.
    assert.equal((await request(app).put("/company").set(as(adminToken)).send({ name: "Renamed During Stop" })).status, 423);
    // So is clearing the voice history: it may be the only record of the incident.
    assert.equal((await request(app).delete("/command/voice-state/history").set(as(adminToken))).status, 423);

    // Containment still works: an administrator can take an account's access away…
    const previewed = await request(app).put(`/crm/employees/${workerId}`).set(as(adminToken)).send({ is_active: false });
    assert.equal(previewed.status, 409, JSON.stringify(previewed.body));
    assert.equal(previewed.body.error, "CONFIRMATION_REQUIRED");
    const deactivated = await request(app).put(`/crm/employees/${workerId}`).set(as(adminToken)).send({ is_active: false, confirmed: true });
    assert.equal(deactivated.status, 200, JSON.stringify(deactivated.body));
    assert.equal((await request(app).get("/company/safe-mode").set(as(workerToken))).status, 401);
    // …but not give it back, nor change anything else in the same request.
    const reactivated = await request(app).put(`/crm/employees/${workerId}`).set(as(adminToken)).send({ is_active: true, confirmed: true });
    assert.equal(reactivated.status, 423);
  });

  it("switching off resumes normal operation, and the waiting review can run again", async () => {
    const off = await switchTo(false);
    assert.equal(off.status, 200, JSON.stringify(off.body));
    assert.deepEqual(off.body, { enabled: false, since: null });
    assert.equal(await prisma.auditLog.count({ where: { companyId: TEST_COMPANY_ID, actionName: "set_company_safe_mode" } }), 2);

    const write = await request(app).post("/crm/clients").set(as(adminToken)).send({ display_name: "After Stop" });
    assert.equal(write.status, 201, JSON.stringify(write.body));
    // A write refused during the stop is carried out when retried with the
    // same key afterwards: the refusal was never kept for replay.
    const retried = await request(app).post("/crm/clients").set(as(adminToken)).set("Idempotency-Key", "safe-mode-1")
      .send({ display_name: "Blocked Client" });
    assert.equal(retried.status, 201, JSON.stringify(retried.body));
    assert.equal(await prisma.client.count({ where: { displayName: "Blocked Client" } }), 1);
    const claimed = await claimReviewedAction(admin, REVIEW);
    assert.equal(claimed.ok, true);
    if (claimed.ok) await claimed.complete(true);
  });
});
