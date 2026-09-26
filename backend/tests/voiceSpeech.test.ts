import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import { isSpeechConfigured, speakReply } from "../src/services/voiceSpeechService.js";

const realFetch = globalThis.fetch;
const realKey = process.env.OPENAI_API_KEY;

describe("Spoken replies use OpenAI text-to-speech only", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = realKey;
  });
  after(() => { globalThis.fetch = realFetch; });

  it("sends the reply text to OpenAI and returns the audio", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    let url = "";
    let body: Record<string, unknown> = {};
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      url = String(input);
      body = JSON.parse(String(init?.body));
      return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "audio/mpeg" } });
    }) as typeof fetch;
    const spoken = await speakReply("  Dobrý den  ", "cs-CZ", 1.2);
    assert.equal(url, "https://api.openai.com/v1/audio/speech");
    assert.equal(body.input, "Dobrý den");
    assert.equal(body.speed, 1.2);
    assert.equal(body.response_format, "mp3");
    assert.equal(spoken?.contentType, "audio/mpeg");
    assert.deepEqual([...spoken!.audio], [1, 2, 3]);
  });

  it("answers null without a key, so the browser uses its own voice", async () => {
    delete process.env.OPENAI_API_KEY;
    let called = false;
    globalThis.fetch = (async () => { called = true; return new Response(""); }) as typeof fetch;
    assert.equal(isSpeechConfigured(), false);
    assert.equal(await speakReply("Hello", "en-GB"), null);
    assert.equal(called, false);
  });

  it("answers null when OpenAI refuses, never another provider", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const calls: string[] = [];
    globalThis.fetch = (async (input: unknown) => {
      calls.push(String(input));
      return new Response("", { status: 500 });
    }) as typeof fetch;
    assert.equal(await speakReply("Hello", "en-GB"), null);
    assert.deepEqual(calls, ["https://api.openai.com/v1/audio/speech"]);
  });
});
