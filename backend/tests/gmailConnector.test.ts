import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import request from "supertest";
import { encryptConnectorPayload } from "../src/connectors/connectorCrypto.js";
import { GMAIL_READONLY_SCOPE } from "../src/connectors/gmailAdapter.js";
import { prisma } from "../src/db.js";
import { createServer } from "../src/server.js";
import { resetDb, seedCompanyAndAdmin, TEST_COMPANY_ID } from "./setup.js";

const app = createServer();
const originalFetch = globalThis.fetch;
const originalEnv = {
  clientId: process.env.GMAIL_OAUTH_CLIENT_ID,
  clientSecret: process.env.GMAIL_OAUTH_CLIENT_SECRET,
  redirectUri: process.env.GMAIL_OAUTH_REDIRECT_URI,
  encryptionKey: process.env.CONNECTOR_ENCRYPTION_KEY,
  frontendUrl: process.env.FRONTEND_URL,
};

function requestUrl(input: string | URL | Request) {
  return new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
}

describe("Gmail read-only connector", () => {
  let token: string;
  let sourceId: string;
  let oauthState: string;

  before(async () => {
    process.env.GMAIL_OAUTH_CLIENT_ID = "test-client.apps.googleusercontent.com";
    process.env.GMAIL_OAUTH_CLIENT_SECRET = "test-client-secret";
    process.env.GMAIL_OAUTH_REDIRECT_URI = "http://localhost:4000/connectors/gmail/oauth/callback";
    process.env.CONNECTOR_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    process.env.FRONTEND_URL = "http://localhost:5173";
    await resetDb();
    await seedCompanyAndAdmin();
    const login = await request(app).post("/auth/login").send({ email: "admin@test.local", password: "Password123!" });
    token = login.body.token;
    const source = await request(app)
      .post("/connectors/sources")
      .set("Authorization", `Bearer ${token}`)
      .send({ connector_key: "gmail", display_name: "Read-only inbox", configured_scopes: ["read:messages"] });
    assert.equal(source.status, 201);
    sourceId = source.body.id;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  after(async () => {
    await resetDb();
    await prisma.$disconnect();
    for (const [name, value] of Object.entries({
      GMAIL_OAUTH_CLIENT_ID: originalEnv.clientId,
      GMAIL_OAUTH_CLIENT_SECRET: originalEnv.clientSecret,
      GMAIL_OAUTH_REDIRECT_URI: originalEnv.redirectUri,
      CONNECTOR_ENCRYPTION_KEY: originalEnv.encryptionKey,
      FRONTEND_URL: originalEnv.frontendUrl,
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("creates a hashed, expiring OAuth state and requests only Gmail readonly", async () => {
    const response = await request(app)
      .post(`/connectors/sources/${sourceId}/oauth/start`)
      .set("Authorization", `Bearer ${token}`)
      .send({});
    assert.equal(response.status, 200);
    const authorizationUrl = new URL(response.body.authorizationUrl);
    oauthState = authorizationUrl.searchParams.get("state")!;
    assert.equal(authorizationUrl.origin, "https://accounts.google.com");
    assert.equal(authorizationUrl.pathname, "/o/oauth2/v2/auth");
    assert.equal(authorizationUrl.searchParams.get("scope"), GMAIL_READONLY_SCOPE);
    assert.equal(authorizationUrl.searchParams.get("access_type"), "offline");
    assert.equal(authorizationUrl.searchParams.has("include_granted_scopes"), false);
    assert.equal(authorizationUrl.searchParams.get("prompt"), "consent");
    assert.ok(oauthState.length >= 40);

    const storedState = await prisma.connectorOAuthState.findFirstOrThrow({ where: { sourceId } });
    assert.notEqual(storedState.stateHash, oauthState);
    assert.equal(storedState.stateHash.length, 64);
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { actionName: "start_gmail_oauth", result: "success" },
      orderBy: { createdAt: "desc" },
    });
    assert.ok(!JSON.stringify(audit).includes(oauthState));
  });

  it("rejects an unknown OAuth state without contacting Google", async () => {
    let contacted = false;
    globalThis.fetch = async () => {
      contacted = true;
      return new Response("{}", { status: 500 });
    };
    const response = await request(app).get("/connectors/gmail/oauth/callback").query({
      state: "unknown-state-value-that-is-long-enough",
      code: "should-not-be-used",
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error, "OAUTH_STATE_INVALID");
    assert.equal(contacted, false);
  });

  it("exchanges the code, verifies scope and persists only encrypted tokens", async () => {
    globalThis.fetch = async (input, init) => {
      const url = requestUrl(input);
      assert.equal(url.toString(), "https://oauth2.googleapis.com/token");
      const body = new URLSearchParams(String(init?.body));
      assert.equal(body.get("code"), "one-time-code");
      assert.equal(body.get("grant_type"), "authorization_code");
      return Response.json({
        access_token: "access-token-1",
        refresh_token: "refresh-token-1",
        expires_in: 3600,
        scope: GMAIL_READONLY_SCOPE,
        token_type: "Bearer",
      });
    };

    const response = await request(app)
      .get("/connectors/gmail/oauth/callback")
      .query({ state: oauthState, code: "one-time-code" });
    assert.equal(response.status, 303);
    assert.ok(response.headers.location.includes("/connectors?gmail=connected"));

    const credential = await prisma.connectorCredential.findUniqueOrThrow({ where: { sourceId } });
    const persisted = JSON.stringify(credential);
    assert.ok(!persisted.includes("access-token-1"));
    assert.ok(!persisted.includes("refresh-token-1"));
    assert.equal(credential.provider, "gmail");
    const source = await prisma.connectorSource.findUniqueOrThrow({ where: { id: sourceId } });
    assert.equal(source.connectionStatus, "configured");
    assert.equal(source.isEnabled, false);
    const callbackAudit = await prisma.auditLog.findFirstOrThrow({
      where: { actionName: "complete_gmail_oauth", result: "success" },
    });
    const auditJson = JSON.stringify(callbackAudit);
    assert.ok(!auditJson.includes("one-time-code"));
    assert.ok(!auditJson.includes("access-token-1"));
    assert.ok(!auditJson.includes("refresh-token-1"));
  });

  it("requires enable confirmation after authorization", async () => {
    const preview = await request(app)
      .post(`/connectors/sources/${sourceId}/enable`)
      .set("Authorization", `Bearer ${token}`)
      .send({ confirmed: false });
    assert.equal(preview.status, 409);
    assert.equal(preview.body.error, "CONFIRMATION_REQUIRED");
    const enabled = await request(app)
      .post(`/connectors/sources/${sourceId}/enable`)
      .set("Authorization", `Bearer ${token}`)
      .send({ confirmed: true });
    assert.equal(enabled.status, 200);
    assert.equal(enabled.body.isEnabled, true);
    assert.equal(enabled.body.authorizationConfigured, true);
    assert.equal(enabled.body.credentialReferenceConfigured, false);
  });

  it("imports Gmail messages idempotently with provenance and no message content in audit", async () => {
    const bodyData = Buffer.from("Hello from Gmail", "utf8").toString("base64url");
    globalThis.fetch = async (input, init) => {
      const url = requestUrl(input);
      assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer access-token-1");
      if (url.pathname.endsWith("/messages")) {
        assert.equal(url.searchParams.get("maxResults"), "10");
        assert.equal(url.searchParams.get("q"), "newer_than:7d");
        return Response.json({ messages: [{ id: "message-1", threadId: "thread-1" }], resultSizeEstimate: 1 });
      }
      assert.ok(url.pathname.endsWith("/messages/message-1"));
      assert.equal(url.searchParams.get("format"), "full");
      return Response.json({
        id: "message-1",
        threadId: "thread-1",
        internalDate: "1767225600000",
        payload: {
          mimeType: "text/plain",
          headers: [
            { name: "From", value: "Customer One <customer@example.com>" },
            { name: "Subject", value: "Kitchen quote" },
            { name: "Date", value: "Thu, 1 Jan 2026 10:00:00 +0000" },
          ],
          body: { data: bodyData },
        },
      });
    };

    const first = await request(app)
      .post(`/connectors/sources/${sourceId}/sync`)
      .set("Authorization", `Bearer ${token}`)
      .send({ max_results: 10, query: "newer_than:7d" });
    assert.equal(first.status, 200);
    assert.equal(first.body.importedCount, 1);
    assert.equal(first.body.skippedCount, 0);

    const second = await request(app)
      .post(`/connectors/sources/${sourceId}/sync`)
      .set("Authorization", `Bearer ${token}`)
      .send({ max_results: 10, query: "newer_than:7d" });
    assert.equal(second.status, 200);
    assert.equal(second.body.importedCount, 0);
    assert.equal(second.body.skippedCount, 1);

    const intake = await prisma.communicationIntake.findFirstOrThrow({ where: { connectorSourceId: sourceId } });
    assert.equal(intake.externalMessageId, "message-1");
    assert.equal(intake.externalThreadId, "thread-1");
    assert.equal(intake.senderEmail, "customer@example.com");
    assert.equal(intake.senderName, "Customer One");
    assert.equal(intake.messageText, "Subject: Kitchen quote\n\nHello from Gmail");
    assert.equal(intake.sourceReference, `gmail:${sourceId}:message-1`);
    assert.equal(await prisma.communicationIntake.count({ where: { connectorSourceId: sourceId } }), 1);

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { actionName: "sync_gmail_messages", result: "success" },
      orderBy: { createdAt: "desc" },
    });
    const auditJson = JSON.stringify(audit);
    assert.ok(!auditJson.includes("Hello from Gmail"));
    assert.ok(!auditJson.includes("Kitchen quote"));
    assert.ok(!auditJson.includes("customer@example.com"));
    assert.ok(!auditJson.includes("newer_than:7d"));
  });

  it("initializes a Gmail history cursor and then imports only added messages", async () => {
    globalThis.fetch = async (input, init) => {
      const url = requestUrl(input);
      assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer access-token-1");
      if (url.pathname.endsWith("/profile")) return Response.json({ historyId: "100" });
      if (url.pathname.endsWith("/messages")) return Response.json({ messages: [] });
      throw new Error(`Unexpected initial sync request: ${url}`);
    };
    const initial = await request(app)
      .post(`/connectors/sources/${sourceId}/sync`)
      .set("Authorization", `Bearer ${token}`)
      .send({ max_results: 10 });
    assert.equal(initial.status, 200);
    assert.equal(initial.body.mode, "full");
    assert.equal(initial.body.cursorAdvanced, true);
    let stored = await prisma.connectorSource.findUniqueOrThrow({ where: { id: sourceId } });
    assert.equal(stored.syncCursor, "100");
    assert.ok(stored.lastFullSyncAt);

    globalThis.fetch = async (input, init) => {
      const url = requestUrl(input);
      assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer access-token-1");
      if (url.pathname.endsWith("/history")) {
        assert.equal(url.searchParams.get("startHistoryId"), "100");
        assert.equal(url.searchParams.get("historyTypes"), "messageAdded");
        return Response.json({
          history: [{ id: "104", messagesAdded: [{ message: { id: "message-2", threadId: "thread-2" } }] }],
          historyId: "105",
        });
      }
      if (url.pathname.endsWith("/messages/message-2")) {
        return Response.json({ id: "message-2", threadId: "thread-2", snippet: "Incremental Gmail message" });
      }
      throw new Error(`Unexpected incremental sync request: ${url}`);
    };
    const incremental = await request(app)
      .post(`/connectors/sources/${sourceId}/sync`)
      .set("Authorization", `Bearer ${token}`)
      .send({ max_results: 10 });
    assert.equal(incremental.status, 200);
    assert.equal(incremental.body.mode, "incremental");
    assert.equal(incremental.body.importedCount, 1);
    assert.equal(incremental.body.cursorAdvanced, true);
    stored = await prisma.connectorSource.findUniqueOrThrow({ where: { id: sourceId } });
    assert.equal(stored.syncCursor, "105");
    assert.equal(await prisma.communicationIntake.count({ where: { externalMessageId: "message-2" } }), 1);
  });

  it("refreshes an expired access token without replacing the refresh token", async () => {
    const expired = encryptConnectorPayload({
      accessToken: "expired-token",
      refreshToken: "refresh-token-1",
      scopes: [GMAIL_READONLY_SCOPE],
      tokenType: "Bearer",
      expiresAt: "2020-01-01T00:00:00.000Z",
    }, `${TEST_COMPANY_ID}:${sourceId}:gmail`);
    await prisma.connectorCredential.update({ where: { sourceId }, data: expired });
    let refreshed = false;
    globalThis.fetch = async (input, init) => {
      const url = requestUrl(input);
      if (url.toString() === "https://oauth2.googleapis.com/token") {
        const body = new URLSearchParams(String(init?.body));
        assert.equal(body.get("grant_type"), "refresh_token");
        assert.equal(body.get("refresh_token"), "refresh-token-1");
        refreshed = true;
        return Response.json({ access_token: "refreshed-token", expires_in: 3600, token_type: "Bearer" });
      }
      assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer refreshed-token");
      if (url.pathname.endsWith("/profile")) return Response.json({ historyId: "200" });
      if (url.pathname.endsWith("/messages")) return Response.json({ messages: [] });
      throw new Error("Unexpected Gmail request");
    };
    const response = await request(app)
      .post(`/connectors/sources/${sourceId}/sync`)
      .set("Authorization", `Bearer ${token}`)
      .send({ max_results: 1, full_sync: true });
    assert.equal(response.status, 200);
    assert.equal(response.body.importedCount, 0);
    assert.equal(refreshed, true);
  });

  it("falls back to a full sync when Gmail reports an expired history cursor", async () => {
    globalThis.fetch = async (input, init) => {
      const url = requestUrl(input);
      assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer refreshed-token");
      if (url.pathname.endsWith("/history")) return new Response("{}", { status: 404 });
      if (url.pathname.endsWith("/profile")) return Response.json({ historyId: "300" });
      if (url.pathname.endsWith("/messages")) return Response.json({ messages: [] });
      throw new Error(`Unexpected fallback request: ${url}`);
    };
    const response = await request(app)
      .post(`/connectors/sources/${sourceId}/sync`)
      .set("Authorization", `Bearer ${token}`)
      .send({ max_results: 10 });
    assert.equal(response.status, 200);
    assert.equal(response.body.mode, "full");
    assert.equal(response.body.fallbackFromExpiredHistory, true);
    const source = await prisma.connectorSource.findUniqueOrThrow({ where: { id: sourceId } });
    assert.equal(source.syncCursor, "300");
    assert.equal(source.lastSyncStatus, "success");
  });

  it("requires confirmation, revokes Google and removes the local encrypted credential", async () => {
    let contacted = false;
    globalThis.fetch = async () => {
      contacted = true;
      return new Response(null, { status: 200 });
    };
    const preview = await request(app)
      .post(`/connectors/sources/${sourceId}/disconnect`)
      .set("Authorization", `Bearer ${token}`)
      .send({ confirmed: false });
    assert.equal(preview.status, 409);
    assert.equal(preview.body.error, "CONFIRMATION_REQUIRED");
    assert.equal(preview.body.preview.willRevokeGoogleProjectGrant, true);
    assert.equal(contacted, false);

    globalThis.fetch = async (input, init) => {
      const url = requestUrl(input);
      assert.equal(url.toString(), "https://oauth2.googleapis.com/revoke");
      const body = new URLSearchParams(String(init?.body));
      assert.equal(body.get("token"), "refresh-token-1");
      return new Response(null, { status: 200 });
    };
    const disconnected = await request(app)
      .post(`/connectors/sources/${sourceId}/disconnect`)
      .set("Authorization", `Bearer ${token}`)
      .send({ confirmed: true });
    assert.equal(disconnected.status, 200);
    assert.equal(disconnected.body.providerGrantRevoked, true);
    assert.equal(await prisma.connectorCredential.count({ where: { sourceId } }), 0);
    const source = await prisma.connectorSource.findUniqueOrThrow({ where: { id: sourceId } });
    assert.equal(source.connectionStatus, "disconnected");
    assert.equal(source.isEnabled, false);
    assert.equal(source.syncCursor, null);
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { actionName: "disconnect_gmail_source", result: "success" },
      orderBy: { createdAt: "desc" },
    });
    assert.ok(!JSON.stringify(audit).includes("refresh-token-1"));
  });

  it("rejects a token carrying broader scopes than Gmail readonly", async () => {
    const start = await request(app)
      .post(`/connectors/sources/${sourceId}/oauth/start`)
      .set("Authorization", `Bearer ${token}`)
      .send({});
    assert.equal(start.status, 200);
    const state = new URL(start.body.authorizationUrl).searchParams.get("state");
    globalThis.fetch = async () => Response.json({
      access_token: "over-scoped-token",
      refresh_token: "over-scoped-refresh",
      expires_in: 3600,
      scope: `${GMAIL_READONLY_SCOPE} https://www.googleapis.com/auth/calendar.readonly`,
      token_type: "Bearer",
    });
    const callback = await request(app)
      .get("/connectors/gmail/oauth/callback")
      .query({ state, code: "over-scoped-code" });
    assert.equal(callback.status, 409);
    assert.equal(callback.body.error, "SCOPE_DENIED");
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { actionName: "complete_gmail_oauth", result: "error" },
      orderBy: { createdAt: "desc" },
    });
    assert.ok(!JSON.stringify(audit).includes("over-scoped"));
  });

  it("rechecks the initiating user's permission before exchanging the callback code", async () => {
    const start = await request(app)
      .post(`/connectors/sources/${sourceId}/oauth/start`)
      .set("Authorization", `Bearer ${token}`)
      .send({});
    assert.equal(start.status, 200);
    const state = new URL(start.body.authorizationUrl).searchParams.get("state");
    const admin = await prisma.user.findUniqueOrThrow({ where: { email: "admin@test.local" } });
    await prisma.user.update({
      where: { id: admin.id },
      data: { permissions: admin.permissions.filter((permission) => permission !== "connectors.manage") },
    });
    let providerContacted = false;
    globalThis.fetch = async () => {
      providerContacted = true;
      return Response.json({});
    };
    const callback = await request(app)
      .get("/connectors/gmail/oauth/callback")
      .query({ state, code: "permission-revoked-code" });
    assert.equal(callback.status, 403);
    assert.equal(callback.body.error, "MISSING_PERMISSION");
    assert.equal(providerContacted, false);
  });
});
