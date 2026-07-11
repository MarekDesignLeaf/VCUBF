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

describe("Connector Engine registry and source lifecycle", () => {
  let adminToken: string;
  let workerToken: string;
  let sourceId: string;
  let companyId: string;

  before(async () => {
    await resetDb();
    const seeded = await seedCompanyAndAdmin();
    companyId = seeded.company.id;
    adminToken = await loginAs("admin@test.local");
    workerToken = await loginAs("worker@test.local");
  });

  after(async () => {
    await resetDb();
    await prisma.$disconnect();
  });

  it("enforces connector-specific read and manage permissions", async () => {
    const definitions = await request(app).get("/connectors/definitions").set("Authorization", `Bearer ${workerToken}`);
    assert.equal(definitions.status, 403);
    const create = await request(app)
      .post("/connectors/sources")
      .set("Authorization", `Bearer ${workerToken}`)
      .send({ connector_key: "gmail", display_name: "No access" });
    assert.equal(create.status, 403);
  });

  it("declares every master-document connector contract field and reports adapters honestly", async () => {
    const res = await request(app).get("/connectors/definitions").set("Authorization", `Bearer ${adminToken}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.map((item: any) => item.key), ["gmail", "google_contacts", "google_calendar", "google_drive_photos"]);
    for (const definition of res.body) {
      assert.ok(definition.serviceName);
      assert.ok(definition.serviceType);
      assert.ok(Array.isArray(definition.canRead) && definition.canRead.length > 0);
      assert.ok(Array.isArray(definition.canWrite));
      if (["gmail", "google_contacts", "google_calendar"].includes(definition.key)) assert.deepEqual(definition.canWrite, []);
      else assert.ok(definition.canWrite.length > 0);
      assert.ok(Array.isArray(definition.requiredPermissions) && definition.requiredPermissions.includes("connectors.manage"));
      assert.ok(Array.isArray(definition.returnedDataTypes) && definition.returnedDataTypes.length > 0);
      assert.ok(Array.isArray(definition.supportedActions) && definition.supportedActions.length > 0);
      assert.ok(Array.isArray(definition.possibleErrors) && definition.possibleErrors.length > 0);
      assert.equal(definition.supportsAudit, true);
      assert.equal(typeof definition.supportsRollback, "boolean");
      assert.equal(definition.actionMode, "proposal_and_confirmed_action");
      assert.equal(definition.adapterAvailable, ["gmail", "google_contacts", "google_calendar"].includes(definition.key));
    }
  });

  it("registers a disabled tenant source without exposing its secret-store reference", async () => {
    const res = await request(app)
      .post("/connectors/sources")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        connector_key: "gmail",
        display_name: "Operations inbox",
        configured_scopes: ["read:messages"],
        credential_reference: "env:VCUF_GMAIL_OPERATIONS_SECRET",
      });
    assert.equal(res.status, 201);
    assert.equal(res.body.connectorKey, "gmail");
    assert.equal(res.body.connectionStatus, "setup_required");
    assert.equal(res.body.isEnabled, false);
    assert.equal(res.body.credentialReferenceConfigured, true);
    assert.equal(res.body.credentialReference, undefined);
    sourceId = res.body.id;

    const stored = await prisma.connectorSource.findUniqueOrThrow({ where: { id: sourceId } });
    assert.equal(stored.companyId, companyId);
    assert.equal(stored.credentialReference, "env:VCUF_GMAIL_OPERATIONS_SECRET");

    const audit = await prisma.auditLog.findFirst({
      where: { actionName: "register_connector_source", result: "success" },
      orderBy: { createdAt: "desc" },
    });
    assert.ok(audit);
    const auditJson = JSON.stringify({ input: audit?.inputPayload, after: audit?.dataAfter });
    assert.ok(!auditJson.includes("VCUF_GMAIL_OPERATIONS_SECRET"));
  });

  it("rejects undeclared logical scopes and malformed credential references", async () => {
    const badScope = await request(app)
      .post("/connectors/sources")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ connector_key: "gmail", display_name: "Bad scope", configured_scopes: ["read:everything"] });
    assert.equal(badScope.status, 400);
    assert.equal(badScope.body.error, "UNSUPPORTED_CONNECTOR_SCOPE");

    const rawSecret = await request(app)
      .post("/connectors/sources")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ connector_key: "gmail", display_name: "Raw secret", credential_reference: "plain-password-value" });
    assert.equal(rawSecret.status, 400);
    assert.equal(rawSecret.body.error, "VALIDATION_FAILED");
    const validationAudit = await prisma.auditLog.findFirst({
      where: { actionName: "register_connector_source", errorMessage: "VALIDATION_FAILED" },
      orderBy: { createdAt: "desc" },
    });
    assert.ok(!JSON.stringify(validationAudit?.inputPayload).includes("plain-password-value"));
  });

  it("rejects a duplicate source name within the same connector", async () => {
    const res = await request(app)
      .post("/connectors/sources")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ connector_key: "gmail", display_name: "operations INBOX" });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, "CONNECTOR_SOURCE_ALREADY_EXISTS");
  });

  it("updates only a disabled source and keeps credential references redacted", async () => {
    const res = await request(app)
      .put(`/connectors/sources/${sourceId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        display_name: "Operations mailbox",
        configured_scopes: ["read:messages"],
        credential_reference: "secret-manager:vcuf/gmail/operations",
      });
    assert.equal(res.status, 200);
    assert.equal(res.body.displayName, "Operations mailbox");
    assert.deepEqual(res.body.configuredScopes, ["read:messages"]);
    assert.equal(res.body.credentialReferenceConfigured, true);
    assert.equal(res.body.credentialReference, undefined);
  });

  it("fails closed when Gmail has not been authorized", async () => {
    const res = await request(app)
      .post(`/connectors/sources/${sourceId}/enable`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ confirmed: true });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, "CONNECTOR_AUTHORIZATION_REQUIRED");
    const stored = await prisma.connectorSource.findUniqueOrThrow({ where: { id: sourceId } });
    assert.equal(stored.isEnabled, false);
    const audit = await prisma.auditLog.findFirst({
      where: { actionName: "enable_connector_source", errorMessage: "CONNECTOR_AUTHORIZATION_REQUIRED" },
      orderBy: { createdAt: "desc" },
    });
    assert.ok(audit);
  });

  it("disables a source idempotently and records before/after audit evidence", async () => {
    const res = await request(app)
      .post(`/connectors/sources/${sourceId}/disable`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    assert.equal(res.status, 200);
    assert.equal(res.body.isEnabled, false);
    assert.equal(res.body.connectionStatus, "disabled");
    const audit = await prisma.auditLog.findFirst({
      where: { actionName: "disable_connector_source", result: "success" },
      orderBy: { createdAt: "desc" },
    });
    assert.equal((audit?.dataAfter as any)?.connectionStatus, "disabled");
  });

  it("lists active sources and keeps sources isolated between companies", async () => {
    const list = await request(app).get("/connectors/sources?active_only=true").set("Authorization", `Bearer ${adminToken}`);
    assert.equal(list.status, 200);
    assert.ok(list.body.some((source: any) => source.id === sourceId));
    assert.ok(list.body.every((source: any) => source.credentialReference === undefined));

    const companyB = await prisma.company.create({ data: { name: "Other Connector Co" } });
    const passwordHash = await bcrypt.hash("Password123!", 10);
    await prisma.user.create({
      data: {
        companyId: companyB.id,
        email: "connectors-b@test.local",
        passwordHash,
        displayName: "Connector Admin B",
        role: "admin",
        permissions: ["connectors.read", "connectors.manage"],
      },
    });
    const tokenB = await loginAs("connectors-b@test.local");
    const getForeign = await request(app).get(`/connectors/sources/${sourceId}`).set("Authorization", `Bearer ${tokenB}`);
    assert.equal(getForeign.status, 404);
    const updateForeign = await request(app)
      .put(`/connectors/sources/${sourceId}`)
      .set("Authorization", `Bearer ${tokenB}`)
      .send({ display_name: "Hijacked" });
    assert.equal(updateForeign.status, 404);
  });
});
