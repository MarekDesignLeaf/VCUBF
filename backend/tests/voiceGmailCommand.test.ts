import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import request from "supertest";
import { encryptConnectorPayload } from "../src/connectors/connectorCrypto.js";
import { GMAIL_SEND_SCOPE } from "../src/connectors/gmailAdapter.js";
import { prisma } from "../src/db.js";
import { createServer } from "../src/server.js";
import { resetDb, seedCompanyAndAdmin, TEST_COMPANY_ID } from "./setup.js";

const app = createServer();
const originalFetch = globalThis.fetch;
const originalEncryptionKey = process.env.CONNECTOR_ENCRYPTION_KEY;

describe("Emma Gmail sending", () => {
  let token: string;
  let sourceId: string;

  before(async () => {
    process.env.CONNECTOR_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
    await resetDb();
    await seedCompanyAndAdmin();
    const login = await request(app).post("/auth/login").send({ email: "admin@test.local", password: "Password123!" });
    token = login.body.token;
    const source = await request(app)
      .post("/connectors/sources")
      .set("Authorization", `Bearer ${token}`)
      .send({ connector_key: "gmail", display_name: "Emma Gmail", configured_scopes: ["send:messages"] });
    assert.equal(source.status, 201);
    sourceId = source.body.id;
    await prisma.connectorSource.update({ where: { id: sourceId }, data: { isEnabled: true, connectionStatus: "enabled" } });
    await prisma.connectorCredential.create({
      data: {
        sourceId,
        companyId: TEST_COMPANY_ID,
        provider: "gmail",
        ...encryptConnectorPayload(
          {
            accessToken: "voice-gmail-token",
            refreshToken: "voice-gmail-refresh",
            scopes: [GMAIL_SEND_SCOPE],
            tokenType: "Bearer",
            expiresAt: "2099-01-01T00:00:00.000Z",
          },
          `${TEST_COMPANY_ID}:${sourceId}:gmail`
        ),
      },
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  after(async () => {
    await resetDb();
    await prisma.$disconnect();
    if (originalEncryptionKey === undefined) delete process.env.CONNECTOR_ENCRYPTION_KEY;
    else process.env.CONNECTOR_ENCRYPTION_KEY = originalEncryptionKey;
  });

  it("previews a Gmail email, accepts a bare voice yes, and sends it once", async () => {
    const body = "Hello customer, your quote is ready.";
    const preview = await request(app)
      .post("/command/text")
      .set("Authorization", `Bearer ${token}`)
      .send({ text: `send email to customer@example.com; subject Quote ready; body ${body}`, input_method: "voice_transcript" });
    assert.equal(preview.status, 202);
    assert.equal(preview.body.intent, "prepare_gmail_message");
    assert.equal(preview.body.data.confirmationRequired, true);
    assert.deepEqual(preview.body.data.preview.to, ["customer@example.com"]);
    assert.equal(preview.body.data.preview.subject, "Quote ready");

    let sends = 0;
    globalThis.fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
      assert.equal(url.pathname, "/gmail/v1/users/me/messages/send");
      assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer voice-gmail-token");
      const payload = JSON.parse(String(init?.body));
      const raw = Buffer.from(payload.raw, "base64url").toString("utf8");
      assert.match(raw, /To: customer@example\.com/);
      assert.match(raw, /Subject: Quote ready/);
      assert.match(raw, /Hello customer, your quote is ready\./);
      sends += 1;
      return Response.json({ id: "gmail-message-1", threadId: "gmail-thread-1" });
    };

    const confirmed = await request(app)
      .post("/command/text")
      .set("Authorization", `Bearer ${token}`)
      .send({ text: "yes", input_method: "voice_transcript" });
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.body.intent, "confirm_gmail_message");
    assert.equal(confirmed.body.data.messageId, "gmail-message-1");
    assert.equal(sends, 1);

    const pending = await prisma.voicePendingAction.findFirstOrThrow({ where: { companyId: TEST_COMPANY_ID, userId: (await prisma.user.findUniqueOrThrow({ where: { email: "admin@test.local" } })).id } });
    assert.equal(pending.status, "sent");
    assert.equal(pending.payload, null);

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { actionName: "execute_text_command", interpretedIntent: "prepare_gmail_message" },
      orderBy: { createdAt: "desc" },
    });
    assert.ok(!JSON.stringify(audit).includes(body));
    assert.ok(!JSON.stringify(audit).includes("customer@example.com"));

    const repeated = await request(app)
      .post("/command/text")
      .set("Authorization", `Bearer ${token}`)
      .send({ text: "yes", input_method: "voice_transcript" });
    assert.equal(repeated.status, 422);
    assert.equal(repeated.body.error, "UNSUPPORTED_ACTION");
    assert.equal(sends, 1);
  });
});
