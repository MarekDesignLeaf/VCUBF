import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import { transcribeVoiceAudio } from "../src/services/voiceAssistantService.js";

const realFetch = globalThis.fetch;
const realServerUrl = process.env.WHISPER_SERVER_URL;
const realKey = process.env.OPENAI_API_KEY;

describe("Local speech-to-text", () => {
  before(() => {
    process.env.OPENAI_API_KEY = "test-key";
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  after(() => {
    if (realServerUrl === undefined) delete process.env.WHISPER_SERVER_URL;
    else process.env.WHISPER_SERVER_URL = realServerUrl;
    if (realKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = realKey;
    globalThis.fetch = realFetch;
  });

  it("transcribes locally and never calls the hosted API", async () => {
    process.env.WHISPER_SERVER_URL = "http://127.0.0.1:8081";
    const called: string[] = [];
    globalThis.fetch = (async (url: unknown) => {
      called.push(String(url));
      return new Response(JSON.stringify({ text: " Emma, ukaž klienty " }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const result = await transcribeVoiceAudio(Buffer.alloc(64), "cs-CZ", "Emma");
    assert.equal(result.text, "Emma, ukaž klienty");
    assert.equal(called.length, 1);
    assert.match(called[0], /127\.0\.0\.1:8081/);
    assert.ok(!called.some((url) => url.includes("api.openai.com")), "must not reach the paid API");
  });

  it("passes the wake word and learned vocabulary to the local decoder", async () => {
    process.env.WHISPER_SERVER_URL = "http://127.0.0.1:8081";
    let prompt = "";
    globalThis.fetch = (async (_url: unknown, init: { body?: unknown }) => {
      prompt = String((init?.body as FormData).get("prompt"));
      return new Response(JSON.stringify({ text: "Emma" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    await transcribeVoiceAudio(Buffer.alloc(64), "cs-CZ", "Emma", ["Kvasnička"]);
    assert.match(prompt, /Emma/);
    // Biasing the decoder is the whole reason learned words exist; losing this
    // on the local path would quietly undo the alias feature.
    assert.match(prompt, /Kvasnička/);
  });

  it("falls back to the hosted API when the local server is down", async () => {
    process.env.WHISPER_SERVER_URL = "http://127.0.0.1:8081";
    const called: string[] = [];
    globalThis.fetch = (async (url: unknown) => {
      called.push(String(url));
      if (String(url).includes("127.0.0.1")) throw new Error("ECONNREFUSED");
      return new Response(JSON.stringify({ text: "Emma, ukaž faktury" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const result = await transcribeVoiceAudio(Buffer.alloc(64), "cs-CZ", "Emma");
    // A stopped server must degrade to paid transcription, not to silence.
    assert.equal(result.text, "Emma, ukaž faktury");
    assert.ok(called.some((url) => url.includes("api.openai.com")), "must fall back");
  });

  it("falls back when the local server answers with an error status", async () => {
    process.env.WHISPER_SERVER_URL = "http://127.0.0.1:8081";
    let reachedApi = false;
    globalThis.fetch = (async (url: unknown) => {
      if (String(url).includes("127.0.0.1")) return new Response("busy", { status: 503 });
      reachedApi = true;
      return new Response(JSON.stringify({ text: "Emma" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    await transcribeVoiceAudio(Buffer.alloc(64), "cs-CZ", "Emma");
    assert.ok(reachedApi, "a 503 from the local server must fall back");
  });

  it("filters a local hallucination instead of executing it", async () => {
    process.env.WHISPER_SERVER_URL = "http://127.0.0.1:8081";
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ text: "www.arkance-systems.cz" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;

    // Running locally does not stop Whisper inventing sentences from silence,
    // so the same filter has to apply on this path.
    const result = await transcribeVoiceAudio(Buffer.alloc(64), "cs-CZ", "Emma");
    assert.equal(result.text, "");
  });

  it("uses the hosted API when no local server is configured", async () => {
    delete process.env.WHISPER_SERVER_URL;
    let reachedApi = false;
    globalThis.fetch = (async (url: unknown) => {
      if (String(url).includes("api.openai.com")) reachedApi = true;
      return new Response(JSON.stringify({ text: "Emma" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    await transcribeVoiceAudio(Buffer.alloc(64), "cs-CZ", "Emma");
    assert.ok(reachedApi);
  });
});
