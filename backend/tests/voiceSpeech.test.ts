import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import { assistantRealtimeVoice, assistantVoice, DEFAULT_VOICE, isSpeechConfigured, PCM_CONTENT_TYPE, speakReply, streamReply } from "../src/services/voiceSpeechService.js";

const realFetch = globalThis.fetch;
const realKey = process.env.OPENAI_API_KEY;
const realVoice = process.env.OPENAI_TTS_VOICE;
const realRealtimeVoice = process.env.OPENAI_REALTIME_VOICE;

describe("Spoken replies use OpenAI text-to-speech only", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = realKey;
    if (realVoice === undefined) delete process.env.OPENAI_TTS_VOICE;
    else process.env.OPENAI_TTS_VOICE = realVoice;
    if (realRealtimeVoice === undefined) delete process.env.OPENAI_REALTIME_VOICE;
    else process.env.OPENAI_REALTIME_VOICE = realRealtimeVoice;
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
    // An unset argument reads the environment, which a developer's or CI's
    // own configuration may set; the default is what an unset one gives.
    delete process.env.OPENAI_TTS_VOICE;
    assert.equal(assistantVoice(), "onyx");
    assert.equal(assistantVoice(undefined), "onyx");
    assert.equal(assistantVoice(""), "onyx");
    assert.equal(assistantVoice("ash"), "ash");
    assert.equal(assistantVoice("onyx"), "onyx");
    assert.equal(assistantVoice("nova"), "onyx");
    assert.equal(assistantVoice("not-a-voice"), "onyx");
  });

  it("a realtime session speaks with a man's voice too", () => {
    // "marin", a woman's voice, was the realtime default.
    delete process.env.OPENAI_REALTIME_VOICE;
    assert.equal(assistantRealtimeVoice(), "cedar");
    assert.equal(assistantRealtimeVoice(undefined), "cedar");
    assert.equal(assistantRealtimeVoice("marin"), "cedar");
    assert.equal(assistantRealtimeVoice("shimmer"), "cedar");
    assert.equal(assistantRealtimeVoice(" Verse "), "verse");
  });
});

describe("Streamed replies (raw PCM, played as they arrive)", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = realKey;
  });

  /** A response whose body arrives in the given pieces, then fails if `fail` is set. */
  function streamed(pieces: number[][], fail = false) {
    let next = 0;
    return new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (next < pieces.length) controller.enqueue(new Uint8Array(pieces[next++]));
        else if (fail) controller.error(new Error("connection reset"));
        else controller.close();
      },
    }), { status: 200, headers: { "content-type": "application/octet-stream" } });
  }

  function sink() {
    const events: string[] = [];
    const bytes: number[] = [];
    return {
      events,
      bytes,
      start(contentType: string) { events.push(`start ${contentType}`); },
      write(chunk: Uint8Array) { events.push(`write ${chunk.byteLength}`); bytes.push(...chunk); },
    };
  }

  it("asks for PCM and passes every piece on as it comes, in order", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    let body: Record<string, unknown> = {};
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return streamed([[1, 2], [3, 4, 5], [6]]);
    }) as typeof fetch;
    const out = sink();
    assert.equal(await streamReply("Máte tři zakázky na zítra a jednu na pátek, všechny v Oxfordu.", 1, out), true);
    assert.equal(body.response_format, "pcm");
    assert.deepEqual(out.events, [`start ${PCM_CONTENT_TYPE}`, "write 2", "write 3", "write 1"]);
    assert.deepEqual(out.bytes, [1, 2, 3, 4, 5, 6]);
  });

  it("starts nothing when the voice cannot be had, so the route can answer 503", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    globalThis.fetch = (async () => new Response("{}", { status: 500 })) as typeof fetch;
    const out = sink();
    assert.equal(await streamReply("Dnes nemáte žádné zakázky naplánované.", 1, out), false);
    assert.deepEqual(out.events, []);
    delete process.env.OPENAI_API_KEY;
    assert.equal(await streamReply("Dnes nic.", 1, sink()), false);
  });

  it("a failure after audio started is thrown, so the response is broken off rather than ended", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    globalThis.fetch = (async () => streamed([[1, 2, 3, 4]], true)) as typeof fetch;
    const out = sink();
    await assert.rejects(streamReply("Připravil jsem objednávku pro dodavatele Alfa na čtyřicet kusů.", 1, out));
    assert.deepEqual(out.events, [`start ${PCM_CONTENT_TYPE}`, "write 4"]);
    // The same failure before any audio is simply "no voice".
    globalThis.fetch = (async () => streamed([], true)) as typeof fetch;
    const none = sink();
    assert.equal(await streamReply("Připravil jsem objednávku pro dodavatele Beta.", 1, none), false);
    assert.deepEqual(none.events, []);
  });

  it("keeps a short phrase, so the next time it is answered without OpenAI", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    let calls = 0;
    globalThis.fetch = (async () => { calls += 1; return streamed([[9, 8], [7]]); }) as typeof fetch;
    const first = sink();
    assert.equal(await streamReply("Ano, rozumím.", 1, first), true);
    const second = sink();
    assert.equal(await streamReply("Ano, rozumím.", 1, second), true);
    assert.equal(calls, 1);
    assert.deepEqual(second.bytes, [9, 8, 7]);
    // A different speed is different audio.
    assert.equal(await streamReply("Ano, rozumím.", 1.3, sink()), true);
    assert.equal(calls, 2);
  });
});

