export const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const GOOGLE_AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
const GMAIL_MESSAGES_ENDPOINT = "https://gmail.googleapis.com/gmail/v1/users/me/messages";
const GMAIL_HISTORY_ENDPOINT = "https://gmail.googleapis.com/gmail/v1/users/me/history";
const GMAIL_PROFILE_ENDPOINT = "https://gmail.googleapis.com/gmail/v1/users/me/profile";
const MAX_IMPORTED_MESSAGE_CHARS = 100_000;

export interface StoredGmailCredential {
  accessToken: string;
  refreshToken: string;
  scopes: string[];
  tokenType: string;
  expiresAt: string;
}

interface GmailTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}

export interface GmailMessageList {
  messages?: Array<{ id: string; threadId?: string }>;
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

export interface GmailProfile {
  emailAddress?: string;
  messagesTotal?: number;
  threadsTotal?: number;
  historyId?: string;
}

export interface GmailHistoryList {
  history?: Array<{
    id?: string;
    messagesAdded?: Array<{ message?: { id?: string; threadId?: string } }>;
  }>;
  nextPageToken?: string;
  historyId?: string;
}

interface GmailPayloadPart {
  mimeType?: string;
  headers?: Array<{ name?: string; value?: string }>;
  body?: { data?: string };
  parts?: GmailPayloadPart[];
}

export interface GmailMessage {
  id: string;
  threadId?: string;
  historyId?: string;
  internalDate?: string;
  snippet?: string;
  payload?: GmailPayloadPart;
}

export interface ParsedGmailMessage {
  externalMessageId: string;
  externalThreadId: string | null;
  senderName: string | null;
  senderEmail: string | null;
  messageText: string;
  receivedAt: Date;
}

export class GmailAdapterError extends Error {
  constructor(
    public readonly code:
      | "CONNECTOR_CONFIGURATION_MISSING"
      | "OAUTH_PROVIDER_REJECTED"
      | "CONNECTOR_AUTHORIZATION_REQUIRED"
      | "SCOPE_DENIED"
      | "RATE_LIMITED"
      | "PROVIDER_UNAVAILABLE"
      | "HISTORY_CURSOR_EXPIRED"
      | "MESSAGE_NOT_FOUND"
      | "PROVIDER_RESPONSE_INVALID",
    message: string = code
  ) {
    super(message);
  }
}

function oauthConfig() {
  const clientId = process.env.GMAIL_OAUTH_CLIENT_ID?.trim();
  const clientSecret = process.env.GMAIL_OAUTH_CLIENT_SECRET?.trim();
  const redirectUri = process.env.GMAIL_OAUTH_REDIRECT_URI?.trim();
  if (!clientId || !clientSecret || !redirectUri) {
    throw new GmailAdapterError("CONNECTOR_CONFIGURATION_MISSING");
  }
  try {
    const parsed = new URL(redirectUri);
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Invalid protocol");
    if (parsed.protocol === "http:" && !["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)) {
      throw new Error("HTTPS is required outside loopback development");
    }
  } catch {
    throw new GmailAdapterError("CONNECTOR_CONFIGURATION_MISSING");
  }
  return { clientId, clientSecret, redirectUri };
}

function scopesFrom(value?: string) {
  return [...new Set((value ?? "").split(/\s+/).filter(Boolean))];
}

function credentialFromTokenResponse(response: GmailTokenResponse, existingRefreshToken?: string): StoredGmailCredential {
  const scopes = scopesFrom(response.scope);
  if (
    !response.access_token
    || typeof response.expires_in !== "number"
    || !Number.isFinite(response.expires_in)
    || response.expires_in <= 0
  ) {
    throw new GmailAdapterError("OAUTH_PROVIDER_REJECTED");
  }
  if (scopes.length !== 1 || scopes[0] !== GMAIL_READONLY_SCOPE) {
    throw new GmailAdapterError("SCOPE_DENIED", "Google did not grant exactly the required Gmail read-only scope.");
  }
  const refreshToken = response.refresh_token ?? existingRefreshToken;
  if (!refreshToken) throw new GmailAdapterError("CONNECTOR_AUTHORIZATION_REQUIRED", "Google did not return an offline refresh token.");
  return {
    accessToken: response.access_token,
    refreshToken,
    scopes,
    tokenType: response.token_type ?? "Bearer",
    expiresAt: new Date(Date.now() + response.expires_in * 1000).toISOString(),
  };
}

async function tokenRequest(params: URLSearchParams) {
  let response: Response;
  try {
    response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params,
    });
  } catch {
    throw new GmailAdapterError("PROVIDER_UNAVAILABLE");
  }
  if (!response.ok) {
    if (response.status === 429) throw new GmailAdapterError("RATE_LIMITED");
    if (response.status >= 500) throw new GmailAdapterError("PROVIDER_UNAVAILABLE");
    throw new GmailAdapterError("OAUTH_PROVIDER_REJECTED");
  }
  try {
    return (await response.json()) as GmailTokenResponse;
  } catch {
    throw new GmailAdapterError("PROVIDER_RESPONSE_INVALID");
  }
}

export function buildGmailAuthorizationUrl(state: string) {
  const config = oauthConfig();
  const url = new URL(GOOGLE_AUTHORIZATION_ENDPOINT);
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: GMAIL_READONLY_SCOPE,
    access_type: "offline",
    prompt: "consent",
    state,
  }).toString();
  return url.toString();
}

export async function exchangeGmailAuthorizationCode(code: string, existingRefreshToken?: string) {
  const config = oauthConfig();
  const response = await tokenRequest(new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code,
    grant_type: "authorization_code",
    redirect_uri: config.redirectUri,
  }));
  return credentialFromTokenResponse(response, existingRefreshToken);
}

export async function refreshGmailCredential(credential: StoredGmailCredential) {
  const config = oauthConfig();
  const response = await tokenRequest(new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: credential.refreshToken,
    grant_type: "refresh_token",
  }));
  if (!response.scope) response.scope = credential.scopes.join(" ");
  return credentialFromTokenResponse(response, credential.refreshToken);
}

async function gmailJson<T>(
  url: URL,
  accessToken: string,
  requestKind?: "history" | "message"
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  } catch {
    throw new GmailAdapterError("PROVIDER_UNAVAILABLE");
  }
  if (!response.ok) {
    if (response.status === 401) throw new GmailAdapterError("CONNECTOR_AUTHORIZATION_REQUIRED");
    if (response.status === 403) throw new GmailAdapterError("SCOPE_DENIED");
    if (response.status === 429) throw new GmailAdapterError("RATE_LIMITED");
    if (requestKind === "history" && response.status === 404) throw new GmailAdapterError("HISTORY_CURSOR_EXPIRED");
    if (requestKind === "message" && response.status === 404) throw new GmailAdapterError("MESSAGE_NOT_FOUND");
    throw new GmailAdapterError("PROVIDER_UNAVAILABLE");
  }
  try {
    return (await response.json()) as T;
  } catch {
    throw new GmailAdapterError("PROVIDER_RESPONSE_INVALID");
  }
}

export async function listGmailMessages(
  accessToken: string,
  input: { maxResults: number; query?: string; pageToken?: string }
) {
  const url = new URL(GMAIL_MESSAGES_ENDPOINT);
  url.searchParams.set("maxResults", String(input.maxResults));
  if (input.query) url.searchParams.set("q", input.query);
  if (input.pageToken) url.searchParams.set("pageToken", input.pageToken);
  return gmailJson<GmailMessageList>(url, accessToken);
}

export async function getGmailMessage(accessToken: string, id: string) {
  const url = new URL(`${GMAIL_MESSAGES_ENDPOINT}/${encodeURIComponent(id)}`);
  url.searchParams.set("format", "full");
  return gmailJson<GmailMessage>(url, accessToken, "message");
}

export async function getGmailProfile(accessToken: string) {
  return gmailJson<GmailProfile>(new URL(GMAIL_PROFILE_ENDPOINT), accessToken);
}

export async function listGmailHistory(
  accessToken: string,
  input: { startHistoryId: string; maxResults: number; pageToken?: string }
) {
  const url = new URL(GMAIL_HISTORY_ENDPOINT);
  url.searchParams.set("startHistoryId", input.startHistoryId);
  url.searchParams.set("maxResults", String(input.maxResults));
  url.searchParams.append("historyTypes", "messageAdded");
  if (input.pageToken) url.searchParams.set("pageToken", input.pageToken);
  return gmailJson<GmailHistoryList>(url, accessToken, "history");
}

export async function revokeGmailCredential(refreshToken: string) {
  let response: Response;
  try {
    response = await fetch(GOOGLE_REVOKE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: refreshToken }),
    });
  } catch {
    throw new GmailAdapterError("PROVIDER_UNAVAILABLE");
  }
  if (response.ok) return;
  if (response.status === 429) throw new GmailAdapterError("RATE_LIMITED");
  if (response.status >= 500) throw new GmailAdapterError("PROVIDER_UNAVAILABLE");
  throw new GmailAdapterError("OAUTH_PROVIDER_REJECTED");
}

function header(payload: GmailPayloadPart | undefined, name: string) {
  return payload?.headers?.find((item) => item.name?.toLowerCase() === name.toLowerCase())?.value?.trim() ?? "";
}

function decodeBody(data?: string) {
  if (!data) return "";
  try {
    return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8").trim();
  } catch {
    return "";
  }
}

function bodies(part: GmailPayloadPart | undefined, mimeType: string): string[] {
  if (!part) return [];
  const own = part.mimeType?.toLowerCase() === mimeType ? [decodeBody(part.body?.data)].filter(Boolean) : [];
  return [...own, ...(part.parts ?? []).flatMap((child) => bodies(child, mimeType))];
}

function stripHtml(value: string) {
  return value
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function sender(value: string) {
  const match = value.match(/^\s*(?:"?([^"<]*)"?\s*)?<([^<>\s]+@[^<>\s]+)>\s*$/);
  if (match) return { senderName: match[1]?.trim() || null, senderEmail: match[2].toLowerCase() };
  const email = value.match(/[^\s<>]+@[^\s<>]+/)?.[0];
  return { senderName: email ? null : value || null, senderEmail: email?.toLowerCase() ?? null };
}

export function parseGmailMessage(message: GmailMessage): ParsedGmailMessage {
  if (!message.id) throw new GmailAdapterError("PROVIDER_RESPONSE_INVALID");
  const from = sender(header(message.payload, "From"));
  const subject = header(message.payload, "Subject");
  const plain = bodies(message.payload, "text/plain").join("\n\n").trim();
  const html = bodies(message.payload, "text/html").map(stripHtml).join("\n\n").trim();
  const body = plain || html || message.snippet?.trim() || "(No readable message body)";
  const combined = subject ? `Subject: ${subject}\n\n${body}` : body;
  const dateHeader = Date.parse(header(message.payload, "Date"));
  const internalDate = Number(message.internalDate);
  const timestamp = Number.isFinite(dateHeader) ? dateHeader : Number.isFinite(internalDate) ? internalDate : Date.now();
  const receivedAt = new Date(timestamp);
  return {
    externalMessageId: message.id,
    externalThreadId: message.threadId ?? null,
    senderName: from.senderName,
    senderEmail: from.senderEmail,
    messageText: combined.slice(0, MAX_IMPORTED_MESSAGE_CHARS),
    receivedAt: Number.isNaN(receivedAt.getTime()) ? new Date() : receivedAt,
  };
}
