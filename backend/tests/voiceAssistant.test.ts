import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createRealtimeClientSession, interpretVoiceRequest, transcribeVoiceAudio } from "../src/services/voiceAssistantService.js";

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
      assert.match(body.instructions, /\/communication-intake/);
      assert.match(body.instructions, /\/invoices/);
      assert.match(body.instructions, /COMPLETE SECRETARY MENU AND SUBTREE CATALOGUE/);
      assert.match(body.instructions, /Client details/);
      assert.match(body.instructions, /never invent UI/i);
      assert.match(body.instructions, /Do not infer a conventional New button/i);
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

  it("transcribes an in-memory WAV without persisting or exposing the server key", async () => {
    process.env.OPENAI_API_KEY = "server-only-test-key";
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), "https://api.openai.com/v1/audio/transcriptions");
      assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer server-only-test-key");
      const form = init?.body as FormData;
      assert.equal(form.get("model"), "gpt-4o-mini-transcribe");
      assert.equal(form.get("language"), "en");
      assert.equal(form.get("prompt"), "Emma");
      const file = form.get("file") as Blob;
      assert.equal(file.type, "audio/wav");
      assert.equal(file.size, 48);
      return new Response(JSON.stringify({ text: " Emma, show contacts. " }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    const result = await transcribeVoiceAudio(Buffer.alloc(48), "en-GB", "Emma");
    assert.deepEqual(result, { text: "Emma, show contacts.", model: "gpt-4o-mini-transcribe" });
  });
});
