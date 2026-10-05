/**
 * Spoken replies through OpenAI text-to-speech.
 *
 * The browser can only use voices installed in Windows, and Windows ships no
 * female Czech voice. OpenAI's voices speak every language the app supports,
 * and voice runs on OpenAI only, so this is the one server-side voice.
 *
 * Only the reply text is sent. Configuration:
 *   OPENAI_API_KEY    required; without it the browser uses its own voice
 *   OPENAI_TTS_MODEL  optional, default "tts-1"
 *   OPENAI_TTS_VOICE  optional, default "nova"
 */

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
  const key = process.env.OPENAI_API_KEY?.trim();
  const trimmed = text.trim().slice(0, MAX_SPOKEN_REPLY);
  if (!key || !trimmed) return null;
  // MP3 frames concatenate cleanly, so the pieces play back as one reply.
  const parts: Buffer[] = [];
  let contentType = "audio/mpeg";
  for (const chunk of speechChunks(trimmed)) {
    const spoken = await speakChunk(key, chunk, rate);
    if (!spoken) return null;
    parts.push(spoken.audio);
    contentType = spoken.contentType;
  }
  return parts.length ? { audio: Buffer.concat(parts), contentType } : null;
}

async function speakChunk(key: string, trimmed: string, rate: number): Promise<SpokenReply | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SPEECH_TIMEOUT_MS);
  try {
    const response = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.OPENAI_TTS_MODEL?.trim() || "tts-1",
        voice: process.env.OPENAI_TTS_VOICE?.trim() || "nova",
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
