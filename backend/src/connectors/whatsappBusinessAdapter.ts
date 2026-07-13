import { createHmac, timingSafeEqual } from "node:crypto";

const GRAPH_ENDPOINT = "https://graph.facebook.com";

export class WhatsAppBusinessAdapterError extends Error {
  constructor(
    public readonly code:
      | "CONNECTOR_CONFIGURATION_MISSING"
      | "CONNECTOR_AUTHORIZATION_REQUIRED"
      | "SCOPE_DENIED"
      | "RATE_LIMITED"
      | "PROVIDER_UNAVAILABLE"
      | "PROVIDER_RESPONSE_INVALID"
      | "WEBHOOK_VERIFICATION_FAILED"
      | "WEBHOOK_SIGNATURE_INVALID",
    message: string = code
  ) {
    super(message);
  }
}

interface WhatsAppConfig {
  apiVersion: string;
  phoneNumberId: string;
  businessAccountId: string;
  accessToken: string;
  webhookVerifyToken: string;
  appSecret: string;
}

function configuredValue(name: string) {
  return process.env[name]?.trim() ?? "";
}

export function whatsAppConfigurationAvailable() {
  return [
    "WHATSAPP_GRAPH_API_VERSION",
    "WHATSAPP_PHONE_NUMBER_ID",
    "WHATSAPP_BUSINESS_ACCOUNT_ID",
    "WHATSAPP_ACCESS_TOKEN",
    "WHATSAPP_WEBHOOK_VERIFY_TOKEN",
    "META_APP_SECRET",
  ].every((name) => Boolean(configuredValue(name)));
}

function whatsAppConfig(): WhatsAppConfig {
  const config = {
    apiVersion: configuredValue("WHATSAPP_GRAPH_API_VERSION"),
    phoneNumberId: configuredValue("WHATSAPP_PHONE_NUMBER_ID"),
    businessAccountId: configuredValue("WHATSAPP_BUSINESS_ACCOUNT_ID"),
    accessToken: configuredValue("WHATSAPP_ACCESS_TOKEN"),
    webhookVerifyToken: configuredValue("WHATSAPP_WEBHOOK_VERIFY_TOKEN"),
    appSecret: configuredValue("META_APP_SECRET"),
  };
  if (!Object.values(config).every(Boolean)) throw new WhatsAppBusinessAdapterError("CONNECTOR_CONFIGURATION_MISSING");
  if (!/^v\d+\.\d+$/.test(config.apiVersion) || !/^\d+$/.test(config.phoneNumberId) || !/^\d+$/.test(config.businessAccountId)) {
    throw new WhatsAppBusinessAdapterError("CONNECTOR_CONFIGURATION_MISSING");
  }
  return config;
}

export function configuredWhatsAppPhoneNumberId() {
  return whatsAppConfig().phoneNumberId;
}

function equalSecret(actual: string, expected: string) {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function verifyWhatsAppWebhookChallenge(input: { mode?: string; token?: string; challenge?: string }) {
  const config = whatsAppConfig();
  if (input.mode !== "subscribe" || !input.token || !equalSecret(input.token, config.webhookVerifyToken) || !input.challenge) {
    throw new WhatsAppBusinessAdapterError("WEBHOOK_VERIFICATION_FAILED");
  }
  return input.challenge;
}

export function verifyWhatsAppWebhookSignature(rawBody: Buffer, signatureHeader?: string) {
  const config = whatsAppConfig();
  if (!signatureHeader?.startsWith("sha256=")) throw new WhatsAppBusinessAdapterError("WEBHOOK_SIGNATURE_INVALID");
  const expected = `sha256=${createHmac("sha256", config.appSecret).update(rawBody).digest("hex")}`;
  if (!equalSecret(signatureHeader, expected)) throw new WhatsAppBusinessAdapterError("WEBHOOK_SIGNATURE_INVALID");
}

export interface WhatsAppInboundMessage {
  id: string;
  from: string;
  senderName: string | null;
  messageText: string;
  receivedAt: Date;
  messageType: string;
  phoneNumberId: string;
}

export interface WhatsAppStatusUpdate {
  id: string;
  status: string;
  recipientId: string | null;
  occurredAt: Date;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function messageText(message: Record<string, unknown>, type: string) {
  if (type === "text") return stringValue(record(message.text)?.body);
  if (type === "button") return stringValue(record(message.button)?.text);
  if (type === "interactive") {
    const interactive = record(message.interactive);
    return stringValue(record(interactive?.button_reply)?.title) ?? stringValue(record(interactive?.list_reply)?.title);
  }
  const content = record(message[type]);
  const caption = stringValue(content?.caption);
  return caption ? `[WhatsApp ${type}] ${caption}` : `[WhatsApp ${type}]`;
}

function timestamp(value: unknown) {
  const seconds = typeof value === "string" ? Number(value) : NaN;
  const date = Number.isFinite(seconds) ? new Date(seconds * 1000) : new Date();
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

export function parseWhatsAppWebhook(payload: unknown) {
  const root = record(payload);
  if (!root || root.object !== "whatsapp_business_account" || !Array.isArray(root.entry)) {
    throw new WhatsAppBusinessAdapterError("PROVIDER_RESPONSE_INVALID");
  }
  const messages: WhatsAppInboundMessage[] = [];
  const statuses: WhatsAppStatusUpdate[] = [];
  for (const entryValue of root.entry) {
    const entry = record(entryValue);
    if (!entry || !Array.isArray(entry.changes)) continue;
    for (const changeValue of entry.changes) {
      const change = record(changeValue);
      if (!change || change.field !== "messages") continue;
      const value = record(change.value);
      const metadata = record(value?.metadata);
      const phoneNumberId = stringValue(metadata?.phone_number_id);
      if (!value || !phoneNumberId) continue;
      const names = new Map<string, string>();
      for (const contactValue of Array.isArray(value.contacts) ? value.contacts : []) {
        const contact = record(contactValue);
        const waId = stringValue(contact?.wa_id);
        const name = stringValue(record(contact?.profile)?.name);
        if (waId && name) names.set(waId, name);
      }
      for (const messageValue of Array.isArray(value.messages) ? value.messages : []) {
        const message = record(messageValue);
        const id = stringValue(message?.id);
        const from = stringValue(message?.from);
        const type = stringValue(message?.type) ?? "unknown";
        const text = message ? messageText(message, type) : null;
        if (!id || !from || !text) continue;
        messages.push({ id, from, senderName: names.get(from) ?? null, messageText: text, receivedAt: timestamp(message?.timestamp), messageType: type, phoneNumberId });
      }
      for (const statusValue of Array.isArray(value.statuses) ? value.statuses : []) {
        const status = record(statusValue);
        const id = stringValue(status?.id);
        const state = stringValue(status?.status);
        if (!id || !state) continue;
        statuses.push({ id, status: state, recipientId: stringValue(status?.recipient_id), occurredAt: timestamp(status?.timestamp) });
      }
    }
  }
  return { messages, statuses };
}

export async function sendWhatsAppText(input: { to: string; body: string }) {
  const config = whatsAppConfig();
  let response: Response;
  try {
    response = await fetch(`${GRAPH_ENDPOINT}/${config.apiVersion}/${encodeURIComponent(config.phoneNumberId)}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: input.to.replace(/^\+/, ""),
        type: "text",
        text: { preview_url: false, body: input.body },
      }),
    });
  } catch {
    throw new WhatsAppBusinessAdapterError("PROVIDER_UNAVAILABLE");
  }
  if (!response.ok) {
    if (response.status === 401) throw new WhatsAppBusinessAdapterError("CONNECTOR_AUTHORIZATION_REQUIRED");
    if (response.status === 403) throw new WhatsAppBusinessAdapterError("SCOPE_DENIED");
    if (response.status === 429) throw new WhatsAppBusinessAdapterError("RATE_LIMITED");
    if (response.status >= 500) throw new WhatsAppBusinessAdapterError("PROVIDER_UNAVAILABLE");
    throw new WhatsAppBusinessAdapterError("PROVIDER_RESPONSE_INVALID");
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new WhatsAppBusinessAdapterError("PROVIDER_RESPONSE_INVALID");
  }
  const responseRecord = record(payload);
  const responseMessages = Array.isArray(responseRecord?.messages) ? responseRecord.messages : [];
  const first = record(responseMessages[0]);
  const id = stringValue(first?.id);
  if (!id) throw new WhatsAppBusinessAdapterError("PROVIDER_RESPONSE_INVALID");
  return { messageId: id, phoneNumberId: config.phoneNumberId, businessAccountId: config.businessAccountId };
}
