/**
 * The Model Gateway: every call to an AI model leaves Secretary through here.
 *
 * One place answers three questions that were scattered across five services:
 * which model does this task use, how long may it take, and what did it cost.
 * That is the first step of the agent plan (masterdokument, F0): a task is
 * routed to a model by this table, so changing a model — or adding a cheaper
 * one for a cheap task — is configuration, not a code hunt. The gateway only
 * carries requests; what is asked and what is done with the answer stays in
 * the services, and nothing here can write business data.
 *
 * The provider today is OpenAI. Another provider is a second base URL and key
 * behind the same task table — never a second call path in a service.
 */

export type ModelTask = "interpretation" | "translation" | "transcription" | "speech" | "realtime_session";

interface TaskDefinition {
  /** The environment variable that overrides the model, kept from before the gateway. */
  envVar: string;
  defaultModel: string;
  defaultTimeoutMs: number;
}

const TASKS: Record<ModelTask, TaskDefinition> = {
  /** Turning a sentence into a command, reply, clarification or plan. */
  interpretation: { envVar: "OPENAI_VOICE_MODEL", defaultModel: "gpt-5.4-mini", defaultTimeoutMs: 8_000 },
  /** Translating an outgoing message into the language it is sent in. */
  translation: { envVar: "OPENAI_TRANSLATION_MODEL", defaultModel: "gpt-5.4-mini", defaultTimeoutMs: 30_000 },
  /** Speech to text. */
  transcription: { envVar: "OPENAI_TRANSCRIPTION_MODEL", defaultModel: "gpt-4o-transcribe", defaultTimeoutMs: 20_000 },
  /** Text to Alfonzo's voice. */
  speech: { envVar: "OPENAI_TTS_MODEL", defaultModel: "tts-1", defaultTimeoutMs: 30_000 },
  /** Short-lived credentials for the legacy realtime audio channel. */
  realtime_session: { envVar: "OPENAI_REALTIME_MODEL", defaultModel: "gpt-realtime-1.5", defaultTimeoutMs: 15_000 },
};

/** The model a task runs on: the task's environment override, or its default. */
export function modelFor(task: ModelTask): string {
  const definition = TASKS[task];
  return process.env[definition.envVar]?.trim() || definition.defaultModel;
}

/**
 * How long a task may wait for the model.
 *
 * Interpretation keeps its own configurable, clamped timeout: it sits in the
 * middle of a spoken exchange, where a slow answer is itself a failure.
 */
export function taskTimeoutMs(task: ModelTask): number {
  if (task === "interpretation") {
    const configured = Number(process.env.OPENAI_VOICE_TIMEOUT_MS ?? "8000");
    return Number.isFinite(configured) ? Math.max(3_000, Math.min(15_000, Math.trunc(configured))) : 8_000;
  }
  return TASKS[task].defaultTimeoutMs;
}

const OPENAI_BASE_URL = "https://api.openai.com";

/**
 * Send one request to the model provider.
 *
 * The gateway owns the key, the base URL and the default timeout; the caller
 * owns the body. A caller that manages its own cancellation (speech synthesis
 * aborts all pieces together) passes its signal and the default is not applied.
 * Errors are not swallowed: each call site keeps its own meaning for a failure
 * — a refused translation, a silent fallback voice, a spoken apology.
 */
export async function modelRequest(task: ModelTask, path: string, init: RequestInit = {}): Promise<Response> {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) throw new Error("OPENAI_NOT_CONFIGURED");
  // Headers normalises every RequestInit form (plain object, Headers, tuple
  // array); spreading a Headers instance would silently drop its entries.
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${key}`);
  const signal = init.signal ?? AbortSignal.timeout(taskTimeoutMs(task));
  const startedAt = Date.now();
  try {
    const response = await fetch(`${OPENAI_BASE_URL}${path}`, { ...init, headers, signal });
    log(task, String(response.status), Date.now() - startedAt);
    return response;
  } catch (error) {
    log(task, error instanceof Error ? error.name : "error", Date.now() - startedAt);
    throw error;
  }
}

/**
 * Token usage, logged by the call sites that parse a JSON answer.
 *
 * The gateway does not read response bodies — a reply is parsed exactly once,
 * by its service — so usage arrives here after parsing. Runtime logs carry it
 * per call; the per-run cost ledger in the audit comes with agent runs (F1).
 */
export function recordUsage(task: ModelTask, usage: unknown): void {
  if (!usage || typeof usage !== "object") return;
  const { input_tokens, output_tokens } = usage as { input_tokens?: unknown; output_tokens?: unknown };
  if (typeof input_tokens !== "number" && typeof output_tokens !== "number") return;
  console.log(`[model-gateway] task=${task} model=${modelFor(task)} tokens_in=${input_tokens ?? "?"} tokens_out=${output_tokens ?? "?"}`);
}

function log(task: ModelTask, outcome: string, durationMs: number): void {
  console.log(`[model-gateway] task=${task} model=${modelFor(task)} outcome=${outcome} ms=${durationMs}`);
}
