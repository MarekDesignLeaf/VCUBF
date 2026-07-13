export const GOOGLE_PHOTOS_PICKER_SCOPE = "https://www.googleapis.com/auth/photospicker.mediaitems.readonly";

const AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN = "https://oauth2.googleapis.com/token";
const REVOKE = "https://oauth2.googleapis.com/revoke";
const PICKER_API = "https://photospicker.googleapis.com/v1";

export interface StoredGooglePhotosCredential {
  accessToken: string;
  refreshToken: string;
  scopes: string[];
  tokenType: string;
  expiresAt: string;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}

export interface GooglePhotosPickerSession {
  id?: string;
  pickerUri?: string;
  expireTime?: string;
  mediaItemsSet?: boolean;
  pollingConfig?: { pollInterval?: string; timeoutIn?: string };
}

export interface GooglePhotosPickedMediaItem {
  id?: string;
  createTime?: string;
  type?: "PHOTO" | "VIDEO" | "TYPE_UNSPECIFIED" | string;
  mediaFile?: {
    // Google explicitly documents baseUrl as a byte-download URL. The
    // connector deliberately ignores it and stores metadata only.
    baseUrl?: string;
    mimeType?: string;
    filename?: string;
    mediaFileMetadata?: { width?: number; height?: number };
  };
}

export class GooglePhotosAdapterError extends Error {
  constructor(public readonly code:
    | "CONNECTOR_CONFIGURATION_MISSING"
    | "OAUTH_PROVIDER_REJECTED"
    | "CONNECTOR_AUTHORIZATION_REQUIRED"
    | "SCOPE_DENIED"
    | "RATE_LIMITED"
    | "PROVIDER_UNAVAILABLE"
    | "GOOGLE_PHOTOS_ACCOUNT_REQUIRED"
    | "PICKER_SESSION_NOT_FOUND"
    | "PICKER_SESSION_INCOMPLETE"
    | "PROVIDER_RESPONSE_INVALID",
    message = code,
  ) {
    super(message);
  }
}

function config() {
  const clientId = process.env.GOOGLE_PHOTOS_OAUTH_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_PHOTOS_OAUTH_CLIENT_SECRET?.trim();
  const redirectUri = process.env.GOOGLE_PHOTOS_OAUTH_REDIRECT_URI?.trim();
  if (!clientId || !clientSecret || !redirectUri) throw new GooglePhotosAdapterError("CONNECTOR_CONFIGURATION_MISSING");
  try {
    const url = new URL(redirectUri);
    if (!["http:", "https:"].includes(url.protocol) || (url.protocol === "http:" && !["localhost", "127.0.0.1", "::1"].includes(url.hostname))) throw new Error("unsafe redirect");
  } catch {
    throw new GooglePhotosAdapterError("CONNECTOR_CONFIGURATION_MISSING");
  }
  return { clientId, clientSecret, redirectUri };
}

const scopes = (value?: string) => [...new Set((value ?? "").split(/\s+/).filter(Boolean))];

function credential(response: TokenResponse, oldRefreshToken?: string): StoredGooglePhotosCredential {
  const granted = scopes(response.scope);
  if (!response.access_token || !response.expires_in || response.expires_in <= 0) throw new GooglePhotosAdapterError("OAUTH_PROVIDER_REJECTED");
  if (granted.length !== 1 || granted[0] !== GOOGLE_PHOTOS_PICKER_SCOPE) throw new GooglePhotosAdapterError("SCOPE_DENIED");
  const refreshToken = response.refresh_token ?? oldRefreshToken;
  if (!refreshToken) throw new GooglePhotosAdapterError("CONNECTOR_AUTHORIZATION_REQUIRED");
  return {
    accessToken: response.access_token,
    refreshToken,
    scopes: granted,
    tokenType: response.token_type ?? "Bearer",
    expiresAt: new Date(Date.now() + response.expires_in * 1000).toISOString(),
  };
}

async function token(body: URLSearchParams) {
  let response: Response;
  try {
    response = await fetch(TOKEN, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  } catch {
    throw new GooglePhotosAdapterError("PROVIDER_UNAVAILABLE");
  }
  if (!response.ok) {
    if (response.status === 429) throw new GooglePhotosAdapterError("RATE_LIMITED");
    if (response.status >= 500) throw new GooglePhotosAdapterError("PROVIDER_UNAVAILABLE");
    throw new GooglePhotosAdapterError("OAUTH_PROVIDER_REJECTED");
  }
  try {
    return await response.json() as TokenResponse;
  } catch {
    throw new GooglePhotosAdapterError("PROVIDER_RESPONSE_INVALID");
  }
}

export function buildGooglePhotosAuthorizationUrl(state: string) {
  const current = config();
  const url = new URL(AUTH);
  url.search = new URLSearchParams({
    client_id: current.clientId,
    redirect_uri: current.redirectUri,
    response_type: "code",
    scope: GOOGLE_PHOTOS_PICKER_SCOPE,
    access_type: "offline",
    prompt: "consent",
    state,
  }).toString();
  return url.toString();
}

export async function exchangeGooglePhotosAuthorizationCode(code: string, oldRefreshToken?: string) {
  const current = config();
  return credential(await token(new URLSearchParams({
    client_id: current.clientId,
    client_secret: current.clientSecret,
    code,
    grant_type: "authorization_code",
    redirect_uri: current.redirectUri,
  })), oldRefreshToken);
}

export async function refreshGooglePhotosCredential(value: StoredGooglePhotosCredential) {
  const current = config();
  const response = await token(new URLSearchParams({
    client_id: current.clientId,
    client_secret: current.clientSecret,
    refresh_token: value.refreshToken,
    grant_type: "refresh_token",
  }));
  if (!response.scope) response.scope = value.scopes.join(" ");
  return credential(response, value.refreshToken);
}

function pickerError(response: Response, precondition: "GOOGLE_PHOTOS_ACCOUNT_REQUIRED" | "PICKER_SESSION_INCOMPLETE") {
  if (response.status === 401) return new GooglePhotosAdapterError("CONNECTOR_AUTHORIZATION_REQUIRED");
  if (response.status === 403) return new GooglePhotosAdapterError("SCOPE_DENIED");
  if (response.status === 404) return new GooglePhotosAdapterError("PICKER_SESSION_NOT_FOUND");
  if (response.status === 412) return new GooglePhotosAdapterError(precondition);
  if (response.status === 429) return new GooglePhotosAdapterError("RATE_LIMITED");
  if (response.status >= 500) return new GooglePhotosAdapterError("PROVIDER_UNAVAILABLE");
  return new GooglePhotosAdapterError("PROVIDER_RESPONSE_INVALID");
}

async function pickerRequest<T>(
  path: string,
  accessToken: string,
  init: RequestInit,
  precondition: "GOOGLE_PHOTOS_ACCOUNT_REQUIRED" | "PICKER_SESSION_INCOMPLETE",
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${PICKER_API}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${accessToken}`, ...(init.headers ?? {}) },
    });
  } catch {
    throw new GooglePhotosAdapterError("PROVIDER_UNAVAILABLE");
  }
  if (!response.ok) throw pickerError(response, precondition);
  try {
    return await response.json() as T;
  } catch {
    throw new GooglePhotosAdapterError("PROVIDER_RESPONSE_INVALID");
  }
}

export async function createGooglePhotosPickerSession(accessToken: string, requestId: string, maxItemCount = 20) {
  const session = await pickerRequest<GooglePhotosPickerSession>(
    `/sessions?${new URLSearchParams({ requestId }).toString()}`,
    accessToken,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pickingConfig: { maxItemCount: String(Math.max(1, Math.min(20, maxItemCount))) } }) },
    "GOOGLE_PHOTOS_ACCOUNT_REQUIRED",
  );
  if (!session.id || !session.pickerUri) throw new GooglePhotosAdapterError("PROVIDER_RESPONSE_INVALID");
  try {
    const url = new URL(session.pickerUri);
    if (url.protocol !== "https:") throw new Error("unsafe picker URI");
  } catch {
    throw new GooglePhotosAdapterError("PROVIDER_RESPONSE_INVALID");
  }
  return session;
}

export async function getGooglePhotosPickerSession(accessToken: string, sessionId: string) {
  const session = await pickerRequest<GooglePhotosPickerSession>(`/sessions/${encodeURIComponent(sessionId)}`, accessToken, { method: "GET" }, "PICKER_SESSION_INCOMPLETE");
  if (!session.id) throw new GooglePhotosAdapterError("PROVIDER_RESPONSE_INVALID");
  return session;
}

export async function listGooglePhotosPickerMediaItems(accessToken: string, sessionId: string) {
  const items: GooglePhotosPickedMediaItem[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 20; page++) {
    const query = new URLSearchParams({ sessionId, pageSize: "100" });
    if (pageToken) query.set("pageToken", pageToken);
    const response = await pickerRequest<{ mediaItems?: GooglePhotosPickedMediaItem[]; nextPageToken?: string }>(`/mediaItems?${query.toString()}`, accessToken, { method: "GET" }, "PICKER_SESSION_INCOMPLETE");
    items.push(...(response.mediaItems ?? []));
    if (!response.nextPageToken) return items;
    pageToken = response.nextPageToken;
  }
  throw new GooglePhotosAdapterError("PROVIDER_RESPONSE_INVALID");
}

export async function deleteGooglePhotosPickerSession(accessToken: string, sessionId: string) {
  let response: Response;
  try {
    response = await fetch(`${PICKER_API}/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE", headers: { Authorization: `Bearer ${accessToken}` } });
  } catch {
    throw new GooglePhotosAdapterError("PROVIDER_UNAVAILABLE");
  }
  if (!response.ok) throw pickerError(response, "PICKER_SESSION_INCOMPLETE");
}

export async function revokeGooglePhotosCredential(refreshToken: string) {
  let response: Response;
  try {
    response = await fetch(REVOKE, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: refreshToken }) });
  } catch {
    throw new GooglePhotosAdapterError("PROVIDER_UNAVAILABLE");
  }
  if (response.ok) return;
  if (response.status === 429) throw new GooglePhotosAdapterError("RATE_LIMITED");
  if (response.status >= 500) throw new GooglePhotosAdapterError("PROVIDER_UNAVAILABLE");
  throw new GooglePhotosAdapterError("OAUTH_PROVIDER_REJECTED");
}
