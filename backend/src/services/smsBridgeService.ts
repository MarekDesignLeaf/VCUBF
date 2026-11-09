/**
 * The owner's phone through SMS Bridge (MarekDesignLeaf/sms-bridge-api).
 *
 * SMS Bridge owns the Android phone: its SIM, its SMS store and its
 * notification listener. Secretary does not duplicate any of that; it calls
 * the bridge's existing admin HTTP API with a server-side token and adds its
 * own guarantees on top: the bridge serves exactly one configured Secretary
 * company, every send is a reviewed write (see modules/mcp/phoneTools.ts),
 * and every send carries a request id the bridge de-duplicates on.
 *
 * What the bridge can honestly do, and what this service therefore claims:
 * - SMS: only messages the phone owner synchronised to the bridge are
 *   readable; sending queues one SMS on the phone, which reports sent, failed
 *   or uncertain (taken but not confirmed; the bridge never retries those).
 * - WhatsApp / Messenger: only messages whose notification the phone showed
 *   after notification access was granted. No history, no media, no contact
 *   list, no new chats. A reply goes through the notification's reply action,
 *   so it can fail when the notification is gone, and WhatsApp itself reports
 *   no delivery to the bridge.
 *
 * Configuration (environment, never in code or the database):
 *   SMS_BRIDGE_URL, SMS_BRIDGE_ADMIN_TOKEN (secret), SMS_BRIDGE_COMPANY_ID,
 *   SMS_BRIDGE_DEVICE_ID (optional).
 */
import type { AuthedUser } from "../middleware/auth.js";
import { fail, ok, type ServiceResult } from "./result.js";

export const SMS_BRIDGE_TIMEOUT_MS = 15_000;
export const PHONE_CHAT_CHANNELS = ["whatsapp", "messenger"] as const;
export type PhoneChatChannel = (typeof PHONE_CHAT_CHANNELS)[number];
/** E.164 as the bridge validates it: + and 8 to 15 digits, 9 to 16 characters. */
export const E164 = /^\+[1-9]\d{7,14}$/;
export const SMS_MAX_CHARS = 500;
export const CHAT_REPLY_MAX_CHARS = 2000;

export const PHONE_CHAT_LIMITATION =
  "Only messages whose notification the phone showed after notification access was granted. No earlier history, no media, " +
  "no contact list and no new chats. Replies go through the notification's reply action: they can fail when the notification " +
  "is gone, and WhatsApp reports no delivery.";

export interface SmsBridgeConfig {
  url: string;
  token: string;
  companyId: string;
  deviceId?: string;
}

/** The configuration, or null when the bridge is not set up on this server. */
export function smsBridgeConfig(env: NodeJS.ProcessEnv = process.env): SmsBridgeConfig | null {
  const url = env.SMS_BRIDGE_URL?.trim().replace(/\/+$/, "");
  const token = env.SMS_BRIDGE_ADMIN_TOKEN?.trim();
  const companyId = env.SMS_BRIDGE_COMPANY_ID?.trim();
  if (!url || !token || !companyId) return null;
  if (!/^https:\/\//.test(url) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(url)) return null;
  const deviceId = env.SMS_BRIDGE_DEVICE_ID?.trim() || undefined;
  return { url, token, companyId, ...(deviceId ? { deviceId } : {}) };
}

/** Whether this company may use the phone: configured, and configured for it. */
export function smsBridgeAvailableFor(companyId: string | undefined): boolean {
  const config = smsBridgeConfig();
  return Boolean(config && companyId && config.companyId === companyId);
}

/**
 * A request that failed in the network. `delivered` says whether the bridge
 * may have received it: false only when nothing can have reached it (the
 * connection was refused or the name did not resolve).
 */
export class SmsBridgeNetworkError extends Error {
  constructor(message: string, readonly delivered: boolean) {
    super(message);
  }
}

interface BridgeAnswer {
  status: number;
  body: any;
}

function forCompany(user: AuthedUser): ServiceResult<SmsBridgeConfig> {
  const config = smsBridgeConfig();
  if (!config || config.companyId !== user.companyId) {
    return fail(409, "CONNECTOR_NOT_CONFIGURED", "The owner's phone (SMS Bridge) is not set up for this company.");
  }
  return ok(200, config);
}

/** The system error code of a failed fetch: on the error, its cause, or inside an AggregateError (IPv4 and IPv6 tried). */
export function networkErrorCode(error: unknown): string {
  const seen = new Set<unknown>();
  const queue: unknown[] = [error];
  while (queue.length) {
    const item = queue.shift() as { code?: unknown; cause?: unknown; errors?: unknown[] } | undefined;
    if (!item || typeof item !== "object" || seen.has(item)) continue;
    seen.add(item);
    if (typeof item.code === "string" && /^E[A-Z_]+$|^ERR_|^CERT_|^DEPTH_|^UNABLE_/.test(item.code) && !item.code.startsWith("UND_ERR")) return item.code;
    queue.push(item.cause, ...(Array.isArray(item.errors) ? item.errors : []));
  }
  return "";
}

const NOT_SENT_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ERR_INVALID_URL", "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_VERIFY_LEAF_SIGNATURE"]);

async function bridge(config: SmsBridgeConfig, method: "GET" | "POST", path: string,
  options: { query?: Record<string, string | number | undefined>; body?: unknown } = {}): Promise<BridgeAnswer> {
  const url = new URL(config.url + path);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SMS_BRIDGE_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method,
      headers: { "X-Admin-Token": config.token, Accept: "application/json", ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
      redirect: "error",
    });
    const text = await response.text();
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { detail: text.slice(0, 200) };
    }
    return { status: response.status, body };
  } catch (error) {
    const code = networkErrorCode(error);
    const aborted = (error as Error)?.name === "AbortError";
    // A refused connection or an unknown host cannot have delivered anything;
    // a timeout or a dropped connection might have.
    throw new SmsBridgeNetworkError(aborted ? "SMS Bridge did not answer in time" : `SMS Bridge unreachable (${code || (error as Error).message})`,
      !aborted && NOT_SENT_CODES.has(code) ? false : true);
  } finally {
    clearTimeout(timer);
  }
}

function providerFailure(answer: BridgeAnswer): ServiceResult<never> {
  const detail = typeof answer.body?.detail === "string" ? answer.body.detail : `HTTP ${answer.status}`;
  if (answer.status === 401 || answer.status === 403) return fail(502, "CONNECTOR_AUTHORIZATION_REQUIRED", "SMS Bridge refused Secretary's token.");
  if (answer.status === 429) return fail(429, "RATE_LIMITED", `SMS Bridge: ${detail}`);
  if (answer.status === 422) return fail(400, "VALIDATION_FAILED", `SMS Bridge: ${detail}`);
  if (answer.status === 404) return fail(404, "NOT_FOUND", `SMS Bridge: ${detail}`);
  if (answer.status === 409) return fail(409, "CONFLICT", `SMS Bridge: ${detail}`);
  return fail(502, "PROVIDER_UNAVAILABLE", `SMS Bridge answered ${detail}`);
}

async function read(user: AuthedUser, path: string, query?: Record<string, string | number | undefined>): Promise<ServiceResult<any>> {
  const config = forCompany(user);
  if (!config.ok) return config;
  try {
    const answer = await bridge(config.data, "GET", path, { query: { device_id: config.data.deviceId, ...query } });
    return answer.status >= 200 && answer.status < 300 ? ok(200, answer.body) : providerFailure(answer);
  } catch (error) {
    return fail(502, "PROVIDER_UNAVAILABLE", (error as Error).message);
  }
}

const iso = (seconds: unknown) => (typeof seconds === "number" && seconds > 0 ? new Date(seconds * 1000).toISOString() : null);
// Android SMS dates and notification post times are milliseconds. Bridge
// bookkeeping (last upload, listener heartbeat, send status) uses seconds.
const androidIso = (milliseconds: unknown) => {
  if (typeof milliseconds !== "number" || !Number.isFinite(milliseconds) || milliseconds <= 0) return null;
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};

// ─── Reading ────────────────────────────────────────────────────────────────

export async function phoneStatus(user: AuthedUser): Promise<ServiceResult<unknown>> {
  const status = await read(user, "/api/dashboard/status");
  if (!status.ok) return status;
  const health = await read(user, "/api/phone/health");
  const chats = await read(user, "/api/chat/messages", { limit: 1 });
  const listener = chats.ok ? chats.data?.listener ?? null : null;
  return ok(200, {
    phone_online: Boolean(status.data?.gateway_online),
    last_seen: iso(status.data?.gateway_last_seen),
    device_id: status.data?.device_id ?? null,
    synced_sms_count: status.data?.synced_sms_count ?? null,
    outgoing_sms_by_status: status.data?.message_counts ?? {},
    queued_phone_actions: status.data?.queued_device_actions ?? null,
    health: health.ok ? health.data : null,
    notification_listener: listener ? { enabled: Boolean(listener.enabled), reported_at: iso(listener.reported_at) } : null,
    whatsapp_from_phone: PHONE_CHAT_LIMITATION,
  });
}

export interface SmsFilters {
  address?: string;
  text?: string;
  since?: string;
  until?: string;
  direction?: "in" | "out";
  limit?: number;
  cursor?: string;
}

const androidEpoch = (value?: string) => {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
};

/** Android message_type: 1 inbox (received), 2 sent; the rest (drafts, outbox) are reported as they are. */
const SMS_TYPES: Record<number, string> = { 1: "received", 2: "sent", 3: "draft", 4: "outbox", 5: "failed", 6: "queued" };

export async function readPhoneSms(user: AuthedUser, filters: SmsFilters): Promise<ServiceResult<unknown>> {
  const answer = await read(user, "/api/phone/messages", {
    limit: Math.max(1, Math.min(filters.limit ?? 30, 100)),
    address: filters.address,
    text: filters.text,
    since: androidEpoch(filters.since),
    until: androidEpoch(filters.until),
    message_type: filters.direction === "in" ? 1 : filters.direction === "out" ? 2 : undefined,
    cursor: filters.cursor,
  });
  if (!answer.ok) return answer;
  const data = answer.data ?? {};
  return ok(200, {
    messages: (data.messages ?? []).map((row: any) => ({
      device_sms_id: row.device_sms_id,
      address: row.address,
      text: row.body,
      at: androidIso(row.received_at),
      kind: SMS_TYPES[row.message_type] ?? `type_${row.message_type}`,
      thread_id: row.thread_id ?? null,
    })),
    total: data.total ?? null,
    next_cursor: data.next_cursor ?? null,
    last_upload_at: iso(data.last_upload_at),
    note: "Only SMS the phone owner synchronised to SMS Bridge are visible here.",
  });
}

export async function readPhoneChats(user: AuthedUser, filters: { channel?: PhoneChatChannel; since?: string; limit?: number; cursor?: string }): Promise<ServiceResult<unknown>> {
  const limit = Math.max(1, Math.min(filters.limit ?? 50, 200));
  const answer = await read(user, "/api/chat/messages", { since: androidEpoch(filters.since), limit, cursor: filters.cursor });
  if (!answer.ok) return answer;
  const data = answer.data ?? {};
  const messages = (data.messages ?? [])
    .filter((row: any) => !filters.channel || row.channel === filters.channel)
    .map((row: any) => ({ channel: row.channel, chat: row.chat, sender: row.sender, text: row.text, at: androidIso(row.ts), direction: row.direction, group: Boolean(row.is_group) }));
  return ok(200, {
    messages,
    next_cursor: data.next_cursor ?? null,
    notification_listener: data.listener ? { enabled: Boolean(data.listener.enabled), reported_at: iso(data.listener.reported_at) } : null,
    limitation: PHONE_CHAT_LIMITATION,
  });
}

/** The chat exactly as the phone captured it, if a notification of it exists. */
export async function findPhoneChat(user: AuthedUser, channel: PhoneChatChannel, chat: string): Promise<ServiceResult<{ chat: string; group: boolean } | null>> {
  let cursor: string | undefined;
  for (let page = 0; page < 5; page += 1) {
    const answer = await read(user, "/api/chat/messages", { limit: 200, cursor });
    if (!answer.ok) return answer;
    const hit = (answer.data?.messages ?? []).find((row: any) => row.channel === channel && row.chat === chat);
    if (hit) return ok(200, { chat: hit.chat, group: Boolean(hit.is_group) });
    cursor = answer.data?.next_cursor ?? undefined;
    if (!cursor) break;
  }
  return ok(200, null);
}

// ─── Previews (deterministic: no live counters, so a confirmation compares equal) ──

export function smsSegments(text: string): number {
  const gsm = /^[\x20-\x7E\n\r£¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ¤¡ÄÖÑÜ§¿äöñüà€]*$/.test(text);
  const single = gsm ? 160 : 70;
  const multi = gsm ? 153 : 67;
  return text.length <= single ? 1 : Math.ceil(text.length / multi);
}

export function validateSms(to: unknown, text: unknown): ServiceResult<{ to: string; text: string }> {
  if (typeof to !== "string" || !E164.test(to.trim())) return fail(400, "VALIDATION_FAILED", "to must be an international E.164 number such as +447700900123.");
  if (typeof text !== "string" || !text.trim()) return fail(400, "VALIDATION_FAILED", "text must not be empty.");
  if (text.length > SMS_MAX_CHARS) return fail(400, "VALIDATION_FAILED", `text is limited to ${SMS_MAX_CHARS} characters by SMS Bridge.`);
  return ok(200, { to: to.trim(), text });
}

export async function previewPhoneSms(user: AuthedUser, args: { to: unknown; text: unknown }): Promise<ServiceResult<unknown>> {
  const config = forCompany(user);
  if (!config.ok) return config;
  const valid = validateSms(args.to, args.text);
  if (!valid.ok) return valid;
  return ok(200, {
    channel: "sms",
    from: "the owner's phone SIM (SMS Bridge)",
    device: config.data.deviceId ?? "the bridge's default phone",
    to: valid.data.to,
    text: valid.data.text,
    characters: valid.data.text.length,
    sms_parts: smsSegments(valid.data.text),
    effect: "One SMS is queued on the phone and sent from its SIM. It cannot be recalled once the phone has taken it. The phone reports sent, failed or uncertain.",
  });
}

export async function previewPhoneChatReply(user: AuthedUser, args: { channel: unknown; chat: unknown; text: unknown }): Promise<ServiceResult<unknown>> {
  const config = forCompany(user);
  if (!config.ok) return config;
  if (!PHONE_CHAT_CHANNELS.includes(args.channel as PhoneChatChannel)) return fail(400, "VALIDATION_FAILED", "channel is whatsapp or messenger.");
  if (typeof args.chat !== "string" || !args.chat.trim()) return fail(400, "VALIDATION_FAILED", "chat must be the chat name exactly as list_phone_chat_messages shows it.");
  if (typeof args.text !== "string" || !args.text.trim()) return fail(400, "VALIDATION_FAILED", "text must not be empty.");
  if (args.text.length > CHAT_REPLY_MAX_CHARS) return fail(400, "VALIDATION_FAILED", `text is limited to ${CHAT_REPLY_MAX_CHARS} characters.`);
  const found = await findPhoneChat(user, args.channel as PhoneChatChannel, args.chat);
  if (!found.ok) return found;
  if (!found.data) {
    return fail(404, "PHONE_CHAT_NOT_FOUND", "No captured notification of that chat: the phone can only reply to a chat whose notification it has shown. Use the chat name exactly as list_phone_chat_messages returns it.");
  }
  return ok(200, {
    channel: args.channel,
    route: "the owner's phone, through the chat notification's reply action (not a WhatsApp or Messenger API)",
    device: config.data.deviceId ?? "the bridge's default phone",
    chat: found.data.chat,
    group_chat: found.data.group,
    text: args.text,
    effect: "The phone answers in this chat through its notification. It can fail when the notification is no longer there; WhatsApp and Messenger report no delivery to Secretary.",
  });
}

// ─── Sending (called only after a confirmed preview) ────────────────────────

/** The bridge request id for one confirmation: the same confirmation is the same message. */
export function bridgeRequestId(companyId: string, confirmationId: string): string {
  return `vcubf-${companyId.slice(0, 8)}-${confirmationId}`;
}

export interface BridgeSendOutcome {
  remote_id: string;
  status: string;
  created: boolean;
  request_id: string;
}

export async function sendPhoneSms(user: AuthedUser, args: { to: string; text: string }, requestId: string): Promise<ServiceResult<BridgeSendOutcome>> {
  const config = forCompany(user);
  if (!config.ok) return config;
  const valid = validateSms(args.to, args.text);
  if (!valid.ok) return valid;
  // A network error is thrown, not answered: the caller keeps an outcome it
  // cannot know as unknown and never repeats it by itself.
  const answer = await bridge(config.data, "POST", "/api/send", {
    body: { recipient: valid.data.to, body: valid.data.text, request_id: requestId, ...(config.data.deviceId ? { device_id: config.data.deviceId } : {}) },
  });
  if (answer.status < 200 || answer.status >= 300) return providerFailure(answer);
  const message = answer.body?.message ?? {};
  return ok(202, { remote_id: String(message.id ?? ""), status: String(message.status ?? "queued"), created: Boolean(answer.body?.created), request_id: requestId });
}

export async function replyPhoneChat(user: AuthedUser, args: { channel: PhoneChatChannel; chat: string; text: string }, requestId: string): Promise<ServiceResult<BridgeSendOutcome>> {
  const config = forCompany(user);
  if (!config.ok) return config;
  const answer = await bridge(config.data, "POST", "/api/chat/reply", {
    body: { channel: args.channel, chat: args.chat, text: args.text, request_id: requestId, ...(config.data.deviceId ? { device_id: config.data.deviceId } : {}) },
  });
  if (answer.status < 200 || answer.status >= 300) return providerFailure(answer);
  return ok(202, { remote_id: String(answer.body?.id ?? ""), status: "queued", created: Boolean(answer.body?.created), request_id: requestId });
}

// ─── Status of a sent message ───────────────────────────────────────────────

const SMS_STATE_MEANING: Record<string, string> = {
  pending_approval: "waiting for approval in the SMS Bridge dashboard",
  queued: "waiting for the phone to take it",
  leased: "the phone took it and is sending",
  sent: "the phone reports it sent",
  failed: "the phone reports it failed",
  uncertain: "the phone took it but did not confirm; it may or may not have been sent and is never retried by itself",
  cancelled: "cancelled before the phone took it",
};
const ACTION_STATE_MEANING: Record<string, string> = {
  queued: "waiting for the phone to take it",
  leased: "the phone took it and is replying",
  completed: "the phone reports the reply done through the notification",
  failed: "the phone could not reply (for example the notification was gone)",
  denied: "the phone refused it",
  uncertain: "the phone took it but did not confirm; it may or may not have been sent and is never retried by itself",
};

export async function phoneSmsStatus(user: AuthedUser, remoteId: string): Promise<ServiceResult<unknown>> {
  const answer = await read(user, `/api/messages/${encodeURIComponent(remoteId)}`);
  if (!answer.ok) return answer;
  const status = String(answer.data?.status ?? "unknown");
  return ok(200, { kind: "sms", remote_id: remoteId, status, meaning: SMS_STATE_MEANING[status] ?? status, note: answer.data?.result_note || null, updated_at: iso(answer.data?.updated_at) });
}

export async function phoneChatReplyStatus(user: AuthedUser, remoteId: string): Promise<ServiceResult<unknown>> {
  const answer = await read(user, `/api/chat/reply/${encodeURIComponent(remoteId)}`);
  if (!answer.ok) return answer;
  const status = String(answer.data?.status ?? "unknown");
  return ok(200, { kind: "phone_chat_reply", remote_id: remoteId, status, meaning: ACTION_STATE_MEANING[status] ?? status, note: answer.data?.result || null, updated_at: iso(answer.data?.updated_at) });
}
