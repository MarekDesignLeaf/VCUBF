export const GOOGLE_CALENDAR_READONLY_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
// Creating, moving and cancelling events. Requested only when the source is
// configured with the logical scope write:events; reading the calendar list
// still needs the read-only scope beside it.
export const GOOGLE_CALENDAR_EVENTS_SCOPE = "https://www.googleapis.com/auth/calendar.events";
const WRITE_TIMEOUT_MS = 15_000;
const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
const API_ROOT = "https://www.googleapis.com/calendar/v3";

export interface StoredGoogleCalendarCredential { accessToken: string; refreshToken: string; scopes: string[]; tokenType: string; expiresAt: string }
interface TokenResponse { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; token_type?: string }
export interface CalendarListEntry { id?: string; summary?: string; description?: string; timeZone?: string; accessRole?: string; primary?: boolean; deleted?: boolean }
export interface CalendarListResponse { items?: CalendarListEntry[]; nextPageToken?: string; nextSyncToken?: string }
export interface EventDateTime { date?: string; dateTime?: string; timeZone?: string }
export interface GoogleCalendarEvent {
  id?: string; etag?: string; status?: string; summary?: string; description?: string; location?: string;
  start?: EventDateTime; end?: EventDateTime; organizer?: { email?: string };
  attendees?: Array<{ email?: string }>; transparency?: string; visibility?: string;
  recurringEventId?: string; htmlLink?: string; recurrence?: string[];
}
export interface EventListResponse { items?: GoogleCalendarEvent[]; nextPageToken?: string; nextSyncToken?: string }

export class GoogleCalendarAdapterError extends Error {
  constructor(public readonly code: "CONNECTOR_CONFIGURATION_MISSING" | "OAUTH_PROVIDER_REJECTED" | "CONNECTOR_AUTHORIZATION_REQUIRED" | "SCOPE_DENIED" | "RATE_LIMITED" | "PROVIDER_UNAVAILABLE" | "SYNC_TOKEN_EXPIRED" | "PROVIDER_RESPONSE_INVALID" | "CALENDAR_EVENT_NOT_FOUND" | "CALENDAR_EVENT_CHANGED" | "CALENDAR_EVENT_ALREADY_EXISTS", message = code) { super(message); }
}

function config() {
  const clientId = process.env.GOOGLE_CALENDAR_OAUTH_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET?.trim();
  const redirectUri = process.env.GOOGLE_CALENDAR_OAUTH_REDIRECT_URI?.trim();
  if (!clientId || !clientSecret || !redirectUri) throw new GoogleCalendarAdapterError("CONNECTOR_CONFIGURATION_MISSING");
  try {
    const url = new URL(redirectUri);
    if (!["http:", "https:"].includes(url.protocol) || (url.protocol === "http:" && !["localhost", "127.0.0.1", "::1"].includes(url.hostname))) throw new Error();
  } catch { throw new GoogleCalendarAdapterError("CONNECTOR_CONFIGURATION_MISSING"); }
  return { clientId, clientSecret, redirectUri };
}
function scopes(value?: string) { return [...new Set((value ?? "").split(/\s+/).filter(Boolean))]; }
/** Provider scopes for the logical scopes a source is configured with. */
export function googleCalendarProviderScopes(logicalScopes: string[]) {
  const requested: string[] = [];
  if (logicalScopes.includes("read:calendar")) requested.push(GOOGLE_CALENDAR_READONLY_SCOPE);
  if (logicalScopes.includes("write:events")) requested.push(GOOGLE_CALENDAR_EVENTS_SCOPE);
  return requested;
}
function sameScopes(actual: string[], expected: string[]) { return actual.length === expected.length && actual.every((scope) => expected.includes(scope)); }
function credential(response: TokenResponse, expectedScopes: string[], oldRefresh?: string): StoredGoogleCalendarCredential {
  const granted = scopes(response.scope);
  if (!response.access_token || !response.expires_in || response.expires_in <= 0) throw new GoogleCalendarAdapterError("OAUTH_PROVIDER_REJECTED");
  // Exactly what was asked for: never less (a feature would silently fail),
  // never more (Secretary must not hold access nobody approved).
  if (!expectedScopes.length || !sameScopes(granted, expectedScopes)) throw new GoogleCalendarAdapterError("SCOPE_DENIED");
  const refreshToken = response.refresh_token ?? oldRefresh;
  if (!refreshToken) throw new GoogleCalendarAdapterError("CONNECTOR_AUTHORIZATION_REQUIRED");
  return { accessToken: response.access_token, refreshToken, scopes: granted, tokenType: response.token_type ?? "Bearer", expiresAt: new Date(Date.now() + response.expires_in * 1000).toISOString() };
}
async function tokenRequest(body: URLSearchParams) {
  let response: Response;
  try { response = await fetch(TOKEN_ENDPOINT, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body }); }
  catch { throw new GoogleCalendarAdapterError("PROVIDER_UNAVAILABLE"); }
  if (!response.ok) {
    if (response.status === 429) throw new GoogleCalendarAdapterError("RATE_LIMITED");
    if (response.status >= 500) throw new GoogleCalendarAdapterError("PROVIDER_UNAVAILABLE");
    throw new GoogleCalendarAdapterError("OAUTH_PROVIDER_REJECTED");
  }
  try { return await response.json() as TokenResponse; } catch { throw new GoogleCalendarAdapterError("PROVIDER_RESPONSE_INVALID"); }
}
export function buildGoogleCalendarAuthorizationUrl(state: string, logicalScopes: string[] = ["read:calendar"]) {
  const c = config(); const url = new URL(AUTH_ENDPOINT); const requested = googleCalendarProviderScopes(logicalScopes);
  if (!requested.length) throw new GoogleCalendarAdapterError("SCOPE_DENIED");
  url.search = new URLSearchParams({ client_id: c.clientId, redirect_uri: c.redirectUri, response_type: "code", scope: requested.join(" "), access_type: "offline", prompt: "consent", state }).toString();
  return url.toString();
}
export async function exchangeGoogleCalendarAuthorizationCode(code: string, logicalScopes: string[], oldRefresh?: string) {
  const c = config(); return credential(await tokenRequest(new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, code, grant_type: "authorization_code", redirect_uri: c.redirectUri })), googleCalendarProviderScopes(logicalScopes), oldRefresh);
}
export async function refreshGoogleCalendarCredential(value: StoredGoogleCalendarCredential) {
  const c = config(); const response = await tokenRequest(new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, refresh_token: value.refreshToken, grant_type: "refresh_token" }));
  // A refresh keeps exactly the access that was granted at consent.
  const stored = value.scopes?.length ? value.scopes : [GOOGLE_CALENDAR_READONLY_SCOPE];
  if (!response.scope) response.scope = stored.join(" "); return credential(response, stored, value.refreshToken);
}
async function apiJson<T>(url: URL, accessToken: string): Promise<T> {
  let response: Response;
  try { response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } }); }
  catch { throw new GoogleCalendarAdapterError("PROVIDER_UNAVAILABLE"); }
  if (!response.ok) {
    if (response.status === 410) throw new GoogleCalendarAdapterError("SYNC_TOKEN_EXPIRED");
    if (response.status === 401) throw new GoogleCalendarAdapterError("CONNECTOR_AUTHORIZATION_REQUIRED");
    if (response.status === 403) throw new GoogleCalendarAdapterError("SCOPE_DENIED");
    if (response.status === 429) throw new GoogleCalendarAdapterError("RATE_LIMITED");
    throw new GoogleCalendarAdapterError("PROVIDER_UNAVAILABLE");
  }
  try { return await response.json() as T; } catch { throw new GoogleCalendarAdapterError("PROVIDER_RESPONSE_INVALID"); }
}
export function listGoogleCalendars(accessToken: string, input: { syncToken?: string; pageToken?: string }) {
  const url = new URL(`${API_ROOT}/users/me/calendarList`); url.searchParams.set("maxResults", "250"); url.searchParams.set("showDeleted", "true");
  if (input.syncToken) url.searchParams.set("syncToken", input.syncToken); if (input.pageToken) url.searchParams.set("pageToken", input.pageToken);
  return apiJson<CalendarListResponse>(url, accessToken);
}
export function listGoogleCalendarEvents(accessToken: string, calendarId: string, input: { syncToken?: string; pageToken?: string }) {
  const url = new URL(`${API_ROOT}/calendars/${encodeURIComponent(calendarId)}/events`); url.searchParams.set("maxResults", "500"); url.searchParams.set("showDeleted", "true"); url.searchParams.set("singleEvents", "false");
  if (input.syncToken) url.searchParams.set("syncToken", input.syncToken); if (input.pageToken) url.searchParams.set("pageToken", input.pageToken);
  return apiJson<EventListResponse>(url, accessToken);
}
export async function revokeGoogleCalendarCredential(refreshToken: string) {
  let response: Response; try { response = await fetch(REVOKE_ENDPOINT, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: refreshToken }) }); }
  catch { throw new GoogleCalendarAdapterError("PROVIDER_UNAVAILABLE"); }
  if (response.ok) return; if (response.status === 429) throw new GoogleCalendarAdapterError("RATE_LIMITED"); if (response.status >= 500) throw new GoogleCalendarAdapterError("PROVIDER_UNAVAILABLE"); throw new GoogleCalendarAdapterError("OAUTH_PROVIDER_REJECTED");
}


// --- Writing events -------------------------------------------------------
// Event writes carry their own status mapping: on these endpoints 404 and 410
// mean the event is gone and 412 means it changed since it was reviewed, not
// that a sync token expired.
async function apiWrite<T>(method: "POST" | "PATCH" | "DELETE" | "GET", url: URL, accessToken: string, body?: unknown, etag?: string): Promise<T | undefined> {
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(etag ? { "If-Match": etag } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
    });
  } catch { throw new GoogleCalendarAdapterError("PROVIDER_UNAVAILABLE"); }
  if (!response.ok) {
    if (response.status === 401) throw new GoogleCalendarAdapterError("CONNECTOR_AUTHORIZATION_REQUIRED");
    if (response.status === 403) throw new GoogleCalendarAdapterError("SCOPE_DENIED");
    if (response.status === 404 || response.status === 410) throw new GoogleCalendarAdapterError("CALENDAR_EVENT_NOT_FOUND");
    if (response.status === 409) throw new GoogleCalendarAdapterError("CALENDAR_EVENT_ALREADY_EXISTS");
    if (response.status === 412) throw new GoogleCalendarAdapterError("CALENDAR_EVENT_CHANGED");
    if (response.status === 429) throw new GoogleCalendarAdapterError("RATE_LIMITED");
    if (response.status >= 500) throw new GoogleCalendarAdapterError("PROVIDER_UNAVAILABLE");
    throw new GoogleCalendarAdapterError("PROVIDER_RESPONSE_INVALID");
  }
  if (method === "DELETE" || response.status === 204) return undefined;
  try { return await response.json() as T; } catch { throw new GoogleCalendarAdapterError("PROVIDER_RESPONSE_INVALID"); }
}
function eventUrl(calendarId: string, eventId?: string) {
  const url = new URL(`${API_ROOT}/calendars/${encodeURIComponent(calendarId)}/events${eventId ? `/${encodeURIComponent(eventId)}` : ""}`);
  // Nobody else is emailed by Secretary's calendar writes.
  url.searchParams.set("sendUpdates", "none");
  return url;
}
export interface GoogleCalendarEventWrite { id?: string; summary?: string; description?: string; location?: string; start?: EventDateTime; end?: EventDateTime }
export async function getGoogleCalendarEvent(accessToken: string, calendarId: string, eventId: string) {
  const url = new URL(`${API_ROOT}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`);
  const event = await apiWrite<GoogleCalendarEvent>("GET", url, accessToken);
  if (!event?.id) throw new GoogleCalendarAdapterError("PROVIDER_RESPONSE_INVALID");
  return event;
}
/** The caller supplies the event id, so a retried insert cannot create a second event. */
export async function insertGoogleCalendarEvent(accessToken: string, calendarId: string, event: GoogleCalendarEventWrite) {
  const created = await apiWrite<GoogleCalendarEvent>("POST", eventUrl(calendarId), accessToken, event);
  if (!created?.id) throw new GoogleCalendarAdapterError("PROVIDER_RESPONSE_INVALID");
  return created;
}
export async function patchGoogleCalendarEvent(accessToken: string, calendarId: string, eventId: string, patch: GoogleCalendarEventWrite, etag: string) {
  const updated = await apiWrite<GoogleCalendarEvent>("PATCH", eventUrl(calendarId, eventId), accessToken, patch, etag);
  if (!updated?.id) throw new GoogleCalendarAdapterError("PROVIDER_RESPONSE_INVALID");
  return updated;
}
export async function deleteGoogleCalendarEvent(accessToken: string, calendarId: string, eventId: string, etag: string) {
  await apiWrite<void>("DELETE", eventUrl(calendarId, eventId), accessToken, undefined, etag);
}
