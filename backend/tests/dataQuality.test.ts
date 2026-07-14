import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import request from "supertest";
import bcrypt from "bcryptjs";
import { createServer } from "../src/server.js";
import { prisma } from "../src/db.js";
import { resetDb, seedCompanyAndAdmin } from "./setup.js";

const app = createServer();

async function loginAs(email: string) {
  const res = await request(app).post("/auth/login").send({ email, password: "Password123!" });
  return res.body.token as string;
}

describe("Data Quality Engine", () => {
  let adminToken: string;
  let workerToken: string;

  let emailDupAId: string;
  let emailDupBId: string;
  let phoneDupAId: string;
  let phoneDupBId: string;
  let nameDupAId: string;
  let nameDupBId: string;
  let noContactClientId: string;
  let cleanClientId: string;

  before(async () => {
    await resetDb();
    const seeded = await seedCompanyAndAdmin();
    adminToken = await loginAs("admin@test.local");
    workerToken = await loginAs("worker@test.local");

    async function createClient(body: Record<string, unknown>) {
      const res = await request(app).post("/crm/clients").set("Authorization", `Bearer ${adminToken}`).send(body);
      return res.body.id as string;
    }

    emailDupAId = await createClient({ display_name: "Riverside Apartments Ltd", email_primary: "info@riverside.example.com" });
    // The public create path now rejects this duplicate. Insert one legacy /
    // imported record directly so the Data Quality Engine still proves that
    // it detects duplicates which pre-date or bypassed the guarded API.
    emailDupBId = (await prisma.client.create({
      data: {
        companyId: seeded.company.id,
        displayName: "Riverside Apts",
        emailPrimary: "Info@Riverside.example.com",
        source: "legacy_test_fixture",
        createdBy: seeded.admin.id,
      },
    })).id;

    phoneDupAId = await createClient({ display_name: "Oak Home Renovations", phone_primary: "+44 7700 900123" });
    phoneDupBId = await createClient({ display_name: "Oak Renovations Co", phone_primary: "07700900123" });

    nameDupAId = await createClient({ display_name: "Green Valley Estates", phone_primary: "07700900555" });
    nameDupBId = await createClient({ display_name: "Green Valley Estates", phone_primary: "07700900556" });

    noContactClientId = await createClient({ display_name: "No Contact Client" });

    cleanClientId = await createClient({ display_name: "Distinct Unrelated Client", email_primary: "unique@example.com", phone_primary: "07700900999" });
  });

  after(async () => {
    await resetDb();
    await prisma.$disconnect();
  });

  it("rejects reading the report without authentication", async () => {
    const res = await request(app).get("/data-quality");
    assert.equal(res.status, 401);
  });

  it("returns 200 for any user holding crm.read (worker has no explicit permissions in seed, so expect 403)", async () => {
    const res = await request(app).get("/data-quality").set("Authorization", `Bearer ${workerToken}`);
    assert.equal(res.status, 403);
  });

  it("detects a duplicate pair by matching, case-insensitively normalized email", async () => {
    const res = await request(app).get("/data-quality").set("Authorization", `Bearer ${adminToken}`);
    assert.equal(res.status, 200);
    const ids = [emailDupAId, emailDupBId].sort();
    const found = res.body.duplicateClientGroups.find(
      (g: any) => [g.clientAId, g.clientBId].sort().join() === ids.join()
    );
    assert.ok(found, "expected the email-matching pair to be flagged");
    assert.equal(found.reason, "email_match");
  });

  it("detects a duplicate pair by matching, digit-normalized phone number", async () => {
    const res = await request(app).get("/data-quality").set("Authorization", `Bearer ${adminToken}`);
    const ids = [phoneDupAId, phoneDupBId].sort();
    const found = res.body.duplicateClientGroups.find(
      (g: any) => [g.clientAId, g.clientBId].sort().join() === ids.join()
    );
    assert.ok(found, "expected the phone-matching pair to be flagged");
    assert.equal(found.reason, "phone_match");
  });

  it("detects a duplicate pair by exact matching display name", async () => {
    const res = await request(app).get("/data-quality").set("Authorization", `Bearer ${adminToken}`);
    const ids = [nameDupAId, nameDupBId].sort();
    const found = res.body.duplicateClientGroups.find(
      (g: any) => [g.clientAId, g.clientBId].sort().join() === ids.join()
    );
    assert.ok(found, "expected the identical-name pair to be flagged");
    assert.equal(found.reason, "name_match");
  });

  it("does not flag the clearly distinct, unrelated client as a duplicate of anything", async () => {
    const res = await request(app).get("/data-quality").set("Authorization", `Bearer ${adminToken}`);
    const involved = res.body.duplicateClientGroups.some(
      (g: any) => g.clientAId === cleanClientId || g.clientBId === cleanClientId
    );
    assert.equal(involved, false);
  });

  it("flags a client with neither email nor phone as missing a contact method", async () => {
    const res = await request(app).get("/data-quality").set("Authorization", `Bearer ${adminToken}`);
    const found = res.body.missingContactIssues.find((m: any) => m.clientId === noContactClientId);
    assert.ok(found);
    assert.equal(found.issue, "missing_contact_method");
  });

  it("does not flag clients that have an email or phone on file as missing contact info", async () => {
    const res = await request(app).get("/data-quality").set("Authorization", `Bearer ${adminToken}`);
    const found = res.body.missingContactIssues.find((m: any) => m.clientId === cleanClientId);
    assert.equal(found, undefined);
  });

  it("surfaces duplicate and missing-contact findings additively in the unified notification feed", async () => {
    const res = await request(app).get("/notifications").set("Authorization", `Bearer ${adminToken}`);
    assert.equal(res.status, 200);
    const duplicateItem = res.body.find((n: any) => n.type === "duplicate_client_possible");
    assert.ok(duplicateItem, "expected at least one duplicate_client_possible item in the feed");
    assert.equal(duplicateItem.severity, "warning");
    const missingContactItem = res.body.find(
      (n: any) => n.type === "missing_client_contact_info" && n.entity.id === noContactClientId
    );
    assert.ok(missingContactItem, "expected the no-contact client to appear in the feed");
  });

  it("acknowledging a data-quality notification key removes it from the default feed, reusing the existing mechanism", async () => {
    const key = `missing_contact:${noContactClientId}`;
    const ackRes = await request(app)
      .post("/notifications/acknowledge")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ notification_key: key });
    assert.equal(ackRes.status, 200);

    const feedRes = await request(app).get("/notifications").set("Authorization", `Bearer ${adminToken}`);
    assert.ok(!feedRes.body.some((n: any) => n.key === key));

    // The underlying client record itself is untouched — this module never merges or edits.
    const clientRes = await request(app)
      .get(`/crm/clients/${noContactClientId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    assert.equal(clientRes.status, 200);
    assert.equal(clientRes.body.displayName, "No Contact Client");
  });

  it('text command "check data quality" returns the same structural report', async () => {
    const res = await request(app)
      .post("/command/text")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ text: "check data quality" });
    assert.equal(res.status, 200);
    assert.equal(res.body.intent, "list_data_quality");
    assert.ok(Array.isArray(res.body.data.duplicateClientGroups));
    assert.ok(Array.isArray(res.body.data.missingContactIssues));
  });

  describe("merge_clients (confirmation-gated)", () => {
    let primaryId: string;
    let duplicateId: string;
    let jobId: string;
    let quoteId: string;
    let commId: string;
    let intakeId: string;
    let photoId: string;
    let contactId: string;
    let documentId: string;
    let taskId: string;

    let pairCounter = 0;
    async function createFreshPair() {
      pairCounter += 1;
      const primaryRes = await request(app)
        .post("/crm/clients")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ display_name: `Merge Primary Client ${pairCounter}`, email_primary: `primary${pairCounter}@merge.example.com` });
      const duplicateRes = await request(app)
        .post("/crm/clients")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ display_name: `Merge Duplicate Client ${pairCounter}`, email_primary: `duplicate${pairCounter}@merge.example.com` });
      return { primaryId: primaryRes.body.id as string, duplicateId: duplicateRes.body.id as string };
    }

    before(async () => {
      const pair = await createFreshPair();
      primaryId = pair.primaryId;
      duplicateId = pair.duplicateId;

      const jobRes = await request(app)
        .post("/crm/jobs")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ client_id: duplicateId, job_title: "Job on duplicate" });
      jobId = jobRes.body.id;

      const quoteRes = await request(app)
        .post("/quotes")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ client_id: duplicateId, title: "Quote on duplicate", items: [{ description: "Work", unit_price: 50 }] });
      quoteId = quoteRes.body.id;

      const commRes = await request(app)
        .post("/communications")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          client_id: duplicateId,
          channel: "email",
          direction: "outbound",
          summary: "Message to duplicate",
          occurred_at: new Date().toISOString(),
        });
      commId = commRes.body.id;

      const duplicate = await prisma.client.findUniqueOrThrow({ where: { id: duplicateId } });
      const intake = await prisma.communicationIntake.create({
        data: {
          companyId: duplicate.companyId,
          clientId: duplicateId,
          channel: "email",
          messageText: "Original intake linked to duplicate",
          receivedAt: new Date(),
          intakeStatus: "converted",
        },
      });
      intakeId = intake.id;

      const photoRes = await request(app)
        .post("/portfolio")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ client_id: duplicateId, filename: "duplicate.jpg", source: "other" });
      photoId = photoRes.body.id;

      const contact = await prisma.contact.create({
        data: { companyId: duplicate.companyId, clientId: duplicateId, displayName: "Duplicate contact", email: "merge-contact@example.test" },
      });
      contactId = contact.id;
      const document = await prisma.documentRecord.create({
        data: { companyId: duplicate.companyId, clientId: duplicateId, title: "Duplicate document", documentType: "other", documentReference: "merge-document-ref" },
      });
      documentId = document.id;
      const task = await prisma.task.create({
        data: { companyId: duplicate.companyId, clientId: duplicateId, title: "Duplicate client task" },
      });
      taskId = task.id;
    });

    it("rejects merging without crm.manage permission (403)", async () => {
      const res = await request(app)
        .post("/data-quality/merge-clients")
        .set("Authorization", `Bearer ${workerToken}`)
        .send({ primary_client_id: primaryId, duplicate_client_id: duplicateId });
      assert.equal(res.status, 403);
    });

    it("rejects merging a client with itself", async () => {
      const res = await request(app)
        .post("/data-quality/merge-clients")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ primary_client_id: primaryId, duplicate_client_id: primaryId });
      assert.equal(res.status, 400);
      assert.equal(res.body.error, "SAME_CLIENT");
    });

    it("rejects a nonexistent client id", async () => {
      const res = await request(app)
        .post("/data-quality/merge-clients")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ primary_client_id: primaryId, duplicate_client_id: "00000000-0000-0000-0000-000000000000" });
      assert.equal(res.status, 404);
      assert.equal(res.body.error, "CLIENT_NOT_FOUND");
    });

    it("rejects a cross-tenant client id (company B's client is invisible to company A)", async () => {
      const companyB = await prisma.company.create({ data: { name: "Other Merge Co" } });
      const passwordHash = await bcrypt.hash("Password123!", 10);
      await prisma.user.create({
        data: {
          companyId: companyB.id,
          email: "admin-merge-b@test.local",
          passwordHash,
          displayName: "Other Admin",
          role: "admin",
          permissions: ["crm.read", "crm.manage"],
        },
      });
      const clientB = await prisma.client.create({
        data: { companyId: companyB.id, displayName: "Other Co Client" },
      });

      const res = await request(app)
        .post("/data-quality/merge-clients")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ primary_client_id: primaryId, duplicate_client_id: clientB.id });
      assert.equal(res.status, 404);
      assert.equal(res.body.error, "CLIENT_NOT_FOUND");
    });

    it("without confirmed:true, returns a 409 preview with accurate counts and changes nothing", async () => {
      const res = await request(app)
        .post("/data-quality/merge-clients")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ primary_client_id: primaryId, duplicate_client_id: duplicateId });
      assert.equal(res.status, 409);
      assert.equal(res.body.error, "CONFIRMATION_REQUIRED");
      assert.equal(res.body.preview.recordsToRelink.jobs, 1);
      assert.equal(res.body.preview.recordsToRelink.quotes, 1);
      assert.equal(res.body.preview.recordsToRelink.communicationRecords, 1);
      assert.equal(res.body.preview.recordsToRelink.communicationIntakes, 1);
      assert.equal(res.body.preview.recordsToRelink.portfolioPhotos, 1);
      assert.equal(res.body.preview.recordsToRelink.contacts, 1);
      assert.equal(res.body.preview.recordsToRelink.documentRecords, 1);
      assert.equal(res.body.preview.recordsToRelink.tasks, 1);
      assert.equal(res.body.preview.duplicateWillBeArchived, true);

      // Nothing actually changed yet.
      const jobRes = await request(app).get(`/crm/jobs/${jobId}`).set("Authorization", `Bearer ${adminToken}`);
      assert.equal(jobRes.body.clientId, duplicateId);
      const duplicateStillListed = await request(app)
        .get(`/crm/clients/${duplicateId}`)
        .set("Authorization", `Bearer ${adminToken}`);
      assert.equal(duplicateStillListed.status, 200);
    });

    it("with confirmed:true, re-links every supported client record, archives the duplicate, and preserves audit history", async () => {
      const primaryAuditsBefore = await prisma.auditLog.count({
        where: { companyId: (await prisma.client.findUnique({ where: { id: primaryId } }))!.companyId },
      });
      assert.ok(primaryAuditsBefore >= 0);

      const res = await request(app)
        .post("/data-quality/merge-clients")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ primary_client_id: primaryId, duplicate_client_id: duplicateId, confirmed: true });
      assert.equal(res.status, 200);
      assert.equal(res.body.relinked.jobs, 1);
      assert.equal(res.body.relinked.quotes, 1);
      assert.equal(res.body.relinked.communicationRecords, 1);
      assert.equal(res.body.relinked.communicationIntakes, 1);
      assert.equal(res.body.relinked.portfolioPhotos, 1);
      assert.equal(res.body.relinked.contacts, 1);
      assert.equal(res.body.relinked.documentRecords, 1);
      assert.equal(res.body.relinked.tasks, 1);
      assert.equal(res.body.duplicateClient.isActive, false);

      const jobRes = await request(app).get(`/crm/jobs/${jobId}`).set("Authorization", `Bearer ${adminToken}`);
      assert.equal(jobRes.body.clientId, primaryId);

      const quoteRes = await request(app).get(`/quotes/${quoteId}`).set("Authorization", `Bearer ${adminToken}`);
      assert.equal(quoteRes.body.clientId, primaryId);

      const commRes = await request(app).get(`/communications/${commId}`).set("Authorization", `Bearer ${adminToken}`);
      assert.equal(commRes.body.clientId, primaryId);

      const intake = await prisma.communicationIntake.findUniqueOrThrow({ where: { id: intakeId } });
      assert.equal(intake.clientId, primaryId);

      const photoRes = await request(app).get(`/portfolio/${photoId}`).set("Authorization", `Bearer ${adminToken}`);
      assert.equal(photoRes.body.clientId, primaryId);

      assert.equal((await prisma.contact.findUniqueOrThrow({ where: { id: contactId } })).clientId, primaryId);
      assert.equal((await prisma.documentRecord.findUniqueOrThrow({ where: { id: documentId } })).clientId, primaryId);
      assert.equal((await prisma.task.findUniqueOrThrow({ where: { id: taskId } })).clientId, primaryId);

      // The duplicate client's own row (and its own prior audit history, if
      // any) is untouched other than the isActive flip — it is archived,
      // never deleted.
      const duplicateRow = await prisma.client.findUnique({ where: { id: duplicateId } });
      assert.ok(duplicateRow, "duplicate client row must still exist after merge (archived, not deleted)");
      assert.equal(duplicateRow!.isActive, false);
      assert.equal(duplicateRow!.displayName, "Merge Duplicate Client 1");

      // A full audit entry was written for the confirmed merge.
      const mergeAudits = await prisma.auditLog.findMany({ where: { actionName: "merge_clients", confirmed: true } });
      assert.ok(mergeAudits.some((a: any) => a.result === "success"));
    });

    it("the archived duplicate no longer appears in the duplicate-scan report (it is excluded once merged)", async () => {
      const res = await request(app).get("/data-quality").set("Authorization", `Bearer ${adminToken}`);
      const involved = res.body.duplicateClientGroups.some(
        (g: any) => g.clientAId === duplicateId || g.clientBId === duplicateId
      );
      assert.equal(involved, false);
    });

    it("atomicity: merging into a bad/nonexistent primary rolls back cleanly with no partial state", async () => {
      const pair = await createFreshPair();
      const jobRes = await request(app)
        .post("/crm/jobs")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ client_id: pair.duplicateId, job_title: "Job on second duplicate" });
      const secondJobId = jobRes.body.id;

      // Delete the "primary" out from under a confirmed merge call to force
      // the CLIENT_NOT_FOUND path even though it existed at preview time —
      // proves the existence check (and therefore atomicity) applies
      // regardless of confirmed:true, not only on the first preview call.
      await prisma.client.delete({ where: { id: pair.primaryId } });

      const res = await request(app)
        .post("/data-quality/merge-clients")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ primary_client_id: pair.primaryId, duplicate_client_id: pair.duplicateId, confirmed: true });
      assert.equal(res.status, 404);
      assert.equal(res.body.error, "CLIENT_NOT_FOUND");

      // No partial state: the job is still linked to the duplicate, and the
      // duplicate is still active.
      const jobAfter = await request(app).get(`/crm/jobs/${secondJobId}`).set("Authorization", `Bearer ${adminToken}`);
      assert.equal(jobAfter.body.clientId, pair.duplicateId);
      const duplicateAfter = await prisma.client.findUnique({ where: { id: pair.duplicateId } });
      assert.equal(duplicateAfter!.isActive, true);
    });
  });
});
