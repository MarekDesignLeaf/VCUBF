import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import request from "supertest";
import { createServer } from "../src/server.js";
import { prisma } from "../src/db.js";
import { GMAIL_SEND_SCOPE } from "../src/connectors/gmailAdapter.js";
import { encryptConnectorPayload } from "../src/connectors/connectorCrypto.js";
import { buildNotificationDigest, runNotificationDigestSweep } from "../src/services/notificationDigestService.js";
import { resetDb, seedCompanyAndAdmin, TEST_COMPANY_ID } from "./setup.js";

const app = createServer();
const originalFetch = globalThis.fetch;
const originalKey = process.env.CONNECTOR_ENCRYPTION_KEY;
const day = 24 * 60 * 60 * 1000;

describe("Daily notification digest", () => {
  let token: string;
  let adminId: string;
  let sourceId: string;

  before(async () => {
    process.env.CONNECTOR_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString("base64");
    await resetDb();
    const { admin } = await seedCompanyAndAdmin();
    adminId = admin.id;
    token = (await request(app).post("/auth/login").send({ email: "admin@test.local", password: "Password123!" })).body.token;

    const source = await request(app).post("/connectors/sources").set("Authorization", `Bearer ${token}`)
      .send({ connector_key: "gmail", display_name: "Digest Gmail", configured_scopes: ["send:messages"] });
    sourceId = source.body.id;
    await prisma.connectorSource.update({ where: { id: sourceId }, data: { isEnabled: true, connectionStatus: "enabled" } });
    await prisma.connectorCredential.create({
      data: { sourceId, companyId: TEST_COMPANY_ID, provider: "gmail", ...encryptConnectorPayload({ accessToken: "digest-token", refreshToken: "digest-refresh", scopes: [GMAIL_SEND_SCOPE], tokenType: "Bearer", expiresAt: "2099-01-01T00:00:00.000Z" }, `${TEST_COMPANY_ID}:${sourceId}:gmail`) },
    });

    // One stale open lead → one real warning item in the feed.
    await prisma.lead.create({ data: { companyId: TEST_COMPANY_ID, name: "Digest stale lead", leadStatus: "new", createdAt: new Date(Date.now() - 40 * day) } });
  });

  afterEach(() => { globalThis.fetch = originalFetch; });

  after(async () => {
    await prisma.$disconnect();
    if (originalKey === undefined) delete process.env.CONNECTOR_ENCRYPTION_KEY; else process.env.CONNECTOR_ENCRYPTION_KEY = originalKey;
  });

  it("defaults to disabled and addresses the user's own account email", async () => {
    const res = await request(app).get("/notifications/digest/preferences").set("Authorization", `Bearer ${token}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.enabled, false);
    assert.equal(res.body.recipient, "admin@test.local");
    assert.equal(res.body.lastSentAt, null);
  });

  it("refuses to send while the digest is disabled", async () => {
    let contacted = false;
    globalThis.fetch = async () => { contacted = true; return Response.json({ id: "x" }); };
    const res = await request(app).post("/notifications/digest/send").set("Authorization", `Bearer ${token}`).send({ confirmed: true });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, "DIGEST_DISABLED");
    assert.equal(contacted, false);
  });

  it("validates and stores the opt-in and hour", async () => {
    const invalid = await request(app).put("/notifications/digest/preferences").set("Authorization", `Bearer ${token}`).send({ enabled: true, hour_utc: 24 });
    assert.equal(invalid.status, 400);
    const res = await request(app).put("/notifications/digest/preferences").set("Authorization", `Bearer ${token}`).send({ enabled: true, hour_utc: 6 });
    assert.equal(res.status, 200);
    assert.equal(res.body.enabled, true);
    assert.equal(res.body.hourUtc, 6);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { actionName: "update_notification_digest_preferences", result: "success" }, orderBy: { createdAt: "desc" } });
    assert.equal((audit.dataAfter as any).enabled, true);
  });

  it("builds the digest only from real outstanding feed items", async () => {
    const digest = await buildNotificationDigest({ id: adminId, companyId: TEST_COMPANY_ID, email: "admin@test.local", displayName: "Admin", role: "admin", permissions: ["crm.read", "crm.manage"], mustChangePassword: false, voiceWakeWord: "Emma", voiceContinuous: false, voiceLanguage: "en-GB", assistantName: "Emma", voiceSpeechRate: 1.15 });
    assert.ok(digest);
    assert.equal(digest!.itemCount, 1);
    assert.match(digest!.body, /Digest stale lead/);
    assert.match(digest!.subject, /1 item\(s\) need attention/);
  });

  it("previews the digest without sending, then sends it to the user's own address", async () => {
    let contacted = false;
    globalThis.fetch = async () => { contacted = true; return Response.json({ id: "x" }); };
    const preview = await request(app).post("/notifications/digest/send").set("Authorization", `Bearer ${token}`).send({});
    assert.equal(preview.status, 409);
    assert.equal(preview.body.error, "CONFIRMATION_REQUIRED");
    assert.deepEqual(preview.body.preview.to, ["admin@test.local"]);
    assert.equal(preview.body.preview.itemCount, 1);
    assert.equal(contacted, false);

    let raw = "";
    globalThis.fetch = async (input, init) => {
      raw = JSON.parse(String(init?.body)).raw;
      return Response.json({ id: "digest-1" });
    };
    const res = await request(app).post("/notifications/digest/send").set("Authorization", `Bearer ${token}`).send({ confirmed: true });
    assert.equal(res.status, 200);
    assert.equal(res.body.messageId, "digest-1");
    const mime = Buffer.from(raw, "base64url").toString("utf8");
    assert.match(mime, /To: admin@test\.local/);
    assert.match(mime, /Digest stale lead/);
    assert.ok((await prisma.user.findUniqueOrThrow({ where: { id: adminId } })).digestLastSentAt);
  });

  it("the scheduled sweep skips a user who already received today's digest", async () => {
    let sends = 0;
    globalThis.fetch = async () => { sends += 1; return Response.json({ id: "digest-2" }); };
    const summary = await runNotificationDigestSweep(new Date());
    assert.equal(summary.sent, 0);
    assert.equal(summary.skipped, 1);
    assert.equal(sends, 0);
  });

  it("the scheduled sweep sends once for an opted-in user with a fresh day and nothing for a disabled one", async () => {
    await prisma.user.update({ where: { id: adminId }, data: { digestLastSentAt: new Date(Date.now() - 2 * day) } });
    let sends = 0;
    globalThis.fetch = async () => { sends += 1; return Response.json({ id: "digest-3" }); };
    const summary = await runNotificationDigestSweep(new Date());
    assert.equal(summary.sent, 1);
    assert.equal(sends, 1);

    await prisma.user.update({ where: { id: adminId }, data: { digestEnabled: false, digestLastSentAt: null } });
    sends = 0;
    const afterOptOut = await runNotificationDigestSweep(new Date());
    assert.equal(afterOptOut.considered, 0);
    assert.equal(sends, 0);
  });

  it("reports an empty feed instead of sending an empty email", async () => {
    await prisma.lead.deleteMany({ where: { companyId: TEST_COMPANY_ID } });
    await prisma.user.update({ where: { id: adminId }, data: { digestEnabled: true, digestLastSentAt: null } });
    let contacted = false;
    globalThis.fetch = async () => { contacted = true; return Response.json({ id: "x" }); };
    const res = await request(app).post("/notifications/digest/send").set("Authorization", `Bearer ${token}`).send({ confirmed: true });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, "DIGEST_EMPTY");
    assert.equal(contacted, false);
    const sweep = await runNotificationDigestSweep(new Date());
    assert.equal(sweep.sent, 0);
    assert.equal(sweep.skipped, 1);
  });
});
