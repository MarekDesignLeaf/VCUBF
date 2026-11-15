import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { after, before, describe, it } from "node:test";
import bcrypt from "bcryptjs";
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

function inboundPayload(id: string, from: string, senderName: string, body = "Please send a quote") {
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
            text: { body },
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

describe("WhatsApp sender staging and customer review", () => {
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

  const auth = () => ({ Authorization: "Bearer " + token });
  const senders = (status = "open") => request(app).get("/connectors/sources/" + sourceId + "/whatsapp/senders?status=" + status).set(auth());
  const review = (senderId: string, body: unknown) =>
    request(app).post("/connectors/sources/" + sourceId + "/whatsapp/senders/" + senderId + "/review").set(auth()).send(body as object);
  const external = (waId: string) => prisma.externalContact.findFirstOrThrow({
    where: { connectorSourceId: sourceId, externalResourceName: "wa_id:" + waId },
  });

  it("keeps every inbound message and stages senders without adding anyone to CRM", async () => {
    const contactsBefore = await prisma.contact.count({ where: { companyId } });
    const clientsBefore = await prisma.client.count({ where: { companyId } });
    const firstPayload = inboundPayload("wamid.staged-1", "447700900123", "WhatsApp Customer");
    const first = await sendSignedWebhook(firstPayload);
    assert.equal(first.status, 200);
    assert.equal(first.body.importedCount, 1);
    assert.equal(first.body.contactSync.stagedForReviewCount, 1);
    assert.equal(await prisma.contact.count({ where: { companyId } }), contactsBefore, "no CRM contact created automatically");
    assert.equal(await prisma.client.count({ where: { companyId } }), clientsBefore, "no CRM client created automatically");

    const staged = await external("447700900123");
    assert.equal(staged.reviewStatus, "pending");
    assert.equal(staged.importedContactId, null);
    assert.equal(staged.phone, "+447700900123");
    assert.equal(await prisma.communicationIntake.count({ where: { companyId, senderPhone: "+447700900123" } }), 1);
    const storedMessage = await prisma.communicationIntake.findFirstOrThrow({
      where: { companyId, externalMessageId: "wamid.staged-1" },
      select: { sourceMetadata: true },
    });
    assert.deepEqual(storedMessage.sourceMetadata, { provider: "whatsapp_business", messageType: "text" });

    const replay = await sendSignedWebhook(firstPayload);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.duplicateCount, 1);
    assert.equal(replay.body.contactSync.stagedForReviewCount, 1);

    // An existing CRM contact with the same number is not linked or changed by the webhook.
    const existing = await prisma.contact.create({
      data: { companyId, displayName: "Manually maintained contact", phone: "07700 900456", source: "user_input" },
    });
    const matching = await sendSignedWebhook(inboundPayload("wamid.staged-2", "447700900456", "Provider profile name"));
    assert.equal(matching.status, 200);
    assert.equal((await external("447700900456")).importedContactId, null);
    const unchanged = await prisma.contact.findUniqueOrThrow({ where: { id: existing.id } });
    assert.equal(unchanged.displayName, "Manually maintained contact");

    const invalid = await sendSignedWebhook(inboundPayload("wamid.staged-invalid", "000", "Invalid number"));
    assert.equal(invalid.status, 200);
    assert.equal(invalid.body.contactSync.skippedInvalidCount, 1);

    const automaticImport = await request(app)
      .post("/connectors/sources/" + sourceId + "/external-contacts/" + staged.id + "/import")
      .set(auth())
      .send({ confirmed: true });
    assert.equal(automaticImport.status, 409);
    assert.equal(automaticImport.body.error, "CONTACT_IMPORT_NOT_SUPPORTED");

    const syncAudit = await prisma.auditLog.findFirstOrThrow({
      where: { actionName: "sync_whatsapp_sender_contacts", result: "success" },
      orderBy: { createdAt: "desc" },
    });
    assert.ok(!JSON.stringify(syncAudit.dataAfter).includes("447700900456"));
  });

  it("lists senders with their messages and a work-related signal that never decides", async () => {
    await sendSignedWebhook(inboundPayload("wamid.signal-1", "447700900501", "Garden Customer", "Hi, could you quote for a new patio and some hedge trimming?"));
    await sendSignedWebhook(inboundPayload("wamid.signal-2", "447700900502", "One Word", "Did you get the invoice?"));
    await sendSignedWebhook(inboundPayload("wamid.signal-3", "447700900503", "Friend", "See you at the pub tonight"));

    const listed = await senders();
    assert.equal(listed.status, 200);
    const byPhone = (phone: string) => listed.body.items.find((item: { phone: string }) => item.phone === phone);
    const candidate = byPhone("+447700900501");
    assert.equal(candidate.signal.level, "work_related_candidate");
    assert.ok(candidate.signal.matchedTerms.includes("patio"));
    assert.equal(candidate.signal.basis, "inference_from_message_text");
    assert.equal(candidate.messageCount, 1);
    assert.match(candidate.recentMessages[0].text, /patio/);
    assert.equal(candidate.reviewStatus, "pending");
    assert.equal(byPhone("+447700900502").signal.level, "weak_signal", "a single word is never enough");
    assert.equal(byPhone("+447700900503").signal.level, "no_work_terms");
    assert.equal(byPhone("+447700900503").reviewStatus, "pending", "no signal never rejects anyone");
    assert.equal(listed.body.items[0].signal.level, "work_related_candidate", "likely customers are listed first");
    assert.ok(listed.body.counts.pending >= 3);
    // Signals are an aid only: nothing was imported.
    assert.equal((await external("447700900501")).importedContactId, null);
  });

  it("imports a sender only after explicit customer approval, preview and confirmation", async () => {
    const sender = await external("447700900501");
    const preview = await review(sender.id, { decision: "approve_customer", import_as: "contact_and_client", display_name: "Garden Customer Ltd" });
    assert.equal(preview.status, 409);
    assert.equal(preview.body.error, "CONFIRMATION_REQUIRED");
    assert.equal(preview.body.preview.contact.action, "create");
    assert.equal(preview.body.preview.client.action, "create");
    assert.equal(await prisma.contact.count({ where: { companyId, phone: "+447700900501" } }), 0, "a preview creates nothing");

    const noRevision = await review(sender.id, { decision: "approve_customer", import_as: "contact_and_client", confirmed: true });
    assert.equal(noRevision.status, 400);

    const approved = await review(sender.id, {
      decision: "approve_customer", import_as: "contact_and_client", display_name: "Garden Customer Ltd",
      confirmed: true, expected_revision: preview.body.preview.revision,
    });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    const contact = await prisma.contact.findUniqueOrThrow({ where: { id: approved.body.contactId } });
    assert.equal(contact.displayName, "Garden Customer Ltd");
    assert.equal(contact.phone, "+447700900501");
    assert.equal(contact.source, "whatsapp_business");
    assert.equal(contact.sourceReference, "whatsapp:" + sourceId + ":wa_id:447700900501");
    assert.equal(contact.clientId, approved.body.clientId);
    const client = await prisma.client.findUniqueOrThrow({ where: { id: approved.body.clientId } });
    assert.equal(client.source, "whatsapp_business");
    const stagedAfter = await external("447700900501");
    assert.equal(stagedAfter.reviewStatus, "approved");
    assert.equal(stagedAfter.reviewClassification, "customer");
    assert.equal(stagedAfter.importedContactId, contact.id);
    assert.ok(await prisma.auditLog.findFirst({ where: { companyId, actionName: "review_whatsapp_sender", result: "success", confirmed: true } }));

    // Repeating the approval does not create a second contact.
    const again = await review(sender.id, { decision: "approve_customer", confirmed: true, expected_revision: preview.body.preview.revision });
    assert.equal(again.status, 200);
    assert.equal(again.body.alreadyApproved, true);
    assert.equal(await prisma.contact.count({ where: { companyId, phone: "+447700900501" } }), 1);

    // New messages from an approved sender are kept and do not create anything.
    const later = await sendSignedWebhook(inboundPayload("wamid.signal-1b", "447700900501", "Garden Customer", "Thanks, when can you start?"));
    assert.equal(later.body.contactSync.alreadyInCrmCount, 1);
    assert.equal(await prisma.contact.count({ where: { companyId, phone: "+447700900501" } }), 1);
  });

  it("links an approved sender to the one existing contact with the same number instead of duplicating", async () => {
    const sender = await external("447700900456");
    const preview = await review(sender.id, { decision: "approve_customer" });
    assert.equal(preview.status, 409);
    assert.equal(preview.body.preview.contact.action, "link_existing");
    const approved = await review(sender.id, { decision: "approve_customer", confirmed: true, expected_revision: preview.body.preview.revision });
    assert.equal(approved.status, 200);
    const linked = await prisma.contact.findUniqueOrThrow({ where: { id: approved.body.contactId } });
    assert.equal(linked.displayName, "Manually maintained contact", "existing CRM data is not overwritten");
  });

  it("refuses a confirmation when the sender changed after the preview", async () => {
    await sendSignedWebhook(inboundPayload("wamid.changed-1", "447700900601", "Changing Sender", "Quote for lawn mowing please"));
    const sender = await external("447700900601");
    const preview = await review(sender.id, { decision: "approve_customer" });
    await sendSignedWebhook(inboundPayload("wamid.changed-2", "447700900601", "Changing Sender", "Actually never mind"));
    const stale = await review(sender.id, { decision: "approve_customer", confirmed: true, expected_revision: preview.body.preview.revision });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error, "WHATSAPP_SENDER_CHANGED");
    assert.equal(await prisma.contact.count({ where: { companyId, phone: "+447700900601" } }), 0);
  });

  it("keeps rejected senders out of CRM until a person reopens them", async () => {
    const friend = await external("447700900503");
    const missingReason = await review(friend.id, { decision: "reject" });
    assert.equal(missingReason.status, 400);
    const rejected = await review(friend.id, { decision: "reject", classification: "personal", note: "Friend" });
    assert.equal(rejected.status, 200);
    assert.equal(rejected.body.reviewStatus, "rejected");

    const again = await sendSignedWebhook(inboundPayload("wamid.friend-2", "447700900503", "Friend", "Can you quote for my garden fence and patio?"));
    assert.equal(again.body.contactSync.suppressedCount, 1);
    assert.equal((await external("447700900503")).reviewStatus, "rejected", "a provider update never undoes a decision");
    assert.equal(await prisma.communicationIntake.count({ where: { companyId, senderPhone: "+447700900503" } }), 2, "their messages are still kept");

    const blocked = await review(friend.id, { decision: "approve_customer", confirmed: true, expected_revision: new Date().toISOString() });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error, "WHATSAPP_SENDER_SUPPRESSED");
    assert.equal(await prisma.contact.count({ where: { companyId, phone: "+447700900503" } }), 0);

    const employee = await external("447700900502");
    assert.equal((await review(employee.id, { decision: "mark_review_needed" })).status, 200);
    assert.equal((await review(employee.id, { decision: "reject", classification: "employee" })).status, 200);
    assert.equal((await senders("rejected")).body.items.length, 2);

    const reopened = await review(friend.id, { decision: "reopen" });
    assert.equal(reopened.status, 200);
    assert.equal(reopened.body.reviewStatus, "pending");
  });

  it("does not re-import a sender whose CRM contact was permanently deleted", async () => {
    const sender = await external("447700900501");
    const contactId = sender.importedContactId!;
    // Unlink from the client first so the client has no dependants; the contact itself can go.
    const contactPreview = await request(app).get("/crm/contacts/" + contactId + "/permanent-deletion").set(auth());
    const deleted = await request(app).post("/crm/contacts/" + contactId + "/permanent-deletion").set(auth()).send({
      confirmed: true, preview_digest: contactPreview.body.digest, confirm_display_name: contactPreview.body.displayName,
    });
    assert.equal(deleted.status, 200);
    assert.equal((await external("447700900501")).reviewStatus, "deleted_from_crm");
    const more = await sendSignedWebhook(inboundPayload("wamid.after-delete", "447700900501", "Garden Customer", "Hello again"));
    assert.equal(more.body.contactSync.suppressedCount, 1);
    assert.equal(await prisma.contact.count({ where: { companyId, phone: "+447700900501" } }), 0);
    const refused = await review(sender.id, { decision: "approve_customer" });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error, "WHATSAPP_SENDER_SUPPRESSED");
  });

  it("requires crm.manage to decide and keeps senders inside the company", async () => {
    const passwordHash = await bcrypt.hash("Password123!", 10);
    await prisma.user.create({
      data: { companyId, email: "wa-reader@test.local", passwordHash, displayName: "Reader", role: "office", permissions: ["crm.read", "connectors.read"] },
    });
    const otherCompany = await prisma.company.create({ data: { name: "Other WA Co" } });
    await prisma.user.create({
      data: { companyId: otherCompany.id, email: "wa-other@test.local", passwordHash, displayName: "Other", role: "administrator", permissions: ["crm.read", "crm.manage", "connectors.read", "connectors.manage"] },
    });
    const readerToken = (await request(app).post("/auth/login").send({ email: "wa-reader@test.local", password: "Password123!" })).body.token;
    const otherToken = (await request(app).post("/auth/login").send({ email: "wa-other@test.local", password: "Password123!" })).body.token;
    const sender = await external("447700900601");

    const readerList = await request(app).get("/connectors/sources/" + sourceId + "/whatsapp/senders").set("Authorization", "Bearer " + readerToken);
    assert.equal(readerList.status, 200);
    const readerDecision = await request(app).post("/connectors/sources/" + sourceId + "/whatsapp/senders/" + sender.id + "/review")
      .set("Authorization", "Bearer " + readerToken).send({ decision: "reject", classification: "personal" });
    assert.equal(readerDecision.status, 403);

    const foreignList = await request(app).get("/connectors/sources/" + sourceId + "/whatsapp/senders").set("Authorization", "Bearer " + otherToken);
    assert.equal(foreignList.status, 404);
    const foreignDecision = await request(app).post("/connectors/sources/" + sourceId + "/whatsapp/senders/" + sender.id + "/review")
      .set("Authorization", "Bearer " + otherToken).send({ decision: "reject", classification: "personal" });
    assert.equal(foreignDecision.status, 404);
    assert.equal((await external("447700900601")).reviewStatus, "pending");
  });
});
