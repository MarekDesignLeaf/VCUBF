import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import request from "supertest";
import { GOOGLE_PHOTOS_PICKER_SCOPE } from "../src/connectors/googlePhotosAdapter.js";
import { prisma } from "../src/db.js";
import { createServer } from "../src/server.js";
import { resetDb, seedCompanyAndAdmin } from "./setup.js";

const app = createServer();
const originalFetch = globalThis.fetch;
const original = {
  id: process.env.GOOGLE_PHOTOS_OAUTH_CLIENT_ID,
  secret: process.env.GOOGLE_PHOTOS_OAUTH_CLIENT_SECRET,
  redirect: process.env.GOOGLE_PHOTOS_OAUTH_REDIRECT_URI,
  encryption: process.env.CONNECTOR_ENCRYPTION_KEY,
};
const urlOf = (input: string | URL | Request) => new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);

describe("Google Photos Picker connector", () => {
  let token: string;
  let sourceId: string;
  let state: string;
  let pickerSessionId: string;
  let itemId: string;
  let portfolioPhotoId: string;

  before(async () => {
    process.env.GOOGLE_PHOTOS_OAUTH_CLIENT_ID = "photos.apps.googleusercontent.com";
    process.env.GOOGLE_PHOTOS_OAUTH_CLIENT_SECRET = "secret";
    process.env.GOOGLE_PHOTOS_OAUTH_REDIRECT_URI = "http://localhost:4000/connectors/google-photos/oauth/callback";
    process.env.CONNECTOR_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    await resetDb();
    await seedCompanyAndAdmin();
    token = (await request(app).post("/auth/login").send({ email: "admin@test.local", password: "Password123!" })).body.token;
    const source = await request(app).post("/connectors/sources").set("Authorization", `Bearer ${token}`).send({
      connector_key: "google_photos",
      display_name: "Selected Google Photos",
      configured_scopes: ["select:user_selected_photos"],
    });
    assert.equal(source.status, 201);
    sourceId = source.body.id;
  });

  afterEach(() => { globalThis.fetch = originalFetch; });
  after(async () => {
    await resetDb();
    await prisma.$disconnect();
    const vars = {
      GOOGLE_PHOTOS_OAUTH_CLIENT_ID: original.id,
      GOOGLE_PHOTOS_OAUTH_CLIENT_SECRET: original.secret,
      GOOGLE_PHOTOS_OAUTH_REDIRECT_URI: original.redirect,
      CONNECTOR_ENCRYPTION_KEY: original.encryption,
    };
    for (const [key, value] of Object.entries(vars)) value === undefined ? delete process.env[key] : process.env[key] = value;
  });

  it("authorizes the separate Photos Picker scope and encrypts tokens", async () => {
    const start = await request(app).post(`/connectors/sources/${sourceId}/oauth/start`).set("Authorization", `Bearer ${token}`).send({});
    assert.equal(start.status, 200);
    const authorization = new URL(start.body.authorizationUrl);
    assert.equal(authorization.searchParams.get("scope"), GOOGLE_PHOTOS_PICKER_SCOPE);
    state = authorization.searchParams.get("state")!;
    globalThis.fetch = async (input) => {
      assert.equal(urlOf(input).toString(), "https://oauth2.googleapis.com/token");
      return Response.json({ access_token: "photos-access", refresh_token: "photos-refresh", expires_in: 3600, scope: GOOGLE_PHOTOS_PICKER_SCOPE });
    };
    const callback = await request(app).get("/connectors/google-photos/oauth/callback").query({ state, code: "code" });
    assert.equal(callback.status, 303);
    const stored = await prisma.connectorCredential.findUniqueOrThrow({ where: { sourceId } });
    assert.equal(stored.provider, "google_photos");
    assert.ok(!JSON.stringify(stored).includes("photos-access"));
    await request(app).post(`/connectors/sources/${sourceId}/enable`).set("Authorization", `Bearer ${token}`).send({ confirmed: true }).expect(200);
  });

  it("creates a separate user-controlled Google Photos selection session", async () => {
    globalThis.fetch = async (input, init) => {
      const url = urlOf(input);
      assert.equal(url.origin, "https://photospicker.googleapis.com");
      assert.equal(url.pathname, "/v1/sessions");
      assert.equal(url.searchParams.has("requestId"), true);
      assert.equal(init?.method, "POST");
      assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer photos-access");
      assert.deepEqual(JSON.parse(String(init?.body)), { pickingConfig: { maxItemCount: "20" } });
      return Response.json({ id: "session-1", pickerUri: "https://photos.google.com/picker/session-1", expireTime: "2026-07-13T12:00:00Z", pollingConfig: { pollInterval: "3s" }, mediaItemsSet: false });
    };
    const result = await request(app).post(`/connectors/sources/${sourceId}/google-photos/picker-sessions`).set("Authorization", `Bearer ${token}`).send({});
    assert.equal(result.status, 201);
    assert.equal(result.body.sessionId, "session-1");
    assert.equal(result.body.pollIntervalMs, 3000);
    pickerSessionId = result.body.sessionId;
    assert.ok(!JSON.stringify(result.body).includes("photos-access"));
  });

  it("stages only user-selected photo metadata and removes the completed picker session", async () => {
    let deleted = false;
    globalThis.fetch = async (input, init) => {
      const url = urlOf(input);
      assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer photos-access");
      if (url.pathname === `/v1/sessions/${pickerSessionId}` && init?.method === "GET") {
        return Response.json({ id: pickerSessionId, mediaItemsSet: true });
      }
      if (url.pathname === "/v1/mediaItems") {
        assert.equal(url.searchParams.get("sessionId"), pickerSessionId);
        return Response.json({ mediaItems: [
          { id: "photo-1", type: "PHOTO", createTime: "2026-07-01T10:00:00Z", mediaFile: { baseUrl: "https://temporary.example/bytes", mimeType: "image/jpeg", filename: "garden-after.jpg", mediaFileMetadata: { width: 1600, height: 1200 } } },
          { id: "video-1", type: "VIDEO", mediaFile: { baseUrl: "https://temporary.example/video", mimeType: "video/mp4", filename: "garden.mp4" } },
        ] });
      }
      if (url.pathname === `/v1/sessions/${pickerSessionId}` && init?.method === "DELETE") {
        deleted = true;
        return new Response(null, { status: 200 });
      }
      throw new Error(`Unexpected request ${url}`);
    };
    const staged = await request(app).post(`/connectors/sources/${sourceId}/google-photos/picker-sessions/${pickerSessionId}/import`).set("Authorization", `Bearer ${token}`).send({});
    assert.equal(staged.status, 200);
    assert.equal(staged.body.items.length, 1);
    assert.equal(staged.body.skippedNonImageCount, 1);
    assert.equal(deleted, true);
    itemId = staged.body.items[0].id;
    const stored = await prisma.externalGooglePhoto.findUniqueOrThrow({ where: { id: itemId } });
    assert.equal(stored.name, "garden-after.jpg");
    assert.equal((stored as any).baseUrl, undefined);
    assert.ok(!JSON.stringify(stored).includes("temporary.example"));
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { actionName: "stage_google_photos_items" } });
    assert.ok(!JSON.stringify(audit).includes("temporary.example"));
  });

  it("requires confirmation before registering a Google Photos portfolio reference", async () => {
    const preview = await request(app).post(`/connectors/sources/${sourceId}/google-photos/items/${itemId}/register`).set("Authorization", `Bearer ${token}`).send({ confirmed: false });
    assert.equal(preview.status, 409);
    const registered = await request(app).post(`/connectors/sources/${sourceId}/google-photos/items/${itemId}/register`).set("Authorization", `Bearer ${token}`).send({ confirmed: true, tags: ["garden"] });
    assert.equal(registered.status, 201);
    assert.equal(registered.body.source, "google_photos");
    assert.equal(registered.body.usableForMarketing, false);
    portfolioPhotoId = registered.body.id;
  });

  it("disconnects without deleting staged or portfolio metadata", async () => {
    await request(app).post(`/connectors/sources/${sourceId}/disconnect`).set("Authorization", `Bearer ${token}`).send({ confirmed: false }).expect(409);
    globalThis.fetch = async (input) => {
      assert.equal(urlOf(input).toString(), "https://oauth2.googleapis.com/revoke");
      return new Response(null, { status: 200 });
    };
    const result = await request(app).post(`/connectors/sources/${sourceId}/disconnect`).set("Authorization", `Bearer ${token}`).send({ confirmed: true });
    assert.equal(result.status, 200);
    assert.ok(await prisma.externalGooglePhoto.findUnique({ where: { id: itemId } }));
    assert.ok(await prisma.portfolioPhoto.findUnique({ where: { id: portfolioPhotoId } }));
  });
});
