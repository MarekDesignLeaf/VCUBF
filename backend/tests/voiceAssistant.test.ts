import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { interpretVoiceRequest } from "../src/services/voiceAssistantService.js";

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
});
