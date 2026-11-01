import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import bcrypt from "bcryptjs";
import request from "supertest";
import { createServer } from "../src/server.js";
import { prisma } from "../src/db.js";
import { MCP_SCOPE } from "../src/modules/mcp/oauth.js";
import { resetDb, seedCompanyAndAdmin, TEST_COMPANY_ID } from "./setup.js";

// OAuth 2.1 for the read-only MCP gateway — voice assistant master document 1.1a, step P2b.

const app = createServer();
const BASE = "https://secretary.test";
const RESOURCE = `${BASE}/mcp`;
const REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect";
const saved = { flag: process.env.MCP_GATEWAY_ENABLED, url: process.env.MCP_PUBLIC_URL };

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

describe("MCP OAuth 2.1", () => {
  before(async () => {
    await resetDb();
    await seedCompanyAndAdmin();
  });

  beforeEach(() => {
    process.env.MCP_GATEWAY_ENABLED = "true";
    process.env.MCP_PUBLIC_URL = BASE;
  });

  afterEach(async () => {
    for (const [key, value] of [["MCP_GATEWAY_ENABLED", saved.flag], ["MCP_PUBLIC_URL", saved.url]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await prisma.company.update({ where: { id: TEST_COMPANY_ID }, data: { safeModeSince: null } });
  });

  after(async () => { await prisma.$disconnect(); });

  const register = (body: Record<string, unknown> = { client_name: "ChatGPT", redirect_uris: [REDIRECT] }) =>
    request(app).post("/oauth/register").send(body);

  const authorizeQuery = (clientId: string, challenge: string, extra: Record<string, string> = {}) => ({
    client_id: clientId, redirect_uri: REDIRECT, response_type: "code", code_challenge: challenge,
    code_challenge_method: "S256", state: "s-123", scope: MCP_SCOPE, resource: RESOURCE, ...extra,
  });

  async function approvedCode() {
    const client = (await register()).body.client_id as string;
    const { verifier, challenge } = pkce();
    const res = await request(app).post("/oauth/authorize").type("form")
      .send({ ...authorizeQuery(client, challenge), email: "admin@test.local", password: "Password123!", decision: "approve" });
    assert.equal(res.status, 302, res.text);
    const location = new URL(res.headers.location);
    return { client, verifier, code: location.searchParams.get("code")!, location };
  }

  async function tokens() {
    const { client, verifier, code } = await approvedCode();
    const res = await request(app).post("/oauth/token").type("form")
      .send({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: client, code_verifier: verifier, resource: RESOURCE });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return { client, ...res.body as { access_token: string; refresh_token: string } };
  }

  const listTools = (token: string) =>
    request(app).post("/mcp").set("Authorization", `Bearer ${token}`).send({ jsonrpc: "2.0", id: 1, method: "tools/list" });

  it("does not exist while the gateway is off", async () => {
    delete process.env.MCP_GATEWAY_ENABLED;
    assert.equal((await request(app).get("/.well-known/oauth-authorization-server")).status, 404);
    assert.equal((await request(app).get("/.well-known/oauth-protected-resource/mcp")).status, 404);
    assert.equal((await register()).status, 404);
  });

  it("publishes discovery metadata for the resource and the authorization server", async () => {
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const resource = await request(app).get(path);
      assert.equal(resource.status, 200);
      assert.equal(resource.body.resource, RESOURCE);
      assert.deepEqual(resource.body.authorization_servers, [BASE]);
      assert.deepEqual(resource.body.scopes_supported, [MCP_SCOPE]);
    }
    const server = await request(app).get("/.well-known/oauth-authorization-server");
    assert.equal(server.body.issuer, BASE);
    assert.equal(server.body.authorization_endpoint, `${BASE}/oauth/authorize`);
    assert.equal(server.body.token_endpoint, `${BASE}/oauth/token`);
    assert.equal(server.body.registration_endpoint, `${BASE}/oauth/register`);
    assert.deepEqual(server.body.code_challenge_methods_supported, ["S256"]);
    assert.deepEqual(server.body.token_endpoint_auth_methods_supported, ["none"]);
  });

  it("tells an unauthenticated MCP client where to authorize", async () => {
    const res = await request(app).post("/mcp").send({ jsonrpc: "2.0", id: 1, method: "initialize" });
    assert.equal(res.status, 401);
    assert.match(res.headers["www-authenticate"], /^Bearer resource_metadata="https:\/\/secretary\.test\/\.well-known\/oauth-protected-resource\/mcp"/);
  });

  it("registers public clients with safe redirect addresses only", async () => {
    const ok = await register();
    assert.equal(ok.status, 201);
    assert.match(ok.body.client_id, /^mcp-[0-9a-f]{32}$/);
    assert.equal(ok.body.token_endpoint_auth_method, "none");
    assert.equal((await register({ redirect_uris: ["http://evil.example/cb"] })).status, 400);
    assert.equal((await register({ redirect_uris: ["https://ok.example/cb#frag"] })).status, 400);
    assert.equal((await register({ redirect_uris: [REDIRECT], token_endpoint_auth_method: "client_secret_basic" })).status, 400);
    assert.equal((await register({ redirect_uris: [] })).status, 400);
    assert.equal((await register({ redirect_uris: ["http://localhost:6274/oauth/callback"] })).status, 201);
  });

  it("shows the consent page only for a valid request, and never redirects an invalid one", async () => {
    const client = (await register({ client_name: "<script>x</script>", redirect_uris: [REDIRECT] })).body.client_id as string;
    const { challenge } = pkce();
    const page = await request(app).get("/oauth/authorize").query(authorizeQuery(client, challenge));
    assert.equal(page.status, 200);
    assert.ok(page.text.includes("&lt;script&gt;x&lt;/script&gt;"), "the client name is escaped");
    assert.ok(!page.text.includes("<script>x"), "no raw markup from the client");
    assert.match(page.headers["content-security-policy"], /frame-ancestors 'none'/);
    assert.match(page.headers["content-security-policy"], /form-action 'self' https:\/\/chatgpt\.com/);

    const wrongRedirect = await request(app).get("/oauth/authorize").query(authorizeQuery(client, challenge, { redirect_uri: "https://evil.example/cb" }));
    assert.equal(wrongRedirect.status, 400);
    assert.equal(wrongRedirect.headers.location, undefined);
    const noPkce = await request(app).get("/oauth/authorize").query(authorizeQuery(client, challenge, { code_challenge_method: "plain" }));
    assert.equal(noPkce.status, 400);
    const wrongScope = await request(app).get("/oauth/authorize").query(authorizeQuery(client, challenge, { scope: "secretary.write" }));
    assert.equal(wrongScope.status, 400);
    const wrongResource = await request(app).get("/oauth/authorize").query(authorizeQuery(client, challenge, { resource: "https://other.example/mcp" }));
    assert.equal(wrongResource.status, 400);
  });

  it("returns access_denied when the person denies", async () => {
    const client = (await register()).body.client_id as string;
    const res = await request(app).post("/oauth/authorize").type("form").send({ ...authorizeQuery(client, pkce().challenge), decision: "deny" });
    assert.equal(res.status, 302);
    const location = new URL(res.headers.location);
    assert.equal(location.origin + location.pathname, REDIRECT);
    assert.equal(location.searchParams.get("error"), "access_denied");
    assert.equal(location.searchParams.get("state"), "s-123");
  });

  it("issues nothing for a wrong password, a temporary password or during an emergency stop", async () => {
    const client = (await register()).body.client_id as string;
    const before = await prisma.mcpOAuthGrant.count();
    const wrong = await request(app).post("/oauth/authorize").type("form")
      .send({ ...authorizeQuery(client, pkce().challenge), email: "admin@test.local", password: "nope", decision: "approve" });
    assert.equal(wrong.status, 401);

    await prisma.company.update({ where: { id: TEST_COMPANY_ID }, data: { safeModeSince: new Date() } });
    const stopped = await request(app).post("/oauth/authorize").type("form")
      .send({ ...authorizeQuery(client, pkce().challenge), email: "admin@test.local", password: "Password123!", decision: "approve" });
    assert.equal(stopped.status, 423);
    await prisma.company.update({ where: { id: TEST_COMPANY_ID }, data: { safeModeSince: null } });

    await prisma.user.update({ where: { email: "admin@test.local" }, data: { mustChangePassword: true } });
    const temporary = await request(app).post("/oauth/authorize").type("form")
      .send({ ...authorizeQuery(client, pkce().challenge), email: "admin@test.local", password: "Password123!", decision: "approve" });
    assert.equal(temporary.status, 403);
    await prisma.user.update({ where: { email: "admin@test.local" }, data: { mustChangePassword: false } });
    assert.equal(await prisma.mcpOAuthGrant.count(), before);
  });

  it("binds a client to the first approving company", async () => {
    const other = await prisma.company.create({ data: { name: "Other OAuth Co" } });
    await prisma.user.create({
      data: { companyId: other.id, email: "oauth-other@test.local", passwordHash: await bcrypt.hash("Password123!", 10), displayName: "Other", role: "admin", permissions: ["crm.read"] },
    });
    const { client } = await approvedCode();
    assert.equal((await prisma.mcpOAuthClient.findUnique({ where: { clientId: client } }))?.companyId, TEST_COMPANY_ID);
    const res = await request(app).post("/oauth/authorize").type("form")
      .send({ ...authorizeQuery(client, pkce().challenge), email: "oauth-other@test.local", password: "Password123!", decision: "approve" });
    assert.equal(res.status, 403);
    assert.equal(res.headers.location, undefined);
  });

  it("approves with the account password, audits it and redirects with a code", async () => {
    const { code, location, client } = await approvedCode();
    assert.equal(location.searchParams.get("state"), "s-123");
    assert.equal(location.searchParams.get("iss"), BASE);
    assert.match(code, /^[A-Za-z0-9_-]{43}$/);
    const stored = await prisma.mcpOAuthGrant.findFirst({ where: { clientId: client, kind: "code" } });
    assert.ok(stored);
    assert.notEqual(stored.tokenHash, code, "only a hash is stored");
    const audit = await prisma.auditLog.findFirst({ where: { actionName: "authorize_mcp_client" }, orderBy: { createdAt: "desc" } });
    assert.ok(audit);
    assert.equal(JSON.stringify(audit).includes("Password123!"), false);
    assert.equal(JSON.stringify(audit).includes(code), false);
  });

  it("exchanges a code once, only with the right PKCE verifier", async () => {
    const { client, verifier, code } = await approvedCode();
    const exchange = (codeVerifier: string) => request(app).post("/oauth/token").type("form")
      .send({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: client, code_verifier: codeVerifier });
    const wrong = await exchange(pkce().verifier);
    assert.equal(wrong.status, 400);
    assert.equal(wrong.body.error, "invalid_grant");

    const ok = await exchange(verifier);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.token_type, "Bearer");
    assert.equal(ok.body.scope, MCP_SCOPE);
    assert.equal(ok.headers["cache-control"], "no-store");

    const replay = await exchange(verifier);
    assert.equal(replay.body.error, "invalid_grant");
    // A replayed code ends what it produced.
    const refresh = await request(app).post("/oauth/token").type("form")
      .send({ grant_type: "refresh_token", refresh_token: ok.body.refresh_token, client_id: client });
    assert.equal(refresh.body.error, "invalid_grant");
  });

  it("lets an access token use the MCP gateway and nothing else", async () => {
    const { access_token } = await tokens();
    const tools = await listTools(access_token);
    assert.equal(tools.status, 200, JSON.stringify(tools.body));
    assert.ok(tools.body.result.tools.length > 0);
    const elsewhere = await request(app).get("/crm/clients").set("Authorization", `Bearer ${access_token}`);
    assert.equal(elsewhere.status, 401);
  });

  it("refuses an access token issued for another resource", async () => {
    const { access_token } = await tokens();
    process.env.MCP_PUBLIC_URL = "https://another.test";
    const res = await listTools(access_token);
    assert.equal(res.status, 401);
    assert.match(res.headers["www-authenticate"], /error="invalid_token"/);
  });

  it("rotates refresh tokens and revokes the chain when an old one returns", async () => {
    const { client, refresh_token } = await tokens();
    const refresh = (token: string) => request(app).post("/oauth/token").type("form")
      .send({ grant_type: "refresh_token", refresh_token: token, client_id: client });
    const rotated = await refresh(refresh_token);
    assert.equal(rotated.status, 200, JSON.stringify(rotated.body));
    assert.notEqual(rotated.body.refresh_token, refresh_token);
    assert.equal((await listTools(rotated.body.access_token)).status, 200);

    const reused = await refresh(refresh_token);
    assert.equal(reused.body.error, "invalid_grant");
    assert.equal((await refresh(rotated.body.refresh_token)).body.error, "invalid_grant", "the whole chain ends");

    const otherClient = await request(app).post("/oauth/token").type("form")
      .send({ grant_type: "refresh_token", refresh_token: "x".repeat(43), client_id: client });
    assert.equal(otherClient.body.error, "invalid_grant");
    assert.equal((await request(app).post("/oauth/token").type("form").send({ grant_type: "password" })).body.error, "unsupported_grant_type");
  });

  it("ends every connection when the password changes", async () => {
    const { client, access_token, refresh_token } = await tokens();
    await prisma.user.update({ where: { email: "admin@test.local" }, data: { authVersion: { increment: 1 } } });
    assert.equal((await listTools(access_token)).status, 401);
    const refresh = await request(app).post("/oauth/token").type("form")
      .send({ grant_type: "refresh_token", refresh_token, client_id: client });
    assert.equal(refresh.body.error, "invalid_grant");
  });

  it("still accepts the owner's own Secretary token on the gateway", async () => {
    const login = await request(app).post("/auth/login").send({ email: "admin@test.local", password: "Password123!" });
    assert.equal((await listTools(login.body.token)).status, 200);
  });
});
