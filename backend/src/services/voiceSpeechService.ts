import { localTranscriptionUrl } from "./localTranscriptionService.js";

/**
 * Spoken replies in a female voice.
 *
 * The browser can only use voices installed in Windows, and Windows ships no
 * female Czech voice — Emma would be male in Czech no matter what the page did.
 * The local server has Microsoft's free neural voices instead.
 *
 * Only the reply text leaves the machine. The microphone audio is transcribed
 * locally and never goes anywhere.
 */

/**
 * Long enough for a paragraph, short enough not to stall a conversation.
 *
 * Synthesis costs about a second per hundred characters, so a reply at the 1200
 * character cap below needs ten seconds on an idle machine and considerably more
 * while the NPU is busy transcribing. Fifteen seconds cut those off and answered
 * 503, which the page reads as "use the browser voice" — so the longest replies,
 * the ones where the good voice matters most, were the ones that never got it.
 *
 * The voice server gives up on its own at 28 s, having retried in between. This
 * sits just past that, so what surfaces is its error rather than this timer.
 */
const SPEECH_TIMEOUT_MS = 30_000;

export interface SpokenReply {
  audio: Buffer;
  contentType: string;
}

export function isSpeechConfigured(): boolean {
  return localTranscriptionUrl() !== null;
}

/**
 * Synthesise one reply, or null when the voice service cannot be reached.
 *
 * Null is not an error path the caller should surface: it means "use the
 * browser voice", which keeps Emma audible.
 */
export async function speakReply(text: string, language: string, rate = 1): Promise<SpokenReply | null> {
  const base = localTranscriptionUrl();
  const trimmed = text.trim();
  if (!base || !trimmed) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SPEECH_TIMEOUT_MS);
  try {
    const response = await fetch(`${base}/speak`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Cap the length: a spoken reply that runs for minutes is a bug, not a feature.
      body: JSON.stringify({ text: trimmed.slice(0, 1200), language, rate }),
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
