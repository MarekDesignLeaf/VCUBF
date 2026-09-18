/**
 * Transcription by a local whisper.cpp server.
 *
 * Costs nothing per utterance, works without a network, and keeps recorded
 * audio on this machine — which matters for a microphone that listens
 * continuously.
 *
 * Configured with two environment variables:
 *   WHISPER_SERVER_URL   e.g. http://127.0.0.1:8081
 *   WHISPER_MODEL_LABEL  optional, only reported back for diagnostics
 *
 * With neither set the caller falls back to the hosted API, so this file is
 * inert until the server is actually running.
 */

export interface LocalTranscription {
  text: string;
  model: string;
}

/** Long enough for a slow first request, short enough not to hang a command. */
const REQUEST_TIMEOUT_MS = 20_000;

export function localTranscriptionUrl(): string | null {
  const configured = process.env.WHISPER_SERVER_URL?.trim();
  return configured ? configured.replace(/\/+$/, "") : null;
}

export function isLocalTranscriptionConfigured(): boolean {
  return localTranscriptionUrl() !== null;
}

/**
 * Transcribe one utterance locally.
 *
 * Returns null rather than throwing when the server is unreachable or slow, so
 * the caller can fall back to the hosted API instead of losing the command.
 */
export async function transcribeLocally(
  audio: Buffer,
  isoLanguage: string,
  prompt: string,
): Promise<LocalTranscription | null> {
  const base = localTranscriptionUrl();
  if (!base) return null;

  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(audio)], { type: "audio/wav" }), "command.wav");
  form.append("language", isoLanguage);
  // Deterministic decoding, matching the hosted call: guessing through unclear
  // audio is exactly where wrong words come from.
  form.append("temperature", "0");
  form.append("response_format", "json");
  if (prompt) form.append("prompt", prompt);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${base}/inference`, {
      method: "POST",
      body: form,
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as { text?: string };
    const text = (payload.text ?? "").trim();
    return { text, model: process.env.WHISPER_MODEL_LABEL?.trim() || "whisper.cpp" };
  } catch {
    // Unreachable, aborted or malformed: the caller falls back.
    return null;
  } finally {
    clearTimeout(timer);
  }
}
