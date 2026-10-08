import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { modelFor, modelRequest, taskTimeoutMs, type ModelTask } from "../src/lib/modelGateway.js";

const originalFetch = globalThis.fetch;
const TOUCHED = [
  "OPENAI_API_KEY",
  "OPENAI_VOICE_MODEL",
  "OPENAI_TRANSLATION_MODEL",
  "OPENAI_TRANSCRIPTION_MODEL",
  "OPENAI_TTS_MODEL",
  "OPENAI_REALTIME_MODEL",
  "OPENAI_VOICE_TIMEOUT_MS",
] as const;
const originalEnv = Object.fromEntries(TOUCHED.map((name) => [name, process.env[name]]));

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const name of TOUCHED) {
    if (originalEnv[name] === undefined) delete process.env[name];
    else process.env[name] = originalEnv[name];
  }
});

describe("model gateway", () => {
  it("routes every task to its configured model, with the pre-gateway defaults", () => {
    for (const name of TOUCHED) delete process.env[name];
    const defaults: Record<ModelTask, string> = {
      interpretation: "gpt-5.4-mini",
      translation: "gpt-5.4-mini",
      transcription: "gpt-4o-transcribe",
      speech: "tts-1",
      realtime_session: "gpt-realtime-1.5",
    };
    for (const [task, model] of Object.entries(defaults)) {
      assert.equal(modelFor(task as ModelTask), model);
    }
    // The same environment variables override as before the gateway existed,
    // so no Railway configuration changes when this ships.
    process.env.OPENAI_TTS_MODEL = " tts-1-hd ";
    process.env.OPENAI_VOICE_MODEL = "gpt-5.4";
    assert.equal(modelFor("speech"), "tts-1-hd");
    assert.equal(modelFor("interpretation"), "gpt-5.4");
  });

  it("keeps the interpretation timeout configurable and clamped; other tasks are fixed", () => {
    delete process.env.OPENAI_VOICE_TIMEOUT_MS;
    assert.equal(taskTimeoutMs("interpretation"), 8_000);
    process.env.OPENAI_VOICE_TIMEOUT_MS = "99999";
    assert.equal(taskTimeoutMs("interpretation"), 15_000);
    process.env.OPENAI_VOICE_TIMEOUT_MS = "1";
    assert.equal(taskTimeoutMs("interpretation"), 3_000);
    process.env.OPENAI_VOICE_TIMEOUT_MS = "not a number";
    assert.equal(taskTimeoutMs("interpretation"), 8_000);
    assert.equal(taskTimeoutMs("translation"), 30_000);
    assert.equal(taskTimeoutMs("transcription"), 20_000);
    assert.equal(taskTimeoutMs("speech"), 30_000);
    assert.equal(taskTimeoutMs("realtime_session"), 15_000);
  });

  it("owns the key, the base URL and a default timeout", async () => {
    process.env.OPENAI_API_KEY = "test-only-key";
    let seenUrl = "";
    let seenInit: RequestInit = {};
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      seenUrl = String(url);
      seenInit = init ?? {};
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;

    const response = await modelRequest("translation", "/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(response.status, 200);
    assert.equal(seenUrl, "https://api.openai.com/v1/responses");
    const headers = new Headers(seenInit.headers);
    assert.equal(headers.get("authorization"), "Bearer test-only-key");
    assert.equal(headers.get("content-type"), "application/json");
    // A default timeout is applied when the caller brings no signal of its own.
    assert.ok(seenInit.signal instanceof AbortSignal);
  });

  it("keeps headers given as a Headers instance or as tuples", async () => {
    process.env.OPENAI_API_KEY = "test-only-key";
    let seen: Headers = new Headers();
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      seen = new Headers(init?.headers);
      return new Response("", { status: 200 });
    }) as typeof fetch;
    await modelRequest("translation", "/v1/responses", { headers: new Headers({ "Content-Type": "application/json" }) });
    assert.equal(seen.get("content-type"), "application/json");
    assert.equal(seen.get("authorization"), "Bearer test-only-key");
    await modelRequest("translation", "/v1/responses", { headers: [["X-Check", "yes"]] });
    assert.equal(seen.get("x-check"), "yes");
    assert.equal(seen.get("authorization"), "Bearer test-only-key");
  });

  it("keeps a caller-owned signal instead of its default", async () => {
    process.env.OPENAI_API_KEY = "test-only-key";
    const controller = new AbortController();
    let seenSignal: AbortSignal | null | undefined;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      seenSignal = init?.signal;
      return new Response("", { status: 200 });
    }) as typeof fetch;
    await modelRequest("speech", "/v1/audio/speech", { method: "POST", signal: controller.signal });
    assert.equal(seenSignal, controller.signal);
  });

  it("refuses to call out without a key, and lets failures through unchanged", async () => {
    delete process.env.OPENAI_API_KEY;
    await assert.rejects(modelRequest("interpretation", "/v1/responses"), /OPENAI_NOT_CONFIGURED/);

    process.env.OPENAI_API_KEY = "test-only-key";
    globalThis.fetch = (async () => {
      throw new Error("socket hang up");
    }) as typeof fetch;
    // Each call site keeps its own meaning for a failure, so the gateway must
    // not translate or swallow it.
    await assert.rejects(modelRequest("translation", "/v1/responses"), /socket hang up/);
  });
});
