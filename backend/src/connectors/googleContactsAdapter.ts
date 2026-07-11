export const GOOGLE_CONTACTS_READONLY_SCOPE = "https://www.googleapis.com/auth/contacts.readonly";
const GOOGLE_AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
const CONNECTIONS_ENDPOINT = "https://people.googleapis.com/v1/people/me/connections";
const PERSON_FIELDS = "names,emailAddresses,phoneNumbers,organizations,metadata";
const PAGE_SIZE = 500;

export interface StoredGoogleContactsCredential {
  accessToken: string;
  refreshToken: string;
  scopes: string[];
  tokenType: string;
  expiresAt: string;
}

interface GoogleTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}

interface PersonFieldMetadata { primary?: boolean }
interface PersonName { displayName?: string; metadata?: PersonFieldMetadata }
interface PersonValue { value?: string; metadata?: PersonFieldMetadata }
interface PersonOrganisation {
  name?: string;
  title?: string;
  department?: string;
  metadata?: PersonFieldMetadata;
}

export interface GooglePerson {
  resourceName?: string;
  etag?: string;
  metadata?: { deleted?: boolean };
  names?: PersonName[];
  emailAddresses?: PersonValue[];
  phoneNumbers?: PersonValue[];
  organizations?: PersonOrganisation[];
}

export interface GoogleConnectionsList {
  connections?: GooglePerson[];
  nextPageToken?: string;
  nextSyncToken?: string;
  totalItems?: number;
}

export interface ParsedGoogleContact {
  externalResourceName: string;
  sourceEtag: string | null;
  displayName: string | null;
  email: string | null;
  phone: string | null;
  organisation: string | null;
  jobTitle: string | null;
  department: string | null;
  isDeleted: boolean;
}

export class GoogleContactsAdapterError extends Error {
  constructor(
    public readonly code:
      | "CONNECTOR_CONFIGURATION_MISSING"
      | "OAUTH_PROVIDER_REJECTED"
      | "CONNECTOR_AUTHORIZATION_REQUIRED"
      | "SCOPE_DENIED"
      | "RATE_LIMITED"
      | "PROVIDER_UNAVAILABLE"
      | "SYNC_TOKEN_EXPIRED"
      | "PROVIDER_RESPONSE_INVALID",
    message: string = code
  ) {
    super(message);
  }
}

function oauthConfig() {
  const clientId = process.env.GOOGLE_CONTACTS_OAUTH_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CONTACTS_OAUTH_CLIENT_SECRET?.trim();
  const redirectUri = process.env.GOOGLE_CONTACTS_OAUTH_REDIRECT_URI?.trim();
  if (!clientId || !clientSecret || !redirectUri) throw new GoogleContactsAdapterError("CONNECTOR_CONFIGURATION_MISSING");
  try {
    const parsed = new URL(redirectUri);
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Invalid protocol");
    if (parsed.protocol === "http:" && !["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)) {
      throw new Error("HTTPS is required outside loopback development");
    }
  } catch {
    throw new GoogleContactsAdapterError("CONNECTOR_CONFIGURATION_MISSING");
  }
  return { clientId, clientSecret, redirectUri };
}

function scopesFrom(value?: string) {
  return [...new Set((value ?? "").split(/\s+/).filter(Boolean))];
}

function credentialFrom(response: GoogleTokenResponse, existingRefreshToken?: string): StoredGoogleContactsCredential {
  const scopes = scopesFrom(response.scope);
  if (!response.access_token || !response.expires_in || response.expires_in <= 0) {
    throw new GoogleContactsAdapterError("OAUTH_PROVIDER_REJECTED");
  }
  if (scopes.length !== 1 || scopes[0] !== GOOGLE_CONTACTS_READONLY_SCOPE) {
    throw new GoogleContactsAdapterError("SCOPE_DENIED", "Google did not grant exactly the required contacts read-only scope.");
  }
  const refreshToken = response.refresh_token ?? existingRefreshToken;
  if (!refreshToken) throw new GoogleContactsAdapterError("CONNECTOR_AUTHORIZATION_REQUIRED");
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
    throw new GoogleContactsAdapterError("PROVIDER_UNAVAILABLE");
  }
  if (!response.ok) {
    if (response.status === 429) throw new GoogleContactsAdapterError("RATE_LIMITED");
    if (response.status >= 500) throw new GoogleContactsAdapterError("PROVIDER_UNAVAILABLE");
    throw new GoogleContactsAdapterError("OAUTH_PROVIDER_REJECTED");
  }
  try {
    return (await response.json()) as GoogleTokenResponse;
  } catch {
    throw new GoogleContactsAdapterError("PROVIDER_RESPONSE_INVALID");
  }
}

export function buildGoogleContactsAuthorizationUrl(state: string) {
  const config = oauthConfig();
  const url = new URL(GOOGLE_AUTHORIZATION_ENDPOINT);
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: GOOGLE_CONTACTS_READONLY_SCOPE,
    access_type: "offline",
    prompt: "consent",
    state,
  }).toString();
  return url.toString();
}

export async function exchangeGoogleContactsAuthorizationCode(code: string, existingRefreshToken?: string) {
  const config = oauthConfig();
  return credentialFrom(await tokenRequest(new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code,
    grant_type: "authorization_code",
    redirect_uri: config.redirectUri,
  })), existingRefreshToken);
}

export async function refreshGoogleContactsCredential(credential: StoredGoogleContactsCredential) {
  const config = oauthConfig();
  const response = await tokenRequest(new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: credential.refreshToken,
    grant_type: "refresh_token",
  }));
  if (!response.scope) response.scope = credential.scopes.join(" ");
  return credentialFrom(response, credential.refreshToken);
}

function expiredSyncToken(payload: unknown) {
  if (!payload || typeof payload !== "object") return false;
  const details = (payload as { error?: { details?: Array<{ reason?: string }> } }).error?.details;
  return details?.some((detail) => detail.reason === "EXPIRED_SYNC_TOKEN") ?? false;
}

export async function listGoogleConnections(accessToken: string, input: { syncToken?: string; pageToken?: string }) {
  const url = new URL(CONNECTIONS_ENDPOINT);
  url.searchParams.set("personFields", PERSON_FIELDS);
  url.searchParams.set("sources", "READ_SOURCE_TYPE_CONTACT");
  url.searchParams.set("pageSize", String(PAGE_SIZE));
  url.searchParams.set("requestSyncToken", "true");
  if (input.syncToken) url.searchParams.set("syncToken", input.syncToken);
  if (input.pageToken) url.searchParams.set("pageToken", input.pageToken);
  let response: Response;
  try {
    response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  } catch {
    throw new GoogleContactsAdapterError("PROVIDER_UNAVAILABLE");
  }
  if (!response.ok) {
    let payload: unknown;
    try { payload = await response.json(); } catch { payload = null; }
    if (response.status === 400 && expiredSyncToken(payload)) throw new GoogleContactsAdapterError("SYNC_TOKEN_EXPIRED");
    if (response.status === 401) throw new GoogleContactsAdapterError("CONNECTOR_AUTHORIZATION_REQUIRED");
    if (response.status === 403) throw new GoogleContactsAdapterError("SCOPE_DENIED");
    if (response.status === 429) throw new GoogleContactsAdapterError("RATE_LIMITED");
    throw new GoogleContactsAdapterError("PROVIDER_UNAVAILABLE");
  }
  try {
    return (await response.json()) as GoogleConnectionsList;
  } catch {
    throw new GoogleContactsAdapterError("PROVIDER_RESPONSE_INVALID");
  }
}

export async function revokeGoogleContactsCredential(refreshToken: string) {
  let response: Response;
  try {
    response = await fetch(GOOGLE_REVOKE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: refreshToken }),
    });
  } catch {
    throw new GoogleContactsAdapterError("PROVIDER_UNAVAILABLE");
  }
  if (response.ok) return;
  if (response.status === 429) throw new GoogleContactsAdapterError("RATE_LIMITED");
  if (response.status >= 500) throw new GoogleContactsAdapterError("PROVIDER_UNAVAILABLE");
  throw new GoogleContactsAdapterError("OAUTH_PROVIDER_REJECTED");
}

function primary<T extends { metadata?: PersonFieldMetadata }>(values?: T[]) {
  return values?.find((value) => value.metadata?.primary) ?? values?.[0];
}

export function parseGooglePerson(person: GooglePerson): ParsedGoogleContact {
  if (!person.resourceName) throw new GoogleContactsAdapterError("PROVIDER_RESPONSE_INVALID");
  const organisation = primary(person.organizations);
  return {
    externalResourceName: person.resourceName,
    sourceEtag: person.etag ?? null,
    displayName: primary(person.names)?.displayName?.trim() || null,
    email: primary(person.emailAddresses)?.value?.trim().toLowerCase() || null,
    phone: primary(person.phoneNumbers)?.value?.trim() || null,
    organisation: organisation?.name?.trim() || null,
    jobTitle: organisation?.title?.trim() || null,
    department: organisation?.department?.trim() || null,
    isDeleted: person.metadata?.deleted === true,
  };
}
