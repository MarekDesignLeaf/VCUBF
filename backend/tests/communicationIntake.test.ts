import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import bcrypt from "bcryptjs";
import request from "supertest";
import { createServer } from "../src/server.js";
import { prisma } from "../src/db.js";
import { resetDb, seedCompanyAndAdmin, TEST_COMPANY_ID } from "./setup.js";

const app = createServer();

async function loginAs(email: string) {
  const response = await request(app).post("/auth/login").send({ email, password: "Password123!" });
  return response.body.token as string;
}

describe("Communication Extraction and Reply Drafting", () => {
  let adminToken: string;
  let workerToken: string;
  let intakeId: string;
  let clientId: string;

  before(async () => {
    await resetDb();
    await seedCompanyAndAdmin();
    adminToken = await loginAs("admin@test.local");
    workerToken = await loginAs("worker@test.local");
    await prisma.serviceCatalogueItem.create({
      data: { companyId: TEST_COMPANY_ID, name: "Garden Landscaping" },
    });
  });

  after(async () => {
    await resetDb();
    await prisma.$disconnect();
  });

  it("requires crm.manage to preserve an inbound communication", async () => {
    const response = await request(app)
      .post("/communications/intakes")
      .set("Authorization", `Bearer ${workerToken}`)
      .send({ channel: "email", message_text: "Hello", received_at: new Date().toISOString() });
    assert.equal(response.status, 403);
  });

  it("validates intake fields", async () => {
    const response = await request(app)
      .post("/communications/intakes")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ channel: "carrier_pigeon" });
    assert.equal(response.status, 400);
    assert.equal(response.body.error, "VALIDATION_FAILED");
  });

  it("preserves the original message and source reference", async () => {
    const response = await request(app)
      .post("/communications/intakes")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        channel: "web_form",
        sender_name: "Jane Smith",
        sender_email: "JANE.SMITH@example.com",
        sender_phone: "+44 7700 900123",
        message_text: "Address: 12 River Road, York YO1 7AA\nI need Garden Landscaping.",
        received_at: "2026-07-10T09:30:00.000Z",
        source_reference: "https://forms.example.test/submissions/42",
      });
    assert.equal(response.status, 201);
    assert.equal(response.body.messageText, "Address: 12 River Road, York YO1 7AA\nI need Garden Landscaping.");
    assert.equal(response.body.sourceReference, "https://forms.example.test/submissions/42");
    assert.equal(response.body.intakeStatus, "new");
    intakeId = response.body.id;

    const audit = await prisma.auditLog.findFirst({
      where: { actionName: "log_communication_intake", result: "success" },
    });
    assert.equal(audit?.result, "success");
  });

  it("extracts only evidenced contact, address and catalogue service data", async () => {
    const response = await request(app)
      .post(`/communications/intakes/${intakeId}/extract`)
      .set("Authorization", `Bearer ${adminToken}`);
    assert.equal(response.status, 200);
    assert.equal(response.body.intakeStatus, "extracted");
    assert.equal(response.body.extractedData.name, "Jane Smith");
    assert.equal(response.body.extractedData.email, "JANE.SMITH@example.com");
    assert.equal(response.body.extractedData.address, "12 River Road, York YO1 7AA");
    assert.equal(response.body.extractedData.postcode, "YO1 7AA");
    assert.deepEqual(response.body.extractedData.serviceMatches.map((item: any) => item.name), ["Garden Landscaping"]);
    assert.equal(response.body.extractedData.identityConfidence, "new_contact");
    assert.deepEqual(response.body.extractedData.missingFields, []);
  });

  it("prepares an internal reply draft without creating a client or communication log entry", async () => {
    const response = await request(app)
      .post(`/communications/intakes/${intakeId}/reply-draft`)
      .set("Authorization", `Bearer ${adminToken}`);
    assert.equal(response.status, 200);
    assert.match(response.body.replyDraft, /Dear Jane Smith/);
    assert.match(response.body.replyDraft, /Garden Landscaping/);
    assert.match(response.body.replyDraft, /Test Co/);
    assert.equal(await prisma.client.count(), 0);
    assert.equal(await prisma.communicationRecord.count(), 0);

    const audit = await prisma.auditLog.findFirst({ where: { actionName: "prepare_communication_reply" } });
    assert.equal(audit?.riskLevel, 1);
    assert.equal(audit?.confirmationRequired, false);
  });

  it("returns a conversion preview without writing CRM data", async () => {
    const beforeClients = await prisma.client.count();
    const response = await request(app)
      .post(`/communications/intakes/${intakeId}/convert`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    assert.equal(response.status, 409);
    assert.equal(response.body.error, "CONFIRMATION_REQUIRED");
    assert.equal(response.body.preview.operation, "create_new");
    assert.equal(response.body.preview.newClient.displayName, "Jane Smith");
    assert.equal(await prisma.client.count(), beforeClients);
    assert.equal(await prisma.communicationRecord.count(), 0);
  });

  it("creates and links the client only after confirmation, preserving provenance", async () => {
    const response = await request(app)
      .post(`/communications/intakes/${intakeId}/convert`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ confirmed: true });
    assert.equal(response.status, 200);
    assert.equal(response.body.client.displayName, "Jane Smith");
    assert.equal(response.body.client.source, "communication:web_form");
    assert.equal(response.body.communicationRecord.direction, "inbound");
    assert.equal(response.body.communicationRecord.followUpNeeded, true);
    assert.equal(response.body.intake.intakeStatus, "converted");
    assert.equal(response.body.intake.clientId, response.body.client.id);
    assert.equal(response.body.intake.communicationRecordId, response.body.communicationRecord.id);
    clientId = response.body.client.id;

    const stored = await prisma.communicationIntake.findUnique({ where: { id: intakeId } });
    assert.equal(stored?.sourceReference, "https://forms.example.test/submissions/42");
    const audit = await prisma.auditLog.findFirst({
      where: { actionName: "create_client_from_communication", result: "success" },
    });
    assert.equal(audit?.confirmed, true);
    assert.equal(audit?.confirmationRequired, true);
  });

  it("reuses one exact contact match instead of creating a duplicate client", async () => {
    const create = await request(app)
      .post("/communications/intakes")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        channel: "email",
        sender_name: "Jane Smith",
        sender_email: "jane.smith@example.com",
        message_text: "Please call me about Garden Landscaping.",
        received_at: new Date().toISOString(),
      });
    await request(app)
      .post(`/communications/intakes/${create.body.id}/extract`)
      .set("Authorization", `Bearer ${adminToken}`);
    const preview = await request(app)
      .post(`/communications/intakes/${create.body.id}/convert`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    assert.equal(preview.body.preview.operation, "link_existing");
    assert.equal(preview.body.preview.selectedClient.id, clientId);

    const beforeClients = await prisma.client.count();
    const confirmed = await request(app)
      .post(`/communications/intakes/${create.body.id}/convert`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ confirmed: true });
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.body.client.id, clientId);
    assert.equal(await prisma.client.count(), beforeClients);
  });

  it("requires an explicit client selection for a name-only possible match", async () => {
    const create = await request(app)
      .post("/communications/intakes")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        channel: "sms",
        sender_name: "Jane Smith",
        sender_phone: "07111 222333",
        message_text: "I need Garden Landscaping.",
        received_at: new Date().toISOString(),
      });
    await request(app)
      .post(`/communications/intakes/${create.body.id}/extract`)
      .set("Authorization", `Bearer ${adminToken}`);
    const preview = await request(app)
      .post(`/communications/intakes/${create.body.id}/convert`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    assert.equal(preview.body.preview.operation, "selection_required");

    const blocked = await request(app)
      .post(`/communications/intakes/${create.body.id}/convert`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ confirmed: true });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error, "CLIENT_SELECTION_REQUIRED");

    const linked = await request(app)
      .post(`/communications/intakes/${create.body.id}/convert`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ client_id: clientId, confirmed: true });
    assert.equal(linked.status, 200);
    assert.equal(linked.body.client.id, clientId);
  });

  it("allows only one of two concurrent confirmations to create CRM records", async () => {
    const create = await request(app)
      .post("/communications/intakes")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        channel: "email",
        sender_name: "Concurrent Customer",
        sender_email: "concurrent@example.com",
        message_text: "I need Garden Landscaping.",
        received_at: new Date().toISOString(),
      });
    await request(app)
      .post(`/communications/intakes/${create.body.id}/extract`)
      .set("Authorization", `Bearer ${adminToken}`);
    const clientsBefore = await prisma.client.count();
    const recordsBefore = await prisma.communicationRecord.count();

    const responses = await Promise.all([
      request(app)
        .post(`/communications/intakes/${create.body.id}/convert`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ confirmed: true }),
      request(app)
        .post(`/communications/intakes/${create.body.id}/convert`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ confirmed: true }),
    ]);

    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
    assert.equal(await prisma.client.count(), clientsBefore + 1);
    assert.equal(await prisma.communicationRecord.count(), recordsBefore + 1);
  });

  it("does not expose another company's intake", async () => {
    const company = await prisma.company.create({ data: { name: "Other Co" } });
    const passwordHash = await bcrypt.hash("Password123!", 10);
    await prisma.user.create({
      data: {
        companyId: company.id,
        email: "other-intake@test.local",
        passwordHash,
        displayName: "Other Admin",
        permissions: ["crm.read", "crm.manage"],
      },
    });
    const otherIntake = await prisma.communicationIntake.create({
      data: {
        companyId: company.id,
        channel: "email",
        messageText: "Other company's private message",
        receivedAt: new Date(),
      },
    });

    const get = await request(app)
      .get(`/communications/intakes/${otherIntake.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    assert.equal(get.status, 404);
    const extract = await request(app)
      .post(`/communications/intakes/${otherIntake.id}/extract`)
      .set("Authorization", `Bearer ${adminToken}`);
    assert.equal(extract.status, 404);
    const list = await request(app)
      .get("/communications/intakes")
      .set("Authorization", `Bearer ${adminToken}`);
    assert.ok(!list.body.some((item: any) => item.id === otherIntake.id));
  });
});
