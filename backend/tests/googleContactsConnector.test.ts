import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import request from "supertest";
import { GOOGLE_CONTACTS_READONLY_SCOPE } from "../src/connectors/googleContactsAdapter.js";
import { prisma } from "../src/db.js";
import { createServer } from "../src/server.js";
import { resetDb, seedCompanyAndAdmin } from "./setup.js";

const app = createServer();
const originalFetch = globalThis.fetch;
const originalEnv = {
  clientId: process.env.GOOGLE_CONTACTS_OAUTH_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CONTACTS_OAUTH_CLIENT_SECRET,
  redirectUri: process.env.GOOGLE_CONTACTS_OAUTH_REDIRECT_URI,
  encryptionKey: process.env.CONNECTOR_ENCRYPTION_KEY,
  frontendUrl: process.env.FRONTEND_URL,
};

function requestUrl(input: string | URL | Request) {
  return new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
}

function person(resourceName: string, name: string, email: string, phone = "+44 7700 900123") {
  return {
    resourceName,
    etag: `etag-${resourceName}`,
    names: [{ displayName: name, metadata: { primary: true } }],
    emailAddresses: [{ value: email, metadata: { primary: true } }],
    phoneNumbers: [{ value: phone, metadata: { primary: true } }],
    organizations: [{ name: "Example Ltd", title: "Director", department: "Operations", metadata: { primary: true } }],
  };
}

describe("Google Contacts read-only connector", () => {
  let token: string;
  let sourceId: string;
  let oauthState: string;
  let importedContactId: string;

  before(async () => {
    process.env.GOOGLE_CONTACTS_OAUTH_CLIENT_ID = "contacts-client.apps.googleusercontent.com";
    process.env.GOOGLE_CONTACTS_OAUTH_CLIENT_SECRET = "contacts-client-secret";
    process.env.GOOGLE_CONTACTS_OAUTH_REDIRECT_URI = "http://localhost:4000/connectors/google-contacts/oauth/callback";
    process.env.CONNECTOR_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
    process.env.FRONTEND_URL = "http://localhost:5173";
    await resetDb();
    await seedCompanyAndAdmin();
    const login = await request(app).post("/auth/login").send({ email: "admin@test.local", password: "Password123!" });
    token = login.body.token;
    const source = await request(app).post("/connectors/sources").set("Authorization", `Bearer ${token}`).send({
      connector_key: "google_contacts", display_name: "Company contacts", configured_scopes: ["read:contacts"],
    });
    assert.equal(source.status, 201);
    sourceId = source.body.id;
  });

  afterEach(() => { globalThis.fetch = originalFetch; });

  after(async () => {
    await resetDb();
    await prisma.$disconnect();
    for (const [name, value] of Object.entries({
      GOOGLE_CONTACTS_OAUTH_CLIENT_ID: originalEnv.clientId,
      GOOGLE_CONTACTS_OAUTH_CLIENT_SECRET: originalEnv.clientSecret,
      GOOGLE_CONTACTS_OAUTH_REDIRECT_URI: originalEnv.redirectUri,
      CONNECTOR_ENCRYPTION_KEY: originalEnv.encryptionKey,
      FRONTEND_URL: originalEnv.frontendUrl,
    })) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });

  it("requests exactly contacts.readonly with a hashed OAuth state", async () => {
    const response = await request(app).post(`/connectors/sources/${sourceId}/oauth/start`)
      .set("Authorization", `Bearer ${token}`).send({});
    assert.equal(response.status, 200);
    const url = new URL(response.body.authorizationUrl);
    oauthState = url.searchParams.get("state")!;
    assert.equal(url.searchParams.get("scope"), GOOGLE_CONTACTS_READONLY_SCOPE);
    assert.equal(url.searchParams.get("access_type"), "offline");
    const stored = await prisma.connectorOAuthState.findFirstOrThrow({ where: { sourceId } });
    assert.notEqual(stored.stateHash, oauthState);
    assert.equal(stored.stateHash.length, 64);
  });

  it("exchanges OAuth code and stores encrypted tokens", async () => {
    globalThis.fetch = async (input) => {
      assert.equal(requestUrl(input).toString(), "https://oauth2.googleapis.com/token");
      return Response.json({
        access_token: "contacts-access", refresh_token: "contacts-refresh", expires_in: 3600,
        scope: GOOGLE_CONTACTS_READONLY_SCOPE, token_type: "Bearer",
      });
    };
    const response = await request(app).get("/connectors/google-contacts/oauth/callback")
      .query({ state: oauthState, code: "contacts-code" });
    assert.equal(response.status, 303);
    assert.ok(response.headers.location.includes("google_contacts=connected"));
    const credential = await prisma.connectorCredential.findUniqueOrThrow({ where: { sourceId } });
    assert.equal(credential.provider, "google_contacts");
    assert.ok(!JSON.stringify(credential).includes("contacts-access"));
    assert.ok(!JSON.stringify(credential).includes("contacts-refresh"));
  });

  it("requires confirmation before enabling", async () => {
    const preview = await request(app).post(`/connectors/sources/${sourceId}/enable`)
      .set("Authorization", `Bearer ${token}`).send({ confirmed: false });
    assert.equal(preview.status, 409);
    const enabled = await request(app).post(`/connectors/sources/${sourceId}/enable`)
      .set("Authorization", `Bearer ${token}`).send({ confirmed: true });
    assert.equal(enabled.status, 200);
    assert.equal(enabled.body.isEnabled, true);
  });

  it("stages a full contact sync without creating CRM contacts", async () => {
    globalThis.fetch = async (input, init) => {
      const url = requestUrl(input);
      assert.equal(url.pathname, "/v1/people/me/connections");
      assert.equal(url.searchParams.get("personFields"), "names,emailAddresses,phoneNumbers,organizations,metadata");
      assert.equal(url.searchParams.get("sources"), "READ_SOURCE_TYPE_CONTACT");
      assert.equal(url.searchParams.get("requestSyncToken"), "true");
      assert.equal(url.searchParams.has("syncToken"), false);
      assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer contacts-access");
      return Response.json({ connections: [person("people/contact-1", "Alice Adams", "ALICE@example.com")], nextSyncToken: "sync-1", totalItems: 1 });
    };
    const response = await request(app).post(`/connectors/sources/${sourceId}/sync`)
      .set("Authorization", `Bearer ${token}`).send({});
    assert.equal(response.status, 200);
    assert.equal(response.body.mode, "full");
    assert.equal(response.body.upsertedCount, 1);
    assert.equal(response.body.cursorAdvanced, true);
    assert.equal(await prisma.contact.count(), 0);
    const external = await prisma.externalContact.findFirstOrThrow({ where: { connectorSourceId: sourceId } });
    assert.equal(external.email, "alice@example.com");
    assert.equal(external.organisation, "Example Ltd");
    const source = await prisma.connectorSource.findUniqueOrThrow({ where: { id: sourceId } });
    assert.equal(source.syncCursor, "sync-1");
  });

  it("falls back to full sync when Google reports EXPIRED_SYNC_TOKEN", async () => {
    let calls = 0;
    globalThis.fetch = async (input) => {
      const url = requestUrl(input);
      calls += 1;
      if (calls === 1) {
        assert.equal(url.searchParams.get("syncToken"), "sync-1");
        return Response.json({ error: { details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "EXPIRED_SYNC_TOKEN" }] } }, { status: 400 });
      }
      assert.equal(url.searchParams.has("syncToken"), false);
      return Response.json({ connections: [person("people/contact-2", "Bob Brown", "bob@example.com", "+44 7700 900456")], nextSyncToken: "sync-2", totalItems: 1 });
    };
    const response = await request(app).post(`/connectors/sources/${sourceId}/sync`)
      .set("Authorization", `Bearer ${token}`).send({});
    assert.equal(response.status, 200);
    assert.equal(response.body.mode, "full");
    assert.equal(response.body.fallbackFromExpiredSyncToken, true);
    assert.equal(calls, 2);
  });

  it("requires confirmation and imports exactly one reviewed contact", async () => {
    const external = await prisma.externalContact.findFirstOrThrow({ where: { connectorSourceId: sourceId, externalResourceName: "people/contact-2" } });
    const preview = await request(app).post(`/connectors/sources/${sourceId}/external-contacts/${external.id}/import`)
      .set("Authorization", `Bearer ${token}`).send({ confirmed: false });
    assert.equal(preview.status, 409);
    assert.equal(preview.body.error, "CONFIRMATION_REQUIRED");
    assert.equal(await prisma.contact.count(), 0);
    const imported = await request(app).post(`/connectors/sources/${sourceId}/external-contacts/${external.id}/import`)
      .set("Authorization", `Bearer ${token}`).send({ confirmed: true });
    assert.equal(imported.status, 201);
    assert.equal(imported.body.displayName, "Bob Brown");
    assert.equal(imported.body.source, "google_contacts");
    importedContactId = imported.body.id;
    const duplicate = await request(app).post(`/connectors/sources/${sourceId}/external-contacts/${external.id}/import`)
      .set("Authorization", `Bearer ${token}`).send({ confirmed: true });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error, "CONTACT_ALREADY_IMPORTED");
  });

  it("provider deletion archives staging but never deletes imported CRM contact", async () => {
    globalThis.fetch = async (input) => {
      const url = requestUrl(input);
      assert.equal(url.searchParams.get("syncToken"), "sync-2");
      return Response.json({
        connections: [{ resourceName: "people/contact-2", etag: "deleted-etag", metadata: { deleted: true } }],
        nextSyncToken: "sync-3",
      });
    };
    const response = await request(app).post(`/connectors/sources/${sourceId}/sync`)
      .set("Authorization", `Bearer ${token}`).send({});
    assert.equal(response.status, 200);
    assert.equal(response.body.deletedCount, 1);
    const external = await prisma.externalContact.findFirstOrThrow({ where: { externalResourceName: "people/contact-2" } });
    assert.equal(external.isDeleted, true);
    const crmContact = await prisma.contact.findUnique({ where: { id: importedContactId } });
    assert.ok(crmContact);
    assert.equal(crmContact.isActive, true);
  });

  it("disconnects only after confirmation and retains contact records", async () => {
    const preview = await request(app).post(`/connectors/sources/${sourceId}/disconnect`)
      .set("Authorization", `Bearer ${token}`).send({ confirmed: false });
    assert.equal(preview.status, 409);
    assert.equal(preview.body.preview.willKeepStagedAndImportedContacts, true);
    globalThis.fetch = async (input, init) => {
      assert.equal(requestUrl(input).toString(), "https://oauth2.googleapis.com/revoke");
      assert.equal(new URLSearchParams(String(init?.body)).get("token"), "contacts-refresh");
      return new Response(null, { status: 200 });
    };
    const response = await request(app).post(`/connectors/sources/${sourceId}/disconnect`)
      .set("Authorization", `Bearer ${token}`).send({ confirmed: true });
    assert.equal(response.status, 200);
    assert.equal(response.body.providerGrantRevoked, true);
    assert.equal(await prisma.connectorCredential.count({ where: { sourceId } }), 0);
    assert.ok(await prisma.contact.findUnique({ where: { id: importedContactId } }));
    assert.ok((await prisma.externalContact.count({ where: { connectorSourceId: sourceId } })) >= 2);
  });
});
