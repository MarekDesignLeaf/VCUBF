import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import { assistantRealtimeVoice, assistantVoice, DEFAULT_VOICE, isSpeechConfigured, speakReply } from "../src/services/voiceSpeechService.js";

const realFetch = globalThis.fetch;
const realKey = process.env.OPENAI_API_KEY;
const realVoice = process.env.OPENAI_TTS_VOICE;

describe("Spoken replies use OpenAI text-to-speech only", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = realKey;
    if (realVoice === undefined) delete process.env.OPENAI_TTS_VOICE;
    else process.env.OPENAI_TTS_VOICE = realVoice;
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

  it("speaks a long review in full: every piece synthesised and joined in order", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const inputs: string[] = [];
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      const piece = String(JSON.parse(String(init?.body)).input);
      inputs.push(piece);
      // Answer the later pieces first: the joined audio must still follow the text order.
      await new Promise((resolve) => setTimeout(resolve, inputs.length === 1 ? 20 : 0));
      return new Response(new TextEncoder().encode(`[${piece.slice(0, 12)}]`), { status: 200, headers: { "content-type": "audio/mpeg" } });
    }) as typeof fetch;
    const text = Array.from({ length: 300 }, (_, index) => `Sentence ${String(index).padStart(3, "0")} of the review.`).join(" ");
    const spoken = await speakReply(text, "en-GB");
    assert.ok(inputs.length > 1, "split into several requests");
    assert.ok(inputs.every((piece) => piece.length <= 3800));
    assert.equal(inputs.slice().sort((a, b) => text.indexOf(a) - text.indexOf(b)).join(" "), text, "nothing is lost");
    const audio = new TextDecoder().decode(spoken!.audio);
    assert.ok(audio.startsWith("[Sentence 000"), "the first piece plays first");
  });
  it("Alfonzo speaks with a man's voice, whatever a deployment left configured", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const voices: unknown[] = [];
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      voices.push(JSON.parse(String(init?.body)).voice);
      return new Response(new Uint8Array([1]), { status: 200, headers: { "content-type": "audio/mpeg" } });
    }) as typeof fetch;

    delete process.env.OPENAI_TTS_VOICE;
    await speakReply("Voice check without a setting.", "en-GB");
    // "nova" was the default while the assistant was a woman; a deployment that
    // still names it, or any other woman's or neutral voice, must not be heard.
    for (const notMale of ["nova", "shimmer", "coral", "sage", "alloy", "NOVA "]) {
      process.env.OPENAI_TTS_VOICE = notMale;
      await speakReply(`Voice check with ${notMale.trim()} configured.`, "en-GB");
    }
    process.env.OPENAI_TTS_VOICE = " Echo ";
    await speakReply("Voice check with echo configured.", "en-GB");

    assert.equal(DEFAULT_VOICE, "onyx");
    assert.deepEqual(voices, ["onyx", "onyx", "onyx", "onyx", "onyx", "onyx", "onyx", "echo"]);
  });

  it("keeps only the male voices OpenAI offers", () => {
    assert.equal(assistantVoice(undefined), "onyx");
    assert.equal(assistantVoice(""), "onyx");
    assert.equal(assistantVoice("ash"), "ash");
    assert.equal(assistantVoice("onyx"), "onyx");
    assert.equal(assistantVoice("nova"), "onyx");
    assert.equal(assistantVoice("not-a-voice"), "onyx");
  });

  it("a realtime session speaks with a man's voice too", () => {
    // "marin", a woman's voice, was the realtime default.
    assert.equal(assistantRealtimeVoice(undefined), "cedar");
    assert.equal(assistantRealtimeVoice("marin"), "cedar");
    assert.equal(assistantRealtimeVoice("shimmer"), "cedar");
    assert.equal(assistantRealtimeVoice(" Verse "), "verse");
  });
});
