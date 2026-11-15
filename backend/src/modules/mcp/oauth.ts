/**
 * OAuth 2.1 for the MCP gateway (voice assistant master document 1.1a, step
 * P2b; write scope step P2c).
 *
 * What ChatGPT and Claude need to connect a remote MCP server:
 *
 * - Protected resource metadata (RFC 9728) and authorization server metadata
 *   (RFC 8414), so the client can discover where to authorize.
 * - Dynamic Client Registration (RFC 7591) for public clients (no secret).
 * - Authorization code with PKCE S256 only, the resource indicator (RFC 8707)
 *   bound into every token, and refresh tokens rotated on every use.
 *
 * The person approves on a page served here with their Secretary e-mail and
 * password, exactly the credentials /auth/login checks. Two scopes exist:
 * secretary.read, always granted, and secretary.write, offered only while
 * MCP_WRITE_ENABLED is "true" and granted only when the person ticks a separate
 * box and presses the read-and-write button. A client may ask for write; the
 * person may still approve read only, and the token response says which was
 * granted. A refresh can never widen a grant, so a connection approved for
 * reading must be approved again before it can write. Codes and refresh tokens are
 * stored as SHA-256 hashes; access tokens are short, purpose-restricted JWTs
 * that requireAuth refuses on every other route. Changing the password (the
 * account's authVersion) ends every connection at once.
 *
 * Off with the gateway: while MCP_GATEWAY_ENABLED is not "true" every path
 * here answers 404.
 */

import { createHash, randomBytes } from "node:crypto";
import express, { Router, type NextFunction, type Request, type Response } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import { z } from "zod";
import { prisma } from "../../db.js";
import { recordAudit } from "../../lib/audit.js";
import { AUTHORIZE_MCP_CLIENT_ACTION } from "../../lib/actionContracts.js";
import { safeModeGate } from "../../lib/safeMode.js";
import { idempotencyGuard } from "../../middleware/idempotency.js";
import {
  MCP_ACCESS_PURPOSE,
  authedUserFromRecord,
  requireAuth,
  signMcpAccessToken,
  verifyMcpAccessToken,
} from "../../middleware/auth.js";
import { mcpGatewayEnabled, mcpPublicBase, mcpResource, mcpWriteEnabled, protectedResourceMetadataUrl } from "./gate.js";

export const MCP_READ_SCOPE = "secretary.read";
export const MCP_WRITE_SCOPE = "secretary.write";
/** The read scope, under the name the read-only gateway used for it. */
export const MCP_SCOPE = MCP_READ_SCOPE;
const KNOWN_SCOPES = [MCP_READ_SCOPE, MCP_WRITE_SCOPE] as const;
export const MCP_ACCESS_TOKEN_SECONDS = 60 * 60;
export const MCP_REFRESH_TOKEN_SECONDS = 30 * 24 * 60 * 60;
export const MCP_CODE_SECONDS = 5 * 60;
/** Registration is public; this caps what an anonymous caller can store. */
export const MCP_MAX_REGISTERED_CLIENTS = 500;

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const secret = () => randomBytes(32).toString("base64url");

/** The scopes this server will issue right now: write only while its switch is on. */
export function supportedScopes(): string[] {
  return mcpWriteEnabled() ? [MCP_READ_SCOPE, MCP_WRITE_SCOPE] : [MCP_READ_SCOPE];
}

/** A space-separated scope string as a list, each scope once. */
export function parseScopes(value: string): string[] {
  return [...new Set(value.split(/\s+/).filter(Boolean))];
}

/** The canonical form stored and issued: read first, then write. */
export function scopeString(scopes: Iterable<string>): string {
  const set = new Set(scopes);
  return KNOWN_SCOPES.filter((scope) => set.has(scope)).join(" ");
}

function pkceMatches(verifier: string, challenge: string): boolean {
  return createHash("sha256").update(verifier).digest("base64url") === challenge;
}

export function validRedirectUri(uri: unknown): uri is string {
  if (typeof uri !== "string" || uri.length > 1500) return false;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.hash || url.username || url.password) return false;
  if (url.protocol === "https:" && url.hostname) return true;
  return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

function gate(_req: Request, res: Response, next: NextFunction) {
  if (!mcpGatewayEnabled()) return res.status(404).json({ error: "NOT_FOUND" });
  return next();
}

function noStore(res: Response) {
  res.set("Cache-Control", "no-store").set("Pragma", "no-cache");
}

function oauthError(res: Response, status: number, error: string, description?: string) {
  noStore(res);
  return res.status(status).json(description ? { error, error_description: description } : { error });
}

// ---------------------------------------------------------------------------
// The MCP route's door: an OAuth access token, or the owner's own token.

/**
 * Accepts an MCP access token bound to this resource, then applies the same
 * idempotency guard and emergency-stop gate as requireAuth. A token without a
 * purpose (the owner's own Secretary token) goes through requireAuth itself.
 * A refused request carries the WWW-Authenticate challenge that tells MCP
 * clients where to find the authorization server.
 */
export async function requireMcpAuth(req: Request, res: Response, next: NextFunction) {
  const challenge = `Bearer resource_metadata="${protectedResourceMetadataUrl(req)}"`;
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    res.set("WWW-Authenticate", challenge);
    return res.status(401).json({ error: "MISSING_PERMISSION", message: "No token provided" });
  }
  const token = header.slice("Bearer ".length);
  const decoded = jwt.decode(token) as { purpose?: unknown } | null;
  if (decoded && decoded.purpose === undefined) return requireAuth(req, res, next);

  const refuse = () => {
    res.set("WWW-Authenticate", `${challenge}, error="invalid_token"`);
    return res.status(401).json({ error: "MISSING_PERMISSION", message: "Invalid token" });
  };
  if (!decoded || decoded.purpose !== MCP_ACCESS_PURPOSE) return refuse();
  const claims = verifyMcpAccessToken(token, mcpResource(req));
  if (!claims) return refuse();
  // Every token carries the read scope; anything unknown means it was not ours.
  const scopes = parseScopes(claims.scope);
  if (!scopes.includes(MCP_READ_SCOPE) || scopes.some((scope) => !(KNOWN_SCOPES as readonly string[]).includes(scope))) return refuse();
  const [user, client] = await Promise.all([
    prisma.user.findUnique({ where: { id: claims.sub }, include: { company: { select: { safeModeSince: true } } } }),
    prisma.mcpOAuthClient.findUnique({ where: { clientId: claims.cid }, select: { companyId: true } }),
  ]);
  if (!user || !user.isActive || user.authVersion !== claims.authVersion || !client || client.companyId !== user.companyId) return refuse();
  req.safeModeSince = user.company.safeModeSince;
  req.user = authedUserFromRecord(user);
  req.mcpAccess = { clientId: claims.cid, scopes };
  return idempotencyGuard(req, res, () => safeModeGate(req, res, next));
}

/**
 * The answer to a token that lacks a scope the call needs (RFC 6750 §3.1, MCP
 * authorization "scope challenge"): 403 with the scopes that would satisfy it,
 * so a client that supports step-up can ask the person to approve them.
 */
export function insufficientScope(req: Request, res: Response, description: string) {
  res.set(
    "WWW-Authenticate",
    `Bearer error="insufficient_scope", scope="${MCP_READ_SCOPE} ${MCP_WRITE_SCOPE}", resource_metadata="${protectedResourceMetadataUrl(req)}", error_description="${description.replace(/["\\]/g, "")}"`,
  );
  return res.status(403).json({ error: "INSUFFICIENT_SCOPE", message: description, required_scope: `${MCP_READ_SCOPE} ${MCP_WRITE_SCOPE}` });
}

// ---------------------------------------------------------------------------
// Discovery.

export const mcpWellKnownRouter = Router();
mcpWellKnownRouter.use(gate);

function protectedResource(req: Request, res: Response) {
  res.json({
    resource: mcpResource(req),
    authorization_servers: [mcpPublicBase(req)],
    scopes_supported: supportedScopes(),
    bearer_methods_supported: ["header"],
    resource_name: "Secretary (VCUBF)",
  });
}

mcpWellKnownRouter.get("/oauth-protected-resource", protectedResource);
mcpWellKnownRouter.get("/oauth-protected-resource/mcp", protectedResource);

mcpWellKnownRouter.get("/oauth-authorization-server", (req, res) => {
  const issuer = mcpPublicBase(req);
  res.json({
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: supportedScopes(),
  });
});

// ---------------------------------------------------------------------------
// Registration, authorization, tokens.

export const mcpOAuthRouter = Router();
mcpOAuthRouter.use(gate);
mcpOAuthRouter.use(express.urlencoded({ extended: false, limit: "16kb" }));

const ipOnly = (req: Request) => ipKeyGenerator(req.ip ?? "unknown");

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, limit: 20, standardHeaders: "draft-8", legacyHeaders: false, keyGenerator: ipOnly,
  handler: (_req, res) => oauthError(res, 429, "temporarily_unavailable", "Too many registrations."),
});
const approveLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: "draft-8", legacyHeaders: false, skipSuccessfulRequests: true,
  keyGenerator: (req) => {
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "invalid";
    return `${ipOnly(req)}:${email}`;
  },
  handler: (_req, res) => res.status(429).type("text/plain").send("Too many attempts. Try again later."),
});
const tokenLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 120, standardHeaders: "draft-8", legacyHeaders: false, keyGenerator: ipOnly,
  handler: (_req, res) => oauthError(res, 429, "temporarily_unavailable", "Too many token requests."),
});

const registrationSchema = z.object({
  redirect_uris: z.array(z.string()).min(1).max(5),
  client_name: z.string().max(200).optional(),
  token_endpoint_auth_method: z.literal("none").optional(),
  grant_types: z.array(z.enum(["authorization_code", "refresh_token"])).optional(),
  response_types: z.array(z.literal("code")).optional(),
}).passthrough();

mcpOAuthRouter.post("/register", registerLimiter, async (req, res) => {
  const parsed = registrationSchema.safeParse(req.body);
  if (!parsed.success) return oauthError(res, 400, "invalid_client_metadata", "Only public clients using the authorization code with PKCE are supported.");
  const redirectUris = parsed.data.redirect_uris;
  if (new Set(redirectUris).size !== redirectUris.length || !redirectUris.every(validRedirectUri)) {
    return oauthError(res, 400, "invalid_redirect_uri");
  }
  if (await prisma.mcpOAuthClient.count() >= MCP_MAX_REGISTERED_CLIENTS) {
    return oauthError(res, 429, "temporarily_unavailable", "Registration limit reached.");
  }
  const clientName = (parsed.data.client_name ?? "").trim().slice(0, 100) || "MCP client";
  const client = await prisma.mcpOAuthClient.create({
    data: { clientId: `mcp-${randomBytes(16).toString("hex")}`, clientName, redirectUris },
  });
  noStore(res);
  return res.status(201).json({
    client_id: client.clientId,
    client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
    client_name: client.clientName,
    redirect_uris: client.redirectUris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  });
});

interface AuthorizationRequest {
  clientId: string;
  clientName: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
  /** What the client asked for, canonical; the person may approve less. */
  scope: string;
}

/**
 * Checks an authorization request. Until the client and its redirect URI are
 * known to be valid nothing may be redirected anywhere (RFC 6749 §4.1.2.1),
 * so every failure here is answered on this page.
 */
async function authorizationRequest(req: Request, source: Record<string, unknown>): Promise<AuthorizationRequest | string> {
  const text = (key: string) => (typeof source[key] === "string" ? (source[key] as string) : "");
  const client = await prisma.mcpOAuthClient.findUnique({ where: { clientId: text("client_id") } });
  if (!client) return "Unknown application.";
  const redirectUri = text("redirect_uri");
  if (!client.redirectUris.includes(redirectUri)) return "The return address does not belong to this application.";
  if (text("response_type") !== "code") return "Unsupported response type.";
  if (text("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/.test(text("code_challenge"))) return "A PKCE S256 code challenge is required.";
  const resource = text("resource");
  if (resource && resource !== mcpResource(req)) return "This authorization server does not issue tokens for that resource.";
  const requested = parseScopes(text("scope") || MCP_READ_SCOPE);
  const offered = supportedScopes();
  if (requested.some((entry) => !offered.includes(entry))) return `Only these scopes can be requested: ${offered.join(", ")}.`;
  if (text("state").length > 500) return "The state parameter is too long.";
  // Reading comes with every connection, so asking for write alone asks for both.
  const scope = scopeString([MCP_READ_SCOPE, ...requested]);
  return { clientId: client.clientId, clientName: client.clientName, redirectUri, codeChallenge: text("code_challenge"), state: text("state"), scope };
}

const escapeHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

function page(res: Response, status: number, body: string, formTarget?: string) {
  noStore(res);
  res.set("Referrer-Policy", "no-referrer");
  res.set("X-Frame-Options", "DENY");
  // A browser applies form-action to the redirect that follows the form, so
  // the application's own return origin is allowed and nothing else.
  const formAction = formTarget ? `'self' ${new URL(formTarget).origin}` : "'self'";
  res.set("Content-Security-Policy", `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction}; base-uri 'none'; frame-ancestors 'none'`);
  return res.status(status).type("html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Secretary authorization</title>
<style>body{font:16px system-ui,sans-serif;max-width:520px;margin:40px auto;padding:0 20px}
input,button{box-sizing:border-box;width:100%;padding:12px;margin-top:8px;font:inherit}
button{border:0;border-radius:8px;background:#1f5f3f;color:#fff;margin-top:16px}
button.secondary{background:#e5e5e5;color:#222}.error{color:#a00}
label.check{display:flex;gap:8px;align-items:flex-start;margin-top:16px}label.check input{width:auto;margin-top:4px}</style></head><body>${body}</body></html>`);
}

export const WRITE_CONSENT_FIELD = "allow_write";

function consentPage(res: Response, request: AuthorizationRequest, status = 200, error?: string) {
  const hidden = (name: string, value: string) => `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;
  const asksWrite = parseScopes(request.scope).includes(MCP_WRITE_SCOPE);
  const returnOrigin = new URL(request.redirectUri).host;
  const purpose = asksWrite
    ? `<p><strong>${escapeHtml(request.clientName)}</strong> asks to <strong>read</strong> your company's records in Secretary
and to <strong>create and change</strong> clients, contacts, leads, jobs, tasks, quotes and draft invoices on your behalf.</p>
<p>Every change runs under your own account, your permissions and the administrator's switches, and is recorded in the audit log.
Archiving, converting a lead and changing an invoice's status are shown to you first and need a separate yes in the conversation.
Nothing is e-mailed, messaged, published or deleted.</p>`
    : `<p><strong>${escapeHtml(request.clientName)}</strong> asks to <strong>read</strong> your company's records in Secretary.
It cannot write, send or delete anything.</p>`;
  const writeChoice = asksWrite
    ? `<label class="check"><input type="checkbox" name="${WRITE_CONSENT_FIELD}" value="yes"> I allow ${escapeHtml(request.clientName)} to create and change records in Secretary.</label>
<button type="submit" name="decision" value="approve_write">Approve read and write access</button>
<button type="submit" name="decision" value="approve" class="secondary">Approve read access only</button>`
    : `<button type="submit" name="decision" value="approve">Approve read access</button>`;
  return page(res, status, `<h1>Connect to Secretary</h1>
${purpose}
<p>Approve only a connection you started yourself. It returns to <strong>${escapeHtml(returnOrigin)}</strong>.</p>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
<form method="post" action="/oauth/authorize">
${hidden("client_id", request.clientId)}${hidden("redirect_uri", request.redirectUri)}${hidden("response_type", "code")}
${hidden("code_challenge", request.codeChallenge)}${hidden("code_challenge_method", "S256")}${hidden("state", request.state)}${hidden("scope", request.scope)}
<label>E-mail<input type="email" name="email" autocomplete="username" required></label>
<label>Password<input type="password" name="password" autocomplete="current-password" required></label>
${writeChoice}
<button type="submit" name="decision" value="deny" class="secondary" formnovalidate>Deny</button>
</form>`, request.redirectUri);
}

function redirectTo(res: Response, redirectUri: string, params: Record<string, string>) {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) if (value) url.searchParams.set(key, value);
  noStore(res);
  return res.redirect(302, url.toString());
}

mcpOAuthRouter.get("/authorize", async (req, res) => {
  const request = await authorizationRequest(req, req.query as Record<string, unknown>);
  if (typeof request === "string") return page(res, 400, `<h1>Authorization request refused</h1><p class="error">${escapeHtml(request)}</p>`);
  return consentPage(res, request);
});

mcpOAuthRouter.post("/authorize", approveLimiter, async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const request = await authorizationRequest(req, body);
  if (typeof request === "string") return page(res, 400, `<h1>Authorization request refused</h1><p class="error">${escapeHtml(request)}</p>`);
  const issuer = mcpPublicBase(req);
  if (body.decision !== "approve" && body.decision !== "approve_write") {
    return redirectTo(res, request.redirectUri, { error: "access_denied", state: request.state, iss: issuer });
  }
  // Writing is granted only by its own button, with its own box ticked, and
  // only while it was asked for and is switched on. Anything less is read only.
  const grantsWrite = body.decision === "approve_write";
  if (grantsWrite && !parseScopes(request.scope).includes(MCP_WRITE_SCOPE)) {
    return consentPage(res, request, 400, "Write access was not requested by this application.");
  }
  if (grantsWrite && body[WRITE_CONSENT_FIELD] !== "yes") {
    return consentPage(res, request, 400, "Tick the box to allow creating and changing records, or approve read access only.");
  }
  const grantedScope = grantsWrite ? scopeString([MCP_READ_SCOPE, MCP_WRITE_SCOPE]) : MCP_READ_SCOPE;

  const email = typeof body.email === "string" ? body.email.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const user = email ? await prisma.user.findUnique({ where: { email }, include: { company: { select: { safeModeSince: true } } } }) : null;
  if (!user || !user.isActive || !password || !(await bcrypt.compare(password, user.passwordHash))) {
    return consentPage(res, request, 401, "The e-mail or password is not correct.");
  }
  if (user.mustChangePassword) return consentPage(res, request, 403, "Change your temporary password in Secretary first.");
  if (user.company.safeModeSince) return consentPage(res, request, 423, "Secretary is in an emergency stop. New connections are refused.");
  // The first approval binds the client to this company; nobody from another company can approve it afterwards.
  const bound = await prisma.mcpOAuthClient.updateMany({
    where: { clientId: request.clientId, OR: [{ companyId: null }, { companyId: user.companyId }] },
    data: { companyId: user.companyId },
  });
  if (bound.count !== 1) return consentPage(res, request, 403, "This connection belongs to another company. Start a new connection from your AI client.");

  const code = secret();
  await prisma.mcpOAuthGrant.create({
    data: {
      tokenHash: sha256(code), kind: "code", clientId: request.clientId, companyId: user.companyId, userId: user.id,
      authVersion: user.authVersion, scope: grantedScope, redirectUri: request.redirectUri, codeChallenge: request.codeChallenge,
      expiresAt: new Date(Date.now() + MCP_CODE_SECONDS * 1000),
    },
  });
  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: AUTHORIZE_MCP_CLIENT_ACTION.actionName,
    interpretedIntent: "authorize_mcp_client",
    inputPayload: {
      clientId: request.clientId, clientName: request.clientName, requestedScope: request.scope, scope: grantedScope,
      redirectOrigin: new URL(request.redirectUri).origin,
    },
    riskLevel: AUTHORIZE_MCP_CLIENT_ACTION.riskLevel,
    confirmationRequired: AUTHORIZE_MCP_CLIENT_ACTION.confirmationRequired,
    confirmed: true,
    result: "success",
  });
  return redirectTo(res, request.redirectUri, { code, state: request.state, iss: issuer });
});

/** Ends every code and refresh token of one client for one user. */
async function revokeChain(clientId: string, userId: string) {
  await prisma.mcpOAuthGrant.updateMany({ where: { clientId, userId, revokedAt: null }, data: { revokedAt: new Date() } });
}

async function issueTokens(req: Request, res: Response, grant: { clientId: string; companyId: string; userId: string; authVersion: number; scope: string }) {
  // Never more than was approved, and never a scope this server does not issue
  // right now: with writing switched off a connection continues read only, and
  // must be approved again for writing once it is switched back on.
  const offered = supportedScopes();
  const scope = scopeString(parseScopes(grant.scope).filter((entry) => offered.includes(entry)));
  if (!parseScopes(scope).includes(MCP_READ_SCOPE)) return oauthError(res, 400, "invalid_scope");
  grant = { ...grant, scope };
  const refreshToken = secret();
  await prisma.mcpOAuthGrant.create({
    data: {
      tokenHash: sha256(refreshToken), kind: "refresh", clientId: grant.clientId, companyId: grant.companyId, userId: grant.userId,
      authVersion: grant.authVersion, scope: grant.scope, expiresAt: new Date(Date.now() + MCP_REFRESH_TOKEN_SECONDS * 1000),
    },
  });
  // Housekeeping: grants a week past their expiry are of no further use.
  await prisma.mcpOAuthGrant.deleteMany({ where: { expiresAt: { lt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } } });
  const accessToken = signMcpAccessToken(
    { sub: grant.userId, authVersion: grant.authVersion, cid: grant.clientId, scope: grant.scope },
    mcpResource(req),
    MCP_ACCESS_TOKEN_SECONDS,
  );
  noStore(res);
  return res.json({ access_token: accessToken, token_type: "Bearer", expires_in: MCP_ACCESS_TOKEN_SECONDS, refresh_token: refreshToken, scope: grant.scope });
}

/** Marks a grant used, exactly once, and only while it is still valid. */
async function consume(id: string): Promise<boolean> {
  const now = new Date();
  const { count } = await prisma.mcpOAuthGrant.updateMany({
    where: { id, usedAt: null, revokedAt: null, expiresAt: { gt: now } },
    data: { usedAt: now },
  });
  return count === 1;
}

async function userStillMatches(userId: string, authVersion: number): Promise<boolean> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { isActive: true, authVersion: true } });
  return Boolean(user?.isActive && user.authVersion === authVersion);
}

mcpOAuthRouter.post("/token", tokenLimiter, async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const text = (key: string) => (typeof body[key] === "string" ? (body[key] as string) : "");
  const clientId = text("client_id");
  const resource = text("resource");
  if (resource && resource !== mcpResource(req)) return oauthError(res, 400, "invalid_target");

  if (text("grant_type") === "authorization_code") {
    const code = text("code");
    const verifier = text("code_verifier");
    if (!code || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return oauthError(res, 400, "invalid_request", "code and a PKCE code_verifier are required.");
    const grant = await prisma.mcpOAuthGrant.findUnique({ where: { tokenHash: sha256(code) } });
    if (!grant || grant.kind !== "code") return oauthError(res, 400, "invalid_grant");
    if (grant.usedAt) {
      // A code presented twice may have been intercepted: end what it produced.
      await revokeChain(grant.clientId, grant.userId);
      return oauthError(res, 400, "invalid_grant");
    }
    if (grant.clientId !== clientId || grant.redirectUri !== text("redirect_uri") || !grant.codeChallenge || !pkceMatches(verifier, grant.codeChallenge)) {
      return oauthError(res, 400, "invalid_grant");
    }
    if (!(await consume(grant.id))) return oauthError(res, 400, "invalid_grant");
    if (!(await userStillMatches(grant.userId, grant.authVersion))) return oauthError(res, 400, "invalid_grant");
    return issueTokens(req, res, grant);
  }

  if (text("grant_type") === "refresh_token") {
    const grant = await prisma.mcpOAuthGrant.findUnique({ where: { tokenHash: sha256(text("refresh_token")) } });
    if (!grant || grant.kind !== "refresh" || grant.clientId !== clientId) return oauthError(res, 400, "invalid_grant");
    if (grant.usedAt) {
      // A rotated refresh token came back: someone else holds a copy.
      await revokeChain(grant.clientId, grant.userId);
      return oauthError(res, 400, "invalid_grant");
    }
    // A refresh may narrow the grant, never widen it (RFC 6749 §6): a
    // connection approved for reading cannot turn itself into a writer.
    const asked = text("scope") ? parseScopes(text("scope")) : undefined;
    const held = parseScopes(grant.scope);
    if (asked && asked.some((entry) => !held.includes(entry))) return oauthError(res, 400, "invalid_scope", "A refresh cannot add scopes. Approve the connection again.");
    if (!(await consume(grant.id))) return oauthError(res, 400, "invalid_grant");
    if (!(await userStillMatches(grant.userId, grant.authVersion))) return oauthError(res, 400, "invalid_grant");
    return issueTokens(req, res, asked ? { ...grant, scope: scopeString([MCP_READ_SCOPE, ...asked]) } : grant);
  }

  return oauthError(res, 400, "unsupported_grant_type");
});
