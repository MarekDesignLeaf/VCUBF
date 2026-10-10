/**
 * Spoken replies through OpenAI text-to-speech.
 *
 * The browser can only use voices installed in Windows. OpenAI's voices speak
 * every language the app supports, and voice runs on OpenAI only, so this is
 * the one server-side voice.
 *
 * Only the reply text is sent. Configuration:
 *   OPENAI_API_KEY    required; without it the browser uses its own voice
 *   OPENAI_TTS_MODEL  optional, default "tts-1"
 *   OPENAI_TTS_VOICE  optional, one of MALE_VOICES, default "onyx"
 */

import { modelFor, modelRequest } from "../lib/modelGateway.js";

/**
 * OpenAI voices that sound like a man.
 *
 * {assistant} is a man, so he speaks only with one of these. The voice used to
 * default to "nova", a woman's voice, from when the assistant was female; a
 * deployment that still names a woman's (or the neutral "alloy") voice in
 * OPENAI_TTS_VOICE gets the default instead of speaking as a woman.
 */
export const MALE_VOICES: ReadonlySet<string> = new Set(["onyx", "echo", "ash"]);
export const DEFAULT_VOICE = "onyx";

/** The configured voice when it is a man's, otherwise the default. */
export function assistantVoice(configured = process.env.OPENAI_TTS_VOICE): string {
  const voice = configured?.trim().toLowerCase();
  return voice && MALE_VOICES.has(voice) ? voice : DEFAULT_VOICE;
}

/**
 * The same rule for a realtime voice session, whose voices differ: its default
 * used to be "marin", a woman's voice.
 */
export const MALE_REALTIME_VOICES: ReadonlySet<string> = new Set(["cedar", "ash", "echo", "verse"]);
export const DEFAULT_REALTIME_VOICE = "cedar";

export function assistantRealtimeVoice(configured = process.env.OPENAI_REALTIME_VOICE): string {
  const voice = configured?.trim().toLowerCase();
  return voice && MALE_REALTIME_VOICES.has(voice) ? voice : DEFAULT_REALTIME_VOICE;
}

/** Per synthesised piece: long enough for one full OpenAI request. */
const SPEECH_TIMEOUT_MS = 30_000;
/** OpenAI accepts at most 4096 characters per request; stay under it. */
const MAX_CHUNK = 3800;
/** A review must be heard in full before its yes, so long replies are split, not cut. */
export const MAX_SPOKEN_REPLY = 20_000;

/** Splits at sentence ends (or spaces) so every piece fits one TTS request. */
export function speechChunks(text: string, max = MAX_CHUNK): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    const window = rest.slice(0, max);
    const sentenceEnd = Math.max(window.lastIndexOf(". "), window.lastIndexOf("? "), window.lastIndexOf("! "), window.lastIndexOf("“ "), window.lastIndexOf("” "));
    const cut = sentenceEnd > max * 0.5 ? sentenceEnd + 1 : (window.lastIndexOf(" ") > max * 0.5 ? window.lastIndexOf(" ") : max);
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export interface SpokenReply {
  audio: Buffer;
  contentType: string;
}

export function isSpeechConfigured(): boolean {
  return Boolean(process.env.OPENAI_API_KEY?.trim());
}

/** OpenAI accepts 0.25–4.0; the account setting is a multiplier around 1. */
function openAiSpeed(rate: number): number {
  if (!Number.isFinite(rate) || rate <= 0) return 1;
  return Math.min(4, Math.max(0.25, rate));
}

/**
 * Synthesise one reply, or null when OpenAI cannot be reached.
 *
 * Null is not an error path the caller should surface: it means "use the
 * browser voice", which keeps {assistant} audible. The language is detected by
 * OpenAI from the text itself, so it is accepted only to keep the call site
 * stable.
 */
export async function speakReply(text: string, _language: string, rate = 1): Promise<SpokenReply | null> {
  const trimmed = text.trim().slice(0, MAX_SPOKEN_REPLY);
  if (!process.env.OPENAI_API_KEY?.trim() || !trimmed) return null;
  // The pieces are synthesised together, so a long reply waits about as long as
  // its longest piece; MP3 frames concatenate cleanly, so they play as one reply.
  const spoken = await Promise.all(speechChunks(trimmed).map((chunk) => speakChunk(chunk, rate)));
  if (!spoken.length || spoken.some((piece) => !piece)) return null;
  return { audio: Buffer.concat(spoken.map((piece) => piece!.audio)), contentType: spoken[0]!.contentType };
}

// Short replies repeat ("Ano?", "Hotovo.", "Zpráva je odeslaná."). Each one
// cost a full OpenAI round trip — one to two seconds before {assistant} could
// answer to his name. The same words in the same voice are the same audio, so
// they are kept in memory and answered at once the next time.
const CACHEABLE_TEXT = 160;
const CACHE_ENTRIES = 200;
const spokenCache = new Map<string, SpokenReply>();

function cacheKey(text: string, rate: number) {
  return [modelFor("speech"), assistantVoice(), openAiSpeed(rate), text].join("\u0000");
}

async function speakChunk(trimmed: string, rate: number): Promise<SpokenReply | null> {
  const cacheable = trimmed.length <= CACHEABLE_TEXT;
  const id = cacheable ? cacheKey(trimmed, rate) : "";
  const cached = cacheable ? spokenCache.get(id) : undefined;
  if (cached) {
    // Most recently used goes last, so the oldest is the one dropped.
    spokenCache.delete(id);
    spokenCache.set(id, cached);
    return cached;
  }
  const spoken = await synthesise(trimmed, rate);
  if (spoken && cacheable) {
    spokenCache.set(id, spoken);
    if (spokenCache.size > CACHE_ENTRIES) spokenCache.delete(spokenCache.keys().next().value!);
  }
  return spoken;
}

/**
 * Raw audio, streamed: 24 kHz, 16-bit signed little-endian, one channel.
 *
 * The whole MP3 of a sentence arrived 1.4–1.7 s after it was asked for, and
 * not a sample could be played before all of it was there. OpenAI recommends
 * raw PCM for the fastest start, and raw samples need no decoder, so the page
 * can play them as they arrive. The MP3 path stays for every other caller.
 */
export const PCM_SAMPLE_RATE = 24_000;
export const PCM_CONTENT_TYPE = `audio/pcm;rate=${PCM_SAMPLE_RATE}`;

/** Where streamed audio goes: the HTTP response, or a test. */
export interface AudioSink {
  /** Called once, before the first bytes; nothing is sent before it. */
  start(contentType: string): void;
  write(chunk: Uint8Array): void;
}

// Raw audio is about five times the size of MP3, so fewer and shorter phrases
// are kept: at most ~20 MB.
const PCM_CACHEABLE_TEXT = 60;
const PCM_CACHE_ENTRIES = 100;
const pcmCache = new Map<string, Buffer>();

/**
 * Stream one reply as raw PCM.
 *
 * Returns false when nothing could be had before a single byte was sent — the
 * caller then answers 503 and the browser uses its own voice. A failure after
 * audio has started throws: the caller must break the response off rather than
 * end it, so the page knows the reply was not heard in full.
 */
export async function streamReply(text: string, rate: number, sink: AudioSink, signal?: AbortSignal): Promise<boolean> {
  const trimmed = text.trim().slice(0, MAX_SPOKEN_REPLY);
  if (!process.env.OPENAI_API_KEY?.trim() || !trimmed) return false;
  let started = false;
  const begin = () => {
    if (!started) sink.start(PCM_CONTENT_TYPE);
    started = true;
  };
  for (const chunk of speechChunks(trimmed)) {
    const cacheable = chunk.length <= PCM_CACHEABLE_TEXT;
    const id = cacheable ? cacheKey(chunk, rate) : "";
    const cached = cacheable ? pcmCache.get(id) : undefined;
    if (cached) {
      pcmCache.delete(id);
      pcmCache.set(id, cached);
      begin();
      sink.write(cached);
      continue;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SPEECH_TIMEOUT_MS);
    const stop = () => controller.abort();
    signal?.addEventListener("abort", stop);
    try {
      let response: Response;
      try {
        response = await modelRequest("speech", "/v1/audio/speech", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: modelFor("speech"),
            voice: assistantVoice(),
            input: chunk,
            response_format: "pcm",
            speed: openAiSpeed(rate),
          }),
          signal: controller.signal,
        });
      } catch (error) {
        if (!started) return false;
        throw error;
      }
      if (!response.ok || !response.body) {
        if (!started) return false;
        throw new Error(`SPEECH_FAILED_${response.status}`);
      }
      const kept: Uint8Array[] = [];
      let bytes = 0;
      try {
        for await (const piece of response.body as unknown as AsyncIterable<Uint8Array>) {
          if (piece.byteLength === 0) continue;
          begin();
          sink.write(piece);
          if (cacheable) kept.push(piece);
          bytes += piece.byteLength;
        }
      } catch (error) {
        if (!started) return false;
        throw error;
      }
      if (bytes === 0) {
        if (!started) return false;
        throw new Error("SPEECH_EMPTY");
      }
      if (cacheable) {
        pcmCache.set(id, Buffer.concat(kept));
        if (pcmCache.size > PCM_CACHE_ENTRIES) pcmCache.delete(pcmCache.keys().next().value!);
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
    }
  }
  return started;
}

async function synthesise(trimmed: string, rate: number): Promise<SpokenReply | null> {
  // The pieces of one reply abort together, so the controller stays here and
  // the gateway's default timeout is not used.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SPEECH_TIMEOUT_MS);
  try {
    const response = await modelRequest("speech", "/v1/audio/speech", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: modelFor("speech"),
        voice: assistantVoice(),
        input: trimmed,
        response_format: "mp3",
        speed: openAiSpeed(rate),
      }),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0) return null;
    return { audio: buffer, contentType: response.headers.get("content-type") ?? "audio/mpeg" };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
