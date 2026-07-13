import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { after, before, describe, it } from "node:test";
import request from "supertest";
import { prisma } from "../src/db.js";
import { createServer } from "../src/server.js";
import { resetDb, seedCompanyAndAdmin } from "./setup.js";

const app = createServer();
const originalEnv = {
  graphApiVersion: process.env.WHATSAPP_GRAPH_API_VERSION,
  phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
  businessAccountId: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID,
  accessToken: process.env.WHATSAPP_ACCESS_TOKEN,
  webhookVerifyToken: process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN,
  appSecret: process.env.META_APP_SECRET,
};

function inboundPayload(id: string, from: string, senderName: string) {
  const waId = from.replace(/^\+/, "");
  return {
    object: "whatsapp_business_account",
    entry: [{
      changes: [{
        field: "messages",
        value: {
          metadata: { phone_number_id: "123456789" },
          contacts: [{ wa_id: waId, profile: { name: senderName } }],
          messages: [{
            id,
            from: waId,
            timestamp: "1767225600",
            type: "text",
            text: { body: "Please send a quote" },
          }],
        },
      }],
    }],
  };
}

async function sendSignedWebhook(payload: ReturnType<typeof inboundPayload>) {
  const raw = JSON.stringify(payload);
  const signature = "sha256=" + createHmac("sha256", "test-app-secret").update(raw).digest("hex");
  return request(app)
    .post("/connectors/whatsapp/webhook")
    .set("Content-Type", "application/json")
    .set("X-Hub-Signature-256", signature)
    .send(raw);
}

describe("WhatsApp sender contact synchronisation", () => {
  let token: string;
  let sourceId: string;
  let companyId: string;

  before(async () => {
    process.env.WHATSAPP_GRAPH_API_VERSION = "v99.0";
    process.env.WHATSAPP_PHONE_NUMBER_ID = "123456789";
    process.env.WHATSAPP_BUSINESS_ACCOUNT_ID = "987654321";
    process.env.WHATSAPP_ACCESS_TOKEN = "test-access-token";
    process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = "test-verify-token";
    process.env.META_APP_SECRET = "test-app-secret";

    await resetDb();
    const seeded = await seedCompanyAndAdmin();
    companyId = seeded.company.id;
    const login = await request(app).post("/auth/login").send({ email: "admin@test.local", password: "Password123!" });
    token = login.body.token;

    const source = await request(app)
      .post("/connectors/sources")
      .set("Authorization", "Bearer " + token)
      .send({
        connector_key: "whatsapp_business",
        display_name: "Company WhatsApp",
        configured_scopes: ["read:messages", "send:messages"],
      });
    assert.equal(source.status, 201);
    sourceId = source.body.id;

    const enabled = await request(app)
      .post("/connectors/sources/" + sourceId + "/enable")
      .set("Authorization", "Bearer " + token)
      .send({ confirmed: true });
    assert.equal(enabled.status, 200);
    assert.equal(enabled.body.isEnabled, true);
  });

  after(async () => {
    await resetDb();
    await prisma.$disconnect();
    for (const [name, value] of Object.entries({
      WHATSAPP_GRAPH_API_VERSION: originalEnv.graphApiVersion,
      WHATSAPP_PHONE_NUMBER_ID: originalEnv.phoneNumberId,
      WHATSAPP_BUSINESS_ACCOUNT_ID: originalEnv.businessAccountId,
      WHATSAPP_ACCESS_TOKEN: originalEnv.accessToken,
      WHATSAPP_WEBHOOK_VERIFY_TOKEN: originalEnv.webhookVerifyToken,
      META_APP_SECRET: originalEnv.appSecret,
    })) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });

  it("creates, links and leaves ambiguous WhatsApp sender contacts without overwriting CRM data", async () => {
    const firstPayload = inboundPayload("wamid.contact-created", "447700900123", "WhatsApp Customer");
    const first = await sendSignedWebhook(firstPayload);
    assert.equal(first.status, 200);
    assert.equal(first.body.importedCount, 1);
    assert.equal(first.body.contactSync.createdCount, 1);

    const createdExternal = await prisma.externalContact.findFirstOrThrow({
      where: { connectorSourceId: sourceId, externalResourceName: "wa_id:447700900123" },
    });
    const createdContact = await prisma.contact.findUniqueOrThrow({ where: { id: createdExternal.importedContactId! } });
    assert.equal(createdContact.displayName, "WhatsApp Customer");
    assert.equal(createdContact.phone, "+447700900123");
    assert.equal(createdContact.preferredChannel, "whatsapp");
    assert.equal(createdContact.source, "whatsapp_business");

    const replay = await sendSignedWebhook(firstPayload);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.duplicateCount, 1);
    assert.equal(replay.body.contactSync.alreadySyncedCount, 1);
    assert.equal(await prisma.contact.count({ where: { companyId } }), 1);

    const existing = await prisma.contact.create({
      data: {
        companyId,
        displayName: "Manually maintained contact",
        phone: "07700 900456",
        source: "user_input",
      },
    });
    const matching = await sendSignedWebhook(inboundPayload("wamid.contact-linked", "447700900456", "Provider profile name"));
    assert.equal(matching.status, 200);
    assert.equal(matching.body.contactSync.linkedCount, 1);
    const linkedExternal = await prisma.externalContact.findFirstOrThrow({
      where: { connectorSourceId: sourceId, externalResourceName: "wa_id:447700900456" },
    });
    assert.equal(linkedExternal.importedContactId, existing.id);
    const unchanged = await prisma.contact.findUniqueOrThrow({ where: { id: existing.id } });
    assert.equal(unchanged.displayName, "Manually maintained contact");
    assert.equal(unchanged.phone, "07700 900456");

    await prisma.contact.createMany({
      data: [
        { companyId, displayName: "Shared number A", phone: "+447700900789", source: "user_input" },
        { companyId, displayName: "Shared number B", phone: "07700 900789", source: "user_input" },
      ],
    });
    const ambiguous = await sendSignedWebhook(inboundPayload("wamid.contact-ambiguous", "447700900789", "Ambiguous sender"));
    assert.equal(ambiguous.status, 200);
    assert.equal(ambiguous.body.contactSync.awaitingReviewCount, 1);
    const ambiguousExternal = await prisma.externalContact.findFirstOrThrow({
      where: { connectorSourceId: sourceId, externalResourceName: "wa_id:447700900789" },
    });
    assert.equal(ambiguousExternal.importedContactId, null);
    assert.equal(await prisma.contact.count({ where: { companyId } }), 4);

    const invalid = await sendSignedWebhook(inboundPayload("wamid.contact-invalid", "000", "Invalid number"));
    assert.equal(invalid.status, 200);
    assert.equal(invalid.body.contactSync.skippedInvalidCount, 1);
    assert.equal(await prisma.contact.count({ where: { companyId } }), 4);

    const listed = await request(app)
      .get("/connectors/sources/" + sourceId + "/external-contacts?active_only=true&limit=100")
      .set("Authorization", "Bearer " + token);
    assert.equal(listed.status, 200);
    assert.ok(listed.body.items.some((item: { externalResourceName: string; importedContactId: string | null }) =>
      item.externalResourceName === "wa_id:447700900123" && item.importedContactId === createdContact.id
    ));
    assert.ok(listed.body.items.some((item: { externalResourceName: string; importedContactId: string | null }) =>
      item.externalResourceName === "wa_id:447700900789" && item.importedContactId === null
    ));

    const automaticImport = await request(app)
      .post("/connectors/sources/" + sourceId + "/external-contacts/" + ambiguousExternal.id + "/import")
      .set("Authorization", "Bearer " + token)
      .send({ confirmed: true });
    assert.equal(automaticImport.status, 409);
    assert.equal(automaticImport.body.error, "CONTACT_IMPORT_NOT_SUPPORTED");

    const syncAudit = await prisma.auditLog.findFirstOrThrow({
      where: { actionName: "sync_whatsapp_sender_contacts", result: "success" },
      orderBy: { createdAt: "desc" },
    });
    assert.ok(!JSON.stringify(syncAudit.dataAfter).includes("447700900789"));
  });
});
