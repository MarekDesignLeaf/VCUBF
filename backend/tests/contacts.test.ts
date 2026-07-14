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

describe("Contact Directory", () => {
  let adminToken: string;
  let workerToken: string;
  let companyId: string;
  let clientId: string;
  let contactId: string;

  before(async () => {
    await resetDb();
    const seeded = await seedCompanyAndAdmin();
    companyId = seeded.company.id;
    adminToken = await loginAs("admin@test.local");
    workerToken = await loginAs("worker@test.local");
    const client = await prisma.client.create({ data: { companyId, displayName: "Contact Client" } });
    clientId = client.id;
  });

  after(async () => {
    await resetDb();
    await prisma.$disconnect();
  });

  it("enforces crm permissions", async () => {
    const list = await request(app).get("/crm/contacts").set("Authorization", `Bearer ${workerToken}`);
    assert.equal(list.status, 403);
    const create = await request(app)
      .post("/crm/contacts")
      .set("Authorization", `Bearer ${workerToken}`)
      .send({ display_name: "No Access", email: "no@example.test" });
    assert.equal(create.status, 403);
  });

  it("requires a valid contact route and traceable communication source", async () => {
    const noRoute = await request(app)
      .post("/crm/contacts")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ display_name: "No Route" });
    assert.equal(noRoute.status, 400);
    assert.equal(noRoute.body.error, "VALIDATION_FAILED");

    const noReference = await request(app)
      .post("/crm/contacts")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ display_name: "From Email", email: "from@example.test", source: "communication" });
    assert.equal(noReference.status, 400);
  });

  it("creates an independent client-linked contact and audit evidence", async () => {
    const res = await request(app)
      .post("/crm/contacts")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        client_id: clientId,
        display_name: "Jane Contact",
        job_title: "Facilities Manager",
        email: "Jane.Contact@Example.test",
        phone: "+44 7700 900123",
        preferred_channel: "email",
        preferred_language: "en",
        source: "communication",
        source_reference: "email-message-42",
      });
    assert.equal(res.status, 201);
    assert.equal(res.body.displayName, "Jane Contact");
    assert.equal(res.body.client.id, clientId);
    assert.equal(res.body.sourceReference, "email-message-42");
    contactId = res.body.id;

    const audit = await prisma.auditLog.findFirst({ where: { actionName: "create_contact", result: "success" } });
    assert.equal((audit?.dataAfter as any)?.id, contactId);
  });

  it("detects duplicate email and normalized UK phone evidence", async () => {
    const duplicateEmail = await request(app)
      .post("/crm/contacts")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ display_name: "Duplicate Email", email: "jane.contact@example.test" });
    assert.equal(duplicateEmail.status, 409);
    assert.equal(duplicateEmail.body.error, "DUPLICATE_CONTACT_POSSIBLE");
    assert.equal(duplicateEmail.body.possibleDuplicate.id, contactId);

    const duplicatePhone = await request(app)
      .post("/crm/contacts")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ display_name: "Duplicate Phone", phone: "07700 900123" });
    assert.equal(duplicatePhone.status, 409);
  });

  it("lists, searches, updates and archives contacts", async () => {
    const list = await request(app)
      .get(`/crm/contacts?client_id=${clientId}&search=Jane&active_only=true`)
      .set("Authorization", `Bearer ${adminToken}`);
    assert.equal(list.status, 200);
    assert.equal(list.body.length, 1);
    assert.equal(list.body[0].id, contactId);

    const update = await request(app)
      .put(`/crm/contacts/${contactId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ department: "Estates" });
    assert.equal(update.status, 200);
    assert.equal(update.body.department, "Estates");

    const preview = await request(app)
      .delete(`/crm/contacts/${contactId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ confirmed: false });
    assert.equal(preview.status, 409);
    assert.equal(preview.body.error, "CONFIRMATION_REQUIRED");
    assert.equal((await prisma.contact.findUniqueOrThrow({ where: { id: contactId } })).isActive, true);

    const archived = await request(app)
      .delete(`/crm/contacts/${contactId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ confirmed: true });
    assert.equal(archived.status, 200);
    assert.equal((await prisma.contact.findUniqueOrThrow({ where: { id: contactId } })).isActive, false);
  });

  it("keeps contacts and client links isolated between tenants", async () => {
    const companyB = await prisma.company.create({ data: { name: "Other Contact Co" } });
    const passwordHash = await bcrypt.hash("Password123!", 10);
    await prisma.user.create({
      data: {
        companyId: companyB.id,
        email: "contacts-b@test.local",
        passwordHash,
        displayName: "Other Admin",
        role: "admin",
        permissions: ["crm.read", "crm.manage"],
      },
    });
    const tokenB = await loginAs("contacts-b@test.local");
    const get = await request(app).get(`/crm/contacts/${contactId}`).set("Authorization", `Bearer ${tokenB}`);
    assert.equal(get.status, 404);
    const foreignLink = await request(app)
      .post("/crm/contacts")
      .set("Authorization", `Bearer ${tokenB}`)
      .send({ display_name: "Foreign", email: "foreign@example.test", client_id: clientId });
    assert.equal(foreignLink.status, 404);
    assert.equal(foreignLink.body.error, "CLIENT_NOT_FOUND");
  });
});
