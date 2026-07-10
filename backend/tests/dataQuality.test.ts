import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import request from "supertest";
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
    await seedCompanyAndAdmin();
    adminToken = await loginAs("admin@test.local");
    workerToken = await loginAs("worker@test.local");

    async function createClient(body: Record<string, unknown>) {
      const res = await request(app).post("/crm/clients").set("Authorization", `Bearer ${adminToken}`).send(body);
      return res.body.id as string;
    }

    emailDupAId = await createClient({ display_name: "Riverside Apartments Ltd", email_primary: "info@riverside.example.com" });
    emailDupBId = await createClient({ display_name: "Riverside Apts", email_primary: "Info@Riverside.example.com" });

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
});
