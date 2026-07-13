import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createRealtimeClientSession, interpretVoiceRequest } from "../src/services/voiceAssistantService.js";

const originalFetch = globalThis.fetch;
const originalKey = process.env.OPENAI_API_KEY;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalKey;
});

describe("voice assistant interpretation", () => {
  it("requires server-side OpenAI configuration", async () => {
    delete process.env.OPENAI_API_KEY;
    await assert.rejects(
      interpretVoiceRequest({ text: "hello", userName: "Test", language: "en-GB" }),
      /OPENAI_NOT_CONFIGURED/
    );
  });

  it("accepts a strict canonical command result", async () => {
    process.env.OPENAI_API_KEY = "test-only-key";
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.store, false);
      assert.equal(body.text.format.type, "json_schema");
      return new Response(
        JSON.stringify({
          output: [
            {
              content: [
                {
                  text: JSON.stringify({
                    kind: "command",
                    canonical_command: "list clients",
                    message: "I will list the clients.",
                  }),
                },
              ],
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    const result = await interpretVoiceRequest({
      text: "Could you tell me which clients we have?",
      userName: "Test",
      language: "en-GB",
    });
    assert.equal(result.kind, "command");
    assert.equal(result.canonical_command, "list clients");
  });

  it("creates a short-lived realtime client secret without exposing the server key", async () => {
    process.env.OPENAI_API_KEY = "server-only-test-key";
    globalThis.fetch = async (_url, init) => {
      assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer server-only-test-key");
      const body = JSON.parse(String(init?.body));
      assert.equal(body.session.type, "realtime");
      return new Response(JSON.stringify({ value: "ek_test_ephemeral", expires_at: 1234, session: { model: "gpt-realtime-1.5" } }), { status: 200 });
    };
    const session = await createRealtimeClientSession();
    assert.equal(session.clientSecret, "ek_test_ephemeral");
    assert.equal(session.expiresAt, 1234);
  });
});
