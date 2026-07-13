import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createHmac } from "node:crypto";
import {
  buildGmailAuthorizationUrl,
  buildGmailRawMessage,
  createGmailDraft,
  GMAIL_COMPOSE_SCOPE,
  GMAIL_READONLY_SCOPE,
  gmailProviderScopes,
  sendGmailMessage,
} from "../src/connectors/gmailAdapter.js";
import {
  parseWhatsAppWebhook,
  sendWhatsAppText,
  verifyWhatsAppWebhookChallenge,
  verifyWhatsAppWebhookSignature,
  WhatsAppBusinessAdapterError,
} from "../src/connectors/whatsappBusinessAdapter.js";

const originalFetch = globalThis.fetch;
const savedEnv = { ...process.env };

before(() => {
  process.env.GMAIL_OAUTH_CLIENT_ID = "test-client.apps.googleusercontent.com";
  process.env.GMAIL_OAUTH_CLIENT_SECRET = "test-secret";
  process.env.GMAIL_OAUTH_REDIRECT_URI = "http://localhost:4000/connectors/gmail/oauth/callback";
  process.env.WHATSAPP_GRAPH_API_VERSION = "v99.0";
  process.env.WHATSAPP_PHONE_NUMBER_ID = "123456789";
  process.env.WHATSAPP_BUSINESS_ACCOUNT_ID = "987654321";
  process.env.WHATSAPP_ACCESS_TOKEN = "test-access-token";
  process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = "test-verify-token";
  process.env.META_APP_SECRET = "test-app-secret";
});

after(() => {
  globalThis.fetch = originalFetch;
  for (const name of [
    "GMAIL_OAUTH_CLIENT_ID", "GMAIL_OAUTH_CLIENT_SECRET", "GMAIL_OAUTH_REDIRECT_URI",
    "WHATSAPP_GRAPH_API_VERSION", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_BUSINESS_ACCOUNT_ID",
    "WHATSAPP_ACCESS_TOKEN", "WHATSAPP_WEBHOOK_VERIFY_TOKEN", "META_APP_SECRET",
  ]) {
    const value = savedEnv[name];
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});

describe("Gmail draft and send adapter", () => {
  it("requests the exact provider scopes selected by logical capabilities", () => {
    const scopes = gmailProviderScopes(["read:messages", "write:drafts", "send:messages"]);
    assert.deepEqual(scopes, [GMAIL_READONLY_SCOPE, GMAIL_COMPOSE_SCOPE]);
    const url = new URL(buildGmailAuthorizationUrl("state-value", ["read:messages", "write:drafts", "send:messages"]));
    assert.deepEqual(url.searchParams.get("scope")?.split(" "), scopes);
  });

  it("builds a UTF-8 base64url MIME message without allowing header injection", () => {
    const raw = buildGmailRawMessage({
      to: ["customer@example.com"],
      subject: "Quote\r\nBcc: attacker@example.com",
      body: "Dobrý den\nHello",
    });
    const mime = Buffer.from(raw, "base64url").toString("utf8");
    assert.match(mime, /^To: customer@example\.com\r\nSubject: /);
    assert.ok(!mime.includes("\r\nBcc: attacker@example.com\r\n"));
    assert.ok(mime.endsWith("Dobrý den\r\nHello"));
  });

  it("uses Gmail's draft and send endpoints with raw MIME only", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = async (input, init) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return Response.json(String(input).endsWith("/drafts")
        ? { id: "draft-1", message: { id: "message-draft-1" } }
        : { id: "message-sent-1", threadId: "thread-1" });
    };
    const input = { to: ["customer@example.com"], subject: "Quote", body: "Hello" };
    assert.equal((await createGmailDraft("access-token", input)).id, "draft-1");
    assert.equal((await sendGmailMessage("access-token", input)).id, "message-sent-1");
    assert.equal(calls[0].url, "https://gmail.googleapis.com/gmail/v1/users/me/drafts");
    assert.equal(calls[1].url, "https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
    assert.ok((calls[0].body.message as Record<string, unknown>).raw);
    assert.ok(calls[1].body.raw);
  });
});

describe("WhatsApp Business adapter", () => {
  it("verifies webhook ownership and signed raw payloads", () => {
    assert.equal(verifyWhatsAppWebhookChallenge({ mode: "subscribe", token: "test-verify-token", challenge: "challenge-1" }), "challenge-1");
    const raw = Buffer.from('{"object":"whatsapp_business_account","entry":[]}');
    const signature = `sha256=${createHmac("sha256", "test-app-secret").update(raw).digest("hex")}`;
    assert.doesNotThrow(() => verifyWhatsAppWebhookSignature(raw, signature));
    assert.throws(() => verifyWhatsAppWebhookSignature(raw, "sha256=bad"), (error) =>
      error instanceof WhatsAppBusinessAdapterError && error.code === "WEBHOOK_SIGNATURE_INVALID"
    );
  });

  it("parses inbound text and delivery status without media bytes", () => {
    const result = parseWhatsAppWebhook({
      object: "whatsapp_business_account",
      entry: [{ changes: [{ field: "messages", value: {
        metadata: { phone_number_id: "123456789" },
        contacts: [{ wa_id: "447700900123", profile: { name: "Customer" } }],
        messages: [{ id: "wamid.inbound", from: "447700900123", timestamp: "1767225600", type: "text", text: { body: "Please send a quote" } }],
        statuses: [{ id: "wamid.outbound", status: "delivered", recipient_id: "447700900123", timestamp: "1767225601" }],
      } }] }],
    });
    assert.equal(result.messages[0].senderName, "Customer");
    assert.equal(result.messages[0].messageText, "Please send a quote");
    assert.equal(result.statuses[0].status, "delivered");
  });

  it("sends a confirmed text payload to the configured Cloud API endpoint", async () => {
    globalThis.fetch = async (input, init) => {
      assert.equal(String(input), "https://graph.facebook.com/v99.0/123456789/messages");
      assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer test-access-token");
      const body = JSON.parse(String(init?.body));
      assert.deepEqual(body, {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: "447700900123",
        type: "text",
        text: { preview_url: false, body: "Hello" },
      });
      return Response.json({ messages: [{ id: "wamid.sent" }] });
    };
    assert.equal((await sendWhatsAppText({ to: "+447700900123", body: "Hello" })).messageId, "wamid.sent");
  });
});
