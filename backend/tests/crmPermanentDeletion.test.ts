import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import bcrypt from "bcryptjs";
import request from "supertest";
import { prisma } from "../src/db.js";
import { MCP_WRITE_TOOLS } from "../src/modules/mcp/writeTools.js";
import { createServer } from "../src/server.js";
import { resetDb, seedCompanyAndAdmin } from "./setup.js";

const app = createServer();

async function loginAs(email: string) {
  const res = await request(app).post("/auth/login").send({ email, password: "Password123!" });
  assert.equal(res.status, 200, `login as ${email}`);
  return res.body.token as string;
}

describe("Permanent deletion of CRM clients and contacts (separate from archive)", () => {
  let adminToken: string;
  let workerToken: string;
  let readerToken: string;
  let otherTenantToken: string;
  let companyId: string;
  let adminId: string;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const previewClient = (id: string, token = adminToken) => request(app).get(`/crm/clients/${id}/permanent-deletion`).set(auth(token));
  const deleteClient = (id: string, body: unknown, token = adminToken) =>
    request(app).post(`/crm/clients/${id}/permanent-deletion`).set(auth(token)).send(body as object);
  const previewContact = (id: string, token = adminToken) => request(app).get(`/crm/contacts/${id}/permanent-deletion`).set(auth(token));
  const deleteContact = (id: string, body: unknown, token = adminToken) =>
    request(app).post(`/crm/contacts/${id}/permanent-deletion`).set(auth(token)).send(body as object);

  async function confirmBody(previewBody: { digest: string; displayName: string }) {
    return { confirmed: true, preview_digest: previewBody.digest, confirm_display_name: previewBody.displayName };
  }

  before(async () => {
    await resetDb();
    const seeded = await seedCompanyAndAdmin();
    companyId = seeded.company.id;
    adminId = seeded.admin.id;
    const passwordHash = await bcrypt.hash("Password123!", 10);
    await prisma.user.create({
      data: { companyId, email: "reader@test.local", passwordHash, displayName: "Reader", role: "office", permissions: ["crm.read"] },
    });
    const companyB = await prisma.company.create({ data: { name: "Other Tenant Ltd" } });
    await prisma.user.create({
      data: { companyId: companyB.id, email: "other-admin@test.local", passwordHash, displayName: "Other Admin", role: "administrator", permissions: ["crm.read", "crm.manage"] },
    });
    adminToken = await loginAs("admin@test.local");
    workerToken = await loginAs("worker@test.local");
    readerToken = await loginAs("reader@test.local");
    otherTenantToken = await loginAs("other-admin@test.local");
  });

  after(async () => {
    await resetDb();
    await prisma.$disconnect();
  });

  it("keeps DELETE /crm/clients/:id as the reversible archive, not a permanent delete", async () => {
    const client = await prisma.client.create({ data: { companyId, displayName: "Archive Only Ltd" } });
    const archived = await request(app).delete(`/crm/clients/${client.id}`).set(auth(adminToken)).send({ confirmed: true });
    assert.equal(archived.status, 200);
    const row = await prisma.client.findUnique({ where: { id: client.id } });
    assert.ok(row, "archiving never removes the row");
    assert.equal(row.isActive, false);

    const listedArchived = await request(app).get("/crm/clients?status=archived").set(auth(adminToken));
    assert.equal(listedArchived.status, 200);
    assert.ok(listedArchived.body.some((item: { id: string }) => item.id === client.id));
    const listedActive = await request(app).get("/crm/clients").set(auth(adminToken));
    assert.ok(!listedActive.body.some((item: { id: string }) => item.id === client.id));
  });

  it("requires crm.manage for the preview and the deletion", async () => {
    const client = await prisma.client.create({ data: { companyId, displayName: "Permission Check Ltd" } });
    for (const token of [workerToken, readerToken]) {
      assert.equal((await previewClient(client.id, token)).status, 403);
      assert.equal((await deleteClient(client.id, { confirmed: true }, token)).status, 403);
    }
    assert.ok(await prisma.client.findUnique({ where: { id: client.id } }));
  });

  it("previews exact identity, then deletes only with confirmation, the digest and the typed name", async () => {
    const client = await prisma.client.create({
      data: { companyId, displayName: "Delete Me Ltd", emailPrimary: "delete-me@example.test", phonePrimary: "+447700900111", source: "manual" },
    });
    const preview = await previewClient(client.id);
    assert.equal(preview.status, 200);
    assert.equal(preview.body.kind, "client");
    assert.equal(preview.body.id, client.id);
    assert.equal(preview.body.displayName, "Delete Me Ltd");
    assert.equal(preview.body.identity.emailPrimary, "delete-me@example.test");
    assert.equal(preview.body.identity.phonePrimary, "+447700900111");
    assert.equal(preview.body.status, "active");
    assert.equal(preview.body.canDelete, true);
    assert.deepEqual(preview.body.blockers, []);
    assert.match(preview.body.digest, /^[a-f0-9]{64}$/);
    for (const key of ["jobs", "quotes", "invoices", "payments", "communicationRecords", "communicationIntakes", "tasks", "portfolioPhotos", "documentRecords", "contacts", "convertedLeads", "mergeRecords"]) {
      assert.equal(preview.body.dependencies[key], 0, key);
    }

    const unconfirmed = await deleteClient(client.id, {});
    assert.equal(unconfirmed.status, 409);
    assert.equal(unconfirmed.body.error, "CONFIRMATION_REQUIRED");
    assert.equal(unconfirmed.body.preview.digest, preview.body.digest);

    const noDigest = await deleteClient(client.id, { confirmed: true, confirm_display_name: "Delete Me Ltd" });
    assert.equal(noDigest.status, 400);

    const wrongName = await deleteClient(client.id, { ...(await confirmBody(preview.body)), confirm_display_name: "Delete Me" });
    assert.equal(wrongName.status, 400);
    assert.equal(wrongName.body.error, "CONFIRMATION_TEXT_MISMATCH");
    assert.ok(await prisma.client.findUnique({ where: { id: client.id } }));

    const deleted = await deleteClient(client.id, await confirmBody(preview.body));
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
    assert.equal(deleted.body.deleted, true);
    assert.equal(await prisma.client.findUnique({ where: { id: client.id } }), null);

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { companyId, actionName: "delete_client_permanently", result: "success" },
      orderBy: { createdAt: "desc" },
    });
    assert.equal(audit.userId, adminId);
    assert.equal(audit.confirmed, true);
    assert.equal(audit.riskLevel, 5);
    assert.equal((audit.dataBefore as { displayName: string }).displayName, "Delete Me Ltd");
    assert.equal((audit.inputPayload as { id: string }).id, client.id);

    // A repeated confirmation is answered from the audit trail, not re-run.
    const repeated = await deleteClient(client.id, await confirmBody(preview.body));
    assert.equal(repeated.status, 200);
    assert.equal(repeated.body.alreadyDeleted, true);
    assert.equal(await prisma.auditLog.count({ where: { companyId, actionName: "delete_client_permanently", result: "success" } }), 1);
  });

  it("refuses a stale preview after the client was edited", async () => {
    const client = await prisma.client.create({ data: { companyId, displayName: "Stale Preview Ltd" } });
    const preview = await previewClient(client.id);
    const edited = await request(app).put(`/crm/clients/${client.id}`).set(auth(adminToken)).send({ notes: "Changed after preview" });
    assert.equal(edited.status, 200);
    const stale = await deleteClient(client.id, await confirmBody(preview.body));
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error, "PREVIEW_STALE");
    assert.notEqual(stale.body.preview.digest, preview.body.digest);
    assert.ok(await prisma.client.findUnique({ where: { id: client.id } }));
  });

  it("refuses while any work, financial, communication or history record depends on the client", async () => {
    const make = (name: string) => prisma.client.create({ data: { companyId, displayName: name } });
    const cases: Array<{ key: string; setup: (clientId: string) => Promise<unknown> }> = [
      { key: "jobs", setup: (clientId) => prisma.job.create({ data: { companyId, clientId, jobTitle: "Hedge trimming" } }) },
      { key: "quotes", setup: (clientId) => prisma.quote.create({ data: { companyId, clientId, title: "Patio quote" } }) },
      {
        key: "payments",
        setup: async (clientId) => {
          const invoice = await prisma.invoice.create({ data: { companyId, clientId, invoiceNumber: `INV-${clientId.slice(0, 6)}`, title: "Lawn" } });
          await prisma.payment.create({ data: { companyId, invoiceId: invoice.id, amount: 10, paidAt: new Date() } });
        },
      },
      {
        key: "communicationRecords",
        setup: (clientId) => prisma.communicationRecord.create({ data: { companyId, clientId, channel: "phone", direction: "inbound", summary: "Called about fence", occurredAt: new Date() } }),
      },
      {
        key: "communicationIntakes",
        setup: (clientId) => prisma.communicationIntake.create({ data: { companyId, clientId, channel: "whatsapp", messageText: "Hello", receivedAt: new Date() } }),
      },
      { key: "tasks", setup: (clientId) => prisma.task.create({ data: { companyId, clientId, title: "Call back" } }) },
      { key: "documentRecords", setup: (clientId) => prisma.documentRecord.create({ data: { companyId, clientId, title: "Contract", documentType: "contract", documentReference: "ref-1" } }) },
      // Archived contacts would be silently unlinked by ON DELETE SET NULL: still a blocker.
      { key: "contacts", setup: (clientId) => prisma.contact.create({ data: { companyId, clientId, displayName: "Archived person", phone: "+447700900222", isActive: false } }) },
      { key: "convertedLeads", setup: (clientId) => prisma.lead.create({ data: { companyId, name: "Converted lead", leadStatus: "converted", convertedClientId: clientId } }) },
      {
        key: "mergeRecords",
        setup: async (clientId) => {
          const other = await make("Merge partner");
          await prisma.clientMergeRecord.create({ data: { companyId, primaryClientId: other.id, duplicateClientId: clientId, relinkedRecordIds: {}, duplicateWasActive: true } });
        },
      },
    ];
    for (const { key, setup } of cases) {
      const client = await make(`Blocked by ${key}`);
      await setup(client.id);
      const preview = await previewClient(client.id);
      assert.equal(preview.status, 200, key);
      assert.equal(preview.body.canDelete, false, key);
      assert.ok(preview.body.blockers.some((blocker: { key: string; count: number }) => blocker.key === key && blocker.count >= 1), key);
      const refused = await deleteClient(client.id, await confirmBody(preview.body));
      assert.equal(refused.status, 409, key);
      assert.equal(refused.body.error, "DELETION_BLOCKED", key);
      assert.ok(await prisma.client.findUnique({ where: { id: client.id } }), `${key}: client kept`);
    }
    assert.ok(await prisma.auditLog.findFirst({ where: { companyId, actionName: "delete_client_permanently", errorMessage: "DELETION_BLOCKED" } }));
  });

  it("refuses when a dependent record is linked after the preview", async () => {
    const client = await prisma.client.create({ data: { companyId, displayName: "Late Task Ltd" } });
    const preview = await previewClient(client.id);
    assert.equal(preview.body.canDelete, true);
    await prisma.task.create({ data: { companyId, clientId: client.id, title: "Created after preview" } });
    const refused = await deleteClient(client.id, await confirmBody(preview.body));
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error, "DELETION_BLOCKED");
    const task = await prisma.task.findFirstOrThrow({ where: { title: "Created after preview" } });
    assert.equal(task.clientId, client.id, "the task is not orphaned");
  });

  it("deletes an archived client with no dependencies", async () => {
    const client = await prisma.client.create({ data: { companyId, displayName: "Already Archived Ltd", isActive: false } });
    const preview = await previewClient(client.id);
    assert.equal(preview.body.status, "archived");
    const deleted = await deleteClient(client.id, await confirmBody(preview.body));
    assert.equal(deleted.status, 200);
    assert.equal(await prisma.client.findUnique({ where: { id: client.id } }), null);
  });

  it("isolates tenants: another company can neither preview, delete nor learn about the record", async () => {
    const client = await prisma.client.create({ data: { companyId, displayName: "Tenant A Client" } });
    const contact = await prisma.contact.create({ data: { companyId, displayName: "Tenant A Contact", phone: "+447700900333" } });
    const ownPreview = await previewClient(client.id);
    assert.equal((await previewClient(client.id, otherTenantToken)).status, 404);
    const foreign = await deleteClient(client.id, await confirmBody(ownPreview.body), otherTenantToken);
    assert.equal(foreign.status, 404);
    assert.ok(await prisma.client.findUnique({ where: { id: client.id } }));
    const ownContactPreview = await previewContact(contact.id);
    assert.equal((await previewContact(contact.id, otherTenantToken)).status, 404);
    assert.equal((await deleteContact(contact.id, await confirmBody(ownContactPreview.body), otherTenantToken)).status, 404);
    assert.ok(await prisma.contact.findUnique({ where: { id: contact.id } }));

    // Once deleted in A, a repeat from B is still a plain 404, not "already deleted".
    assert.equal((await deleteClient(client.id, await confirmBody(ownPreview.body))).status, 200);
    const foreignRepeat = await deleteClient(client.id, await confirmBody(ownPreview.body), otherTenantToken);
    assert.equal(foreignRepeat.status, 404);
  });

  it("deletes a contact but keeps its client, staged WhatsApp record and messages, and suppresses re-import", async () => {
    const client = await prisma.client.create({ data: { companyId, displayName: "Contact Owner Ltd" } });
    const contact = await prisma.contact.create({
      data: { companyId, clientId: client.id, displayName: "WhatsApp Person", phone: "+447700900444", source: "whatsapp_business", sourceReference: "whatsapp:src:wa_id:447700900444" },
    });
    const source = await prisma.connectorSource.create({
      data: { companyId, connectorKey: "whatsapp_business", displayName: "WA", serviceType: "messaging" },
    });
    const external = await prisma.externalContact.create({
      data: { companyId, connectorSourceId: source.id, externalResourceName: "wa_id:447700900444", phone: "+447700900444", importedContactId: contact.id },
    });
    await prisma.communicationIntake.create({
      data: { companyId, connectorSourceId: source.id, channel: "whatsapp", senderPhone: "+447700900444", messageText: "Can you quote for a patio?", receivedAt: new Date() },
    });

    const preview = await previewContact(contact.id);
    assert.equal(preview.status, 200);
    assert.equal(preview.body.kind, "contact");
    assert.equal(preview.body.identity.phone, "+447700900444");
    assert.equal(preview.body.identity.sourceReference, "whatsapp:src:wa_id:447700900444");
    assert.deepEqual(preview.body.client, { id: client.id, displayName: "Contact Owner Ltd" });
    assert.equal(preview.body.externalLinks.length, 1);
    assert.equal(preview.body.externalLinks[0].externalResourceName, "wa_id:447700900444");
    assert.equal(preview.body.communicationIntakesKept, 1);
    assert.equal(preview.body.canDelete, true);

    const archive = await request(app).delete(`/crm/contacts/${contact.id}`).set(auth(adminToken)).send({});
    assert.equal(archive.status, 409, "the archive route still only previews without confirmation");
    assert.ok(await prisma.contact.findUnique({ where: { id: contact.id } }));

    const deleted = await deleteContact(contact.id, await confirmBody(preview.body));
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
    assert.equal(await prisma.contact.findUnique({ where: { id: contact.id } }), null);
    assert.ok(await prisma.client.findUnique({ where: { id: client.id } }), "client kept");
    const keptExternal = await prisma.externalContact.findUniqueOrThrow({ where: { id: external.id } });
    assert.equal(keptExternal.importedContactId, null);
    assert.equal(keptExternal.reviewStatus, "deleted_from_crm");
    assert.equal(await prisma.communicationIntake.count({ where: { companyId, senderPhone: "+447700900444" } }), 1, "messages kept");
    assert.ok(await prisma.auditLog.findFirst({ where: { companyId, actionName: "delete_contact_permanently", result: "success" } }));
  });

  it("refuses a contact preview that changed before confirmation", async () => {
    const contact = await prisma.contact.create({ data: { companyId, displayName: "Edited Person", email: "edited@example.test" } });
    const preview = await previewContact(contact.id);
    await request(app).put(`/crm/contacts/${contact.id}`).set(auth(adminToken)).send({ job_title: "Owner" });
    const stale = await deleteContact(contact.id, await confirmBody(preview.body));
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error, "PREVIEW_STALE");
    assert.ok(await prisma.contact.findUnique({ where: { id: contact.id } }));
  });

  it("replays the first answer for a repeated Idempotency-Key", async () => {
    const contact = await prisma.contact.create({ data: { companyId, displayName: "Idempotent Person", email: "idem@example.test" } });
    const preview = await previewContact(contact.id);
    const body = await confirmBody(preview.body);
    const first = await request(app).post(`/crm/contacts/${contact.id}/permanent-deletion`).set(auth(adminToken)).set("Idempotency-Key", "delete-contact-idem-1").send(body);
    assert.equal(first.status, 200);
    const second = await request(app).post(`/crm/contacts/${contact.id}/permanent-deletion`).set(auth(adminToken)).set("Idempotency-Key", "delete-contact-idem-1").send(body);
    assert.equal(second.status, 200);
    assert.equal(second.headers["idempotent-replay"], "true");
    assert.deepEqual(second.body, first.body);
  });

  it("is refused during the emergency stop", async () => {
    const client = await prisma.client.create({ data: { companyId, displayName: "Safe Mode Ltd" } });
    const preview = await previewClient(client.id);
    await prisma.company.update({ where: { id: companyId }, data: { safeModeSince: new Date() } });
    try {
      const refused = await deleteClient(client.id, await confirmBody(preview.body));
      assert.equal(refused.status, 423);
      assert.ok(await prisma.client.findUnique({ where: { id: client.id } }));
    } finally {
      await prisma.company.update({ where: { id: companyId }, data: { safeModeSince: null } });
    }
  });

  it("is not offered by voice; MCP offers only the guarded contact deletion of CRM records, never client or generic delete", () => {
    const names = MCP_WRITE_TOOLS.map((tool) => tool.name);
    // Issue #74: the only MCP deletion of a CRM record is delete_contact_permanently,
    // previewed, confirmed and with the exact name typed back (tests/mcpSenderReview.test.ts).
    // The owner's PC file deletions (pc_delete_file, pc_delete_workspace_file) are not
    // CRM deletions: each is previewed as irreversible, confirmed, backed up by the PC
    // and approved again on the PC (tests/mcpDevices.test.ts).
    assert.deepEqual(names.filter((name) => /delete/.test(name)).sort(), ["delete_contact_permanently", "pc_delete_file", "pc_delete_workspace_file"]);
    for (const name of ["pc_delete_file", "pc_delete_workspace_file"]) {
      const pcDeletion = MCP_WRITE_TOOLS.find((entry) => entry.name === name)!;
      assert.equal(pcDeletion.kind, "reviewed", name);
      assert.equal(pcDeletion.reviewReason, "irreversible", name);
      assert.equal(pcDeletion.contract.actionName, "operate_pc", name);
      assert.ok(pcDeletion.limitations?.some((line) => /backup copy/.test(line)), `${name} states the PC's backup`);
    }
    assert.ok(!names.some((name) => /delete_client|^delete$|delete_record/.test(name)), "no client or generic deletion");
    const tool = MCP_WRITE_TOOLS.find((entry) => entry.name === "delete_contact_permanently")!;
    assert.equal(tool.kind, "reviewed");
    assert.ok(tool.typedConfirmation);
    assert.ok(names.includes("archive_client") && names.includes("archive_contact"));
  });
});
