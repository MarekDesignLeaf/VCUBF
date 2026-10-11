import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import request from "supertest";
import { createServer } from "../src/server.js";
import { prisma } from "../src/db.js";
import { resetDb, seedCompanyAndAdmin, TEST_COMPANY_ID } from "./setup.js";

const app = createServer();

async function loginAs(email: string) {
  const response = await request(app).post("/auth/login").send({ email, password: "Password123!" });
  return response.body.token as string;
}

describe("Unresolved Enquiry Monitoring", () => {
  let adminToken: string;
  let workerToken: string;
  let clientId: string;
  let openIntakeId: string;
  let resolvedIntakeId: string;
  let oldIntakeId: string;
  let openCommunicationId: string;
  let resolvedCommunicationId: string;
  let outboundCommunicationId: string;

  before(async () => {
    await resetDb();
    await seedCompanyAndAdmin();
    adminToken = await loginAs("admin@test.local");
    workerToken = await loginAs("worker@test.local");

    const client = await request(app)
      .post("/crm/clients")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ display_name: "Enquiry Client", email_primary: "enquiries@example.com" });
    clientId = client.body.id;

    const now = new Date();
    const old = new Date(now.getTime() - 20 * 24 * 60 * 60 * 1000);
    const openIntake = await request(app)
      .post("/communications/intakes")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        channel: "email",
        sender_name: "Open Enquiry",
        message_text: "Please contact me about fencing.",
        received_at: now.toISOString(),
        source_reference: "mailbox://open-enquiry",
      });
    openIntakeId = openIntake.body.id;

    const resolvedIntake = await request(app)
      .post("/communications/intakes")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        channel: "sms",
        sender_name: "Resolved Enquiry",
        message_text: "This has already been handled.",
        received_at: now.toISOString(),
      });
    resolvedIntakeId = resolvedIntake.body.id;
    await request(app)
      .put(`/communications/intakes/${resolvedIntakeId}/resolution`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ resolution_needed: false });

    const oldIntake = await request(app)
      .post("/communications/intakes")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        channel: "web_form",
        sender_name: "Old Enquiry",
        message_text: "An older unresolved request.",
        received_at: old.toISOString(),
      });
    oldIntakeId = oldIntake.body.id;

    const openCommunication = await request(app)
      .post("/communications")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        client_id: clientId,
        channel: "whatsapp",
        direction: "inbound",
        summary: "Client requested a callback",
        occurred_at: now.toISOString(),
        follow_up_needed: true,
      });
    openCommunicationId = openCommunication.body.id;

    const resolvedCommunication = await request(app)
      .post("/communications")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        client_id: clientId,
        channel: "phone_call",
        direction: "inbound",
        summary: "Inbound call already resolved",
        occurred_at: now.toISOString(),
        follow_up_needed: false,
      });
    resolvedCommunicationId = resolvedCommunication.body.id;

    const outboundCommunication = await request(app)
      .post("/communications")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        client_id: clientId,
        channel: "email",
        direction: "outbound",
        summary: "Outbound action is not an inbound enquiry",
        occurred_at: now.toISOString(),
        follow_up_needed: true,
      });
    outboundCommunicationId = outboundCommunication.body.id;
  });

  after(async () => {
    await resetDb();
    await prisma.$disconnect();
  });

  it("requires crm.read to list enquiries", async () => {
    const response = await request(app)
      .get("/communications/enquiries")
      .set("Authorization", `Bearer ${workerToken}`);
    assert.equal(response.status, 403);
  });

  it("lists only explicitly unresolved inbound items by default, without duplicates", async () => {
    const response = await request(app)
      .get("/communications/enquiries")
      .set("Authorization", `Bearer ${adminToken}`);
    assert.equal(response.status, 200);
    const keys = response.body.map((item: any) => item.key);
    assert.ok(keys.includes(`communication_intake:${openIntakeId}`));
    assert.ok(keys.includes(`communication_intake:${oldIntakeId}`));
    assert.ok(keys.includes(`communication_record:${openCommunicationId}`));
    assert.ok(!keys.includes(`communication_intake:${resolvedIntakeId}`));
    assert.ok(!keys.includes(`communication_record:${resolvedCommunicationId}`));
    assert.ok(!keys.includes(`communication_record:${outboundCommunicationId}`));
    assert.equal(new Set(keys).size, keys.length);
  });

  it("filters by resolved state, channel and evidence-backed received period", async () => {
    const resolved = await request(app)
      .get("/communications/enquiries?resolution=resolved")
      .set("Authorization", `Bearer ${adminToken}`);
    const resolvedKeys = resolved.body.map((item: any) => item.key);
    assert.ok(resolvedKeys.includes(`communication_intake:${resolvedIntakeId}`));
    assert.ok(resolvedKeys.includes(`communication_record:${resolvedCommunicationId}`));

    const sms = await request(app)
      .get("/communications/enquiries?resolution=all&channel=sms")
      .set("Authorization", `Bearer ${adminToken}`);
    assert.deepEqual(sms.body.map((item: any) => item.key), [`communication_intake:${resolvedIntakeId}`]);

    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const recent = await request(app)
      .get(`/communications/enquiries?since=${encodeURIComponent(since)}`)
      .set("Authorization", `Bearer ${adminToken}`);
    assert.ok(!recent.body.some((item: any) => item.sourceId === oldIntakeId));
    assert.ok(recent.body.some((item: any) => item.sourceId === openIntakeId));
  });

  it("rejects invalid query values", async () => {
    const response = await request(app)
      .get("/communications/enquiries?resolution=maybe&channel=carrier_pigeon")
      .set("Authorization", `Bearer ${adminToken}`);
    assert.equal(response.status, 400);
    assert.equal(response.body.error, "VALIDATION_FAILED");
  });

  it("validates resolution writes, permissions and tenant-scoped ids", async () => {
    const forbidden = await request(app)
      .put(`/communications/intakes/${openIntakeId}/resolution`)
      .set("Authorization", `Bearer ${workerToken}`)
      .send({ resolution_needed: false });
    assert.equal(forbidden.status, 403);

    const invalid = await request(app)
      .put(`/communications/intakes/${openIntakeId}/resolution`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ resolution_needed: "no" });
    assert.equal(invalid.status, 400);

    const missing = await request(app)
      .put("/communications/intakes/00000000-0000-0000-0000-000000000099/resolution")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ resolution_needed: false });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error, "COMMUNICATION_INTAKE_NOT_FOUND");
  });

  it("resolves and reopens an intake with before/after audit evidence", async () => {
    const resolved = await request(app)
      .put(`/communications/intakes/${openIntakeId}/resolution`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ resolution_needed: false });
    assert.equal(resolved.status, 200);
    assert.equal(resolved.body.intake.resolutionNeeded, false);
    assert.ok(resolved.body.intake.resolvedAt);

    const reopened = await request(app)
      .put(`/communications/intakes/${openIntakeId}/resolution`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ resolution_needed: true });
    assert.equal(reopened.status, 200);
    assert.equal(reopened.body.intake.resolutionNeeded, true);
    assert.equal(reopened.body.intake.resolvedAt, null);

    const audits = await prisma.auditLog.findMany({
      where: { actionName: "set_communication_intake_resolution", result: "success" },
      orderBy: { createdAt: "asc" },
    });
    assert.ok(audits.some((audit: any) => (audit.dataBefore as any)?.resolutionNeeded === true));
    assert.ok(audits.some((audit: any) => (audit.dataAfter as any)?.intake?.resolutionNeeded === true));
  });

  it("synchronises resolution with a converted intake's Communication Log record in both directions", async () => {
    const created = await request(app)
      .post("/communications/intakes")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        channel: "email",
        sender_name: "Converted Resolution Client",
        sender_email: "converted-resolution@example.com",
        message_text: "Please contact me.",
        received_at: new Date().toISOString(),
      });
    await request(app)
      .post(`/communications/intakes/${created.body.id}/extract`)
      .set("Authorization", `Bearer ${adminToken}`);
    const converted = await request(app)
      .post(`/communications/intakes/${created.body.id}/convert`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ confirmed: true });
    assert.equal(converted.status, 200);
    const communicationId = converted.body.communicationRecord.id;

    const resolved = await request(app)
      .put(`/communications/intakes/${created.body.id}/resolution`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ resolution_needed: false });
    assert.equal(resolved.body.communicationRecord.followUpNeeded, false);

    await request(app)
      .put(`/communications/${communicationId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ follow_up_needed: true });
    const intake = await prisma.communicationIntake.findUniqueOrThrow({ where: { id: created.body.id } });
    assert.equal(intake.resolutionNeeded, true);
    assert.equal(intake.resolvedAt, null);

    const all = await request(app)
      .get("/communications/enquiries?resolution=all")
      .set("Authorization", `Bearer ${adminToken}`);
    assert.ok(all.body.some((item: any) => item.key === `communication_record:${communicationId}`));
    assert.ok(!all.body.some((item: any) => item.key === `communication_intake:${created.body.id}`));
  });

  it("surfaces an unresolved raw intake in Notifications without inventing urgency", async () => {
    const response = await request(app)
      .get("/notifications")
      .set("Authorization", `Bearer ${adminToken}`);
    const item = response.body.find((entry: any) => entry.key === `unresolved_enquiry:${openIntakeId}`);
    assert.ok(item);
    assert.equal(item.type, "unresolved_enquiry");
    assert.equal(item.severity, "warning");
    assert.equal(item.dueAt, null);
    assert.equal(item.entity.type, "communication_intake");
  });

  it("reopening an intake makes an acknowledged unresolved notification resurface", async () => {
    const key = `unresolved_enquiry:${openIntakeId}`;
    await request(app)
      .post("/notifications/acknowledge")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ notification_key: key });
    await request(app)
      .put(`/communications/intakes/${openIntakeId}/resolution`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ resolution_needed: false });
    await request(app)
      .put(`/communications/intakes/${openIntakeId}/resolution`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ resolution_needed: true });

    const response = await request(app)
      .get("/notifications")
      .set("Authorization", `Bearer ${adminToken}`);
    assert.ok(response.body.some((item: any) => item.key === key));
  });

  it("supports the text command for all-time and last-week unresolved enquiries", async () => {
    const all = await request(app)
      .post("/command/text")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ text: "show unresolved enquiries" });
    assert.equal(all.status, 200);
    assert.equal(all.body.intent, "list_unresolved_enquiries");
    assert.ok(all.body.data.some((item: any) => item.sourceId === oldIntakeId));

    const recent = await request(app)
      .post("/command/text")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ text: "check unresolved enquiries from the last week" });
    assert.equal(recent.status, 200);
    assert.equal(recent.body.interpreted.since_days, 7);
    assert.ok(!recent.body.data.some((item: any) => item.sourceId === oldIntakeId));
  });

  it("keeps enquiry records isolated between companies", async () => {
    const otherCompany = await prisma.company.create({ data: { name: "Other Enquiry Co" } });
    const other = await prisma.communicationIntake.create({
      data: {
        companyId: otherCompany.id,
        channel: "email",
        messageText: "Private other-company enquiry",
        receivedAt: new Date(),
      },
    });

    const list = await request(app)
      .get("/communications/enquiries?resolution=all")
      .set("Authorization", `Bearer ${adminToken}`);
    assert.ok(!list.body.some((item: any) => item.sourceId === other.id));
    const update = await request(app)
      .put(`/communications/intakes/${other.id}/resolution`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ resolution_needed: false });
    assert.equal(update.status, 404);
  });

  it("gives an unanswered WhatsApp message its real deadline: the 24-hour reply window", async () => {
    const hour = 60 * 60 * 1000;
    const now = Date.now();
    const whatsapp = (phone: string, hoursAgo: number, extra: Record<string, unknown> = {}) => prisma.communicationIntake.create({
      data: {
        companyId: TEST_COMPANY_ID,
        channel: "whatsapp",
        senderName: `Sender ${phone.slice(-3)}`,
        senderPhone: phone,
        externalMessageId: `wamid.${phone}.${hoursAgo}`,
        messageText: "Can you come and look at the hedge?",
        receivedAt: new Date(now - hoursAgo * hour),
        ...extra,
      },
    });
    const closing = await whatsapp("+447700900101", 21);
    const fresh = await whatsapp("+447700900102", 2);
    const closed = await whatsapp("+447700900103", 30);
    const answered = await whatsapp("+447700900104", 21, { sourceMetadata: { replies: [{ messageId: "wamid.out", sentAt: new Date(now - hour).toISOString() }] } });
    // An older message whose sender wrote again an hour ago: the newer one opens the window.
    const older = await whatsapp("+447700900105", 21);
    await whatsapp("+447700900105", 1, { resolutionNeeded: false, resolvedAt: new Date() });
    // Logged by hand (no message id from WhatsApp): may be a personal number, no window.
    const manual = await prisma.communicationIntake.create({
      data: { companyId: TEST_COMPANY_ID, channel: "whatsapp", senderName: "Manual", senderPhone: "+447700900106", messageText: "hello", receivedAt: new Date(now - 21 * hour) },
    });

    const response = await request(app).get("/notifications").set("Authorization", `Bearer ${adminToken}`);
    assert.equal(response.status, 200);
    const byKey = new Map(response.body.map((item: any) => [item.key, item]));

    const urgent: any = byKey.get(`whatsapp_reply_window:${closing.id}`);
    assert.ok(urgent, "the last four hours of the window are urgent, under a key of their own");
    assert.equal(urgent.type, "whatsapp_reply_window");
    assert.equal(urgent.severity, "urgent");
    assert.equal(urgent.dueAt, new Date(closing.receivedAt.getTime() + 24 * hour).toISOString());
    assert.match(urgent.message, /about 2 h more/);
    assert.equal(byKey.has(`unresolved_enquiry:${closing.id}`), false, "not both at once");

    const open: any = byKey.get(`unresolved_enquiry:${fresh.id}`);
    assert.equal(open.severity, "warning");
    assert.equal(open.dueAt, new Date(fresh.receivedAt.getTime() + 24 * hour).toISOString());
    assert.match(open.message, /free-form reply for about 2\d h more/);

    const gone: any = byKey.get(`unresolved_enquiry:${closed.id}`);
    assert.equal(gone.severity, "warning");
    assert.equal(gone.dueAt, null);
    assert.match(gone.message, /reply window has closed/);

    for (const plain of [answered, manual]) {
      const item: any = byKey.get(`unresolved_enquiry:${plain.id}`);
      assert.equal(item.dueAt, null);
      assert.match(item.message, /No response deadline is recorded/);
    }

    const renewed: any = byKey.get(`unresolved_enquiry:${older.id}`);
    assert.equal(renewed.severity, "warning", "the sender wrote again, so the window is open for another day");
    assert.ok(Date.parse(renewed.dueAt) > now + 22 * hour);

    // Acknowledged while it was only a warning, it still comes back when the window is about to close.
    await request(app).post("/notifications/acknowledge").set("Authorization", `Bearer ${adminToken}`).send({ notification_key: `unresolved_enquiry:${closing.id}` });
    const again = await request(app).get("/notifications").set("Authorization", `Bearer ${adminToken}`);
    assert.ok(again.body.some((item: any) => item.key === `whatsapp_reply_window:${closing.id}`));
  });
});

