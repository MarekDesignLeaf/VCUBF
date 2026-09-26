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

/** Long enough for a 1200-character reply, short enough not to stall a conversation. */
const SPEECH_TIMEOUT_MS = 30_000;

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
  const trimmed = text.trim();
  if (!key || !trimmed) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SPEECH_TIMEOUT_MS);
  try {
    const response = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.OPENAI_TTS_MODEL?.trim() || "tts-1",
        voice: process.env.OPENAI_TTS_VOICE?.trim() || "nova",
        // Cap the length: a spoken reply that runs for minutes is a bug, not a feature.
        input: trimmed.slice(0, 1200),
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
