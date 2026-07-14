import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import request from "supertest";
import { encryptConnectorPayload } from "../src/connectors/connectorCrypto.js";
import { GMAIL_MODIFY_SCOPE } from "../src/connectors/gmailAdapter.js";
import { prisma } from "../src/db.js";
import { createServer } from "../src/server.js";
import { resetDb, seedCompanyAndAdmin, TEST_COMPANY_ID } from "./setup.js";

const app = createServer();
const originalFetch = globalThis.fetch;

describe("Gmail source and local email deletion", () => {
  let token: string;
  let sourceId: string;
  let intakeId: string;

  before(async () => {
    process.env.CONNECTOR_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
    await resetDb();
    await seedCompanyAndAdmin();
    const login = await request(app).post("/auth/login").send({ email: "admin@test.local", password: "Password123!" });
    token = login.body.token;
    const source = await request(app)
      .post("/connectors/sources")
      .set("Authorization", `Bearer ${token}`)
      .send({ connector_key: "gmail", display_name: "Deletable Gmail", configured_scopes: ["read:messages", "delete:messages"] });
    sourceId = source.body.id;
    const encrypted = encryptConnectorPayload({
      accessToken: "modify-token",
      refreshToken: "modify-refresh",
      scopes: [GMAIL_MODIFY_SCOPE],
      tokenType: "Bearer",
      expiresAt: "2099-01-01T00:00:00.000Z",
    }, `${TEST_COMPANY_ID}:${sourceId}:gmail`);
    await prisma.connectorCredential.create({ data: { sourceId, companyId: TEST_COMPANY_ID, provider: "gmail", ...encrypted } });
    await prisma.connectorSource.update({ where: { id: sourceId }, data: { isEnabled: true, connectionStatus: "enabled" } });
    const intake = await prisma.communicationIntake.create({
      data: {
        companyId: TEST_COMPANY_ID,
        connectorSourceId: sourceId,
        externalMessageId: "gmail-message-delete-1",
        externalThreadId: "gmail-thread-delete-1",
        channel: "email",
        senderName: "Delete Test",
        senderEmail: "delete@example.com",
        messageText: "Subject: Remove me\n\nProvider-backed message",
        receivedAt: new Date("2026-07-14T12:00:00.000Z"),
        sourceReference: `gmail:${sourceId}:gmail-message-delete-1`,
      },
    });
    intakeId = intake.id;
  });

  afterEach(() => { globalThis.fetch = originalFetch; });
  after(async () => { await resetDb(); await prisma.$disconnect(); });

  it("previews without contacting Gmail, then trashes the source before deleting the local copy", async () => {
    let contacted = false;
    globalThis.fetch = async () => { contacted = true; return Response.json({}); };
    const preview = await request(app)
      .delete(`/communications/intakes/${intakeId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ confirmed: false });
    assert.equal(preview.status, 409);
    assert.equal(preview.body.error, "CONFIRMATION_REQUIRED");
    assert.equal(preview.body.preview.providerAction, "move_to_gmail_trash");
    assert.equal(preview.body.preview.subject, "Remove me");
    assert.equal(contacted, false);
    assert.equal(await prisma.communicationIntake.count({ where: { id: intakeId } }), 1);

    globalThis.fetch = async (input, init) => {
      contacted = true;
      assert.equal(String(input), "https://gmail.googleapis.com/gmail/v1/users/me/messages/gmail-message-delete-1/trash");
      assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer modify-token");
      assert.equal(init?.body, undefined);
      return Response.json({ id: "gmail-message-delete-1", labelIds: ["TRASH"] });
    };
    const deleted = await request(app)
      .delete(`/communications/intakes/${intakeId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ confirmed: true });
    assert.equal(deleted.status, 200);
    assert.equal(deleted.body.movedToGmailTrash, true);
    assert.equal(deleted.body.localDeleted, true);
    assert.equal(contacted, true);
    assert.equal(await prisma.communicationIntake.count({ where: { id: intakeId } }), 0);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { actionName: "delete_gmail_intake", result: "success" } });
    assert.equal(audit.confirmed, true);
    assert.ok(!JSON.stringify(audit).includes("Provider-backed message"));
    assert.ok(!JSON.stringify(audit).includes("delete@example.com"));
  });
});
