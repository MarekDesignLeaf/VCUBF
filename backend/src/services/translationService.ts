import { z } from "zod";
import { VOICE_LANGUAGE_LABELS, resolveSpokenLanguageName, resolveVoiceLanguage, type VoiceLanguage } from "../lib/voiceLanguages.js";

/**
 * Translating a message the user dictated, so it can be sent in another language.
 *
 * This is language work, which is what the model layer is for; it is not a
 * business decision and it changes no business state. The rules that matter are
 * therefore about faithfulness, not about judgement:
 *
 *   - The model translates and does nothing else. It does not answer the
 *     message, continue it, add a greeting or a sign-off, or explain itself.
 *   - Names, numbers, amounts, dates, addresses, links and reference codes are
 *     carried across unchanged. A translated invoice number is a wrong invoice
 *     number (section 64: the system must not invent operational facts).
 *   - A translation that cannot be produced is an error, never a silent
 *     fallback to the original. Sending Czech to someone who was promised
 *     English is not a lesser version of the request; it is the wrong outcome.
 *
 * The translated text is produced once, before the user approves the send, and
 * the approved text is what goes out — a second translation could differ, and
 * the approval would then bind to something nobody read (section 41).
 */

export type TranslationError = "TRANSLATION_NOT_CONFIGURED" | "TRANSLATION_FAILED" | "TRANSLATION_LANGUAGE_UNKNOWN";

export class TranslationUnavailable extends Error {
  constructor(public readonly reason: TranslationError, message?: string) {
    super(message ?? reason);
    this.name = "TranslationUnavailable";
  }
}

export interface Translation {
  text: string;
  targetLanguage: VoiceLanguage;
  /** What the target language is called, for a spoken or written confirmation. */
  targetLanguageLabel: string;
  model: string;
}

/**
 * Accepts what a person would actually say or type: "en-GB", "English",
 * "anglicky", "angielski". The spoken forms already exist for switching the
 * assistant's own language and are reused rather than listed again.
 */
export function resolveTargetLanguage(raw: string): VoiceLanguage | undefined {
  const value = raw.trim();
  if (!value) return undefined;
  return resolveVoiceLanguage(value) ?? resolveSpokenLanguageName(value);
}

const responseSchema = z.object({ output_text: z.string().optional(), output: z.array(z.any()).optional() });

function outputText(payload: z.infer<typeof responseSchema>): string {
  if (typeof payload.output_text === "string") return payload.output_text;
  return (payload.output ?? [])
    .flatMap((item: { content?: { type?: string; text?: string }[] }) => item.content ?? [])
    .filter((item) => item.type === "output_text")
    .map((item) => item.text ?? "")
    .join("");
}

export async function translateForSending(text: string, rawTargetLanguage: string): Promise<Translation> {
  const targetLanguage = resolveTargetLanguage(rawTargetLanguage);
  if (!targetLanguage) {
    throw new TranslationUnavailable("TRANSLATION_LANGUAGE_UNKNOWN", `Unknown language: ${rawTargetLanguage}`);
  }
  const body = text.trim();
  if (!body) throw new TranslationUnavailable("TRANSLATION_FAILED", "There is nothing to translate.");

  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new TranslationUnavailable("TRANSLATION_NOT_CONFIGURED");
  const model = process.env.OPENAI_TRANSLATION_MODEL ?? "gpt-5.4-mini";
  const label = VOICE_LANGUAGE_LABELS[targetLanguage];

  let payload: unknown;
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        store: false,
        max_output_tokens: 4_000,
        instructions:
          `Translate the user's message into ${label}. Return only the translation, with no preamble, `
          + "no quotation marks around it and no commentary. Translate faithfully: do not answer the message, "
          + "do not continue it, and do not add a greeting or a sign-off that is not already there. Keep personal "
          + "and company names, numbers, amounts, currencies, dates, times, addresses, links, email addresses and "
          + "reference codes exactly as they are. Keep the paragraph breaks. If the message is already in "
          + `${label}, return it unchanged.`,
        input: body,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`OPENAI_TRANSLATION_FAILED_${response.status}`);
    payload = await response.json();
  } catch (error) {
    throw new TranslationUnavailable("TRANSLATION_FAILED", error instanceof Error ? error.message : "translation request failed");
  }

  const parsed = responseSchema.safeParse(payload);
  const translated = parsed.success ? outputText(parsed.data).trim() : "";
  if (!translated) throw new TranslationUnavailable("TRANSLATION_FAILED", "The translation came back empty.");
  return { text: translated, targetLanguage, targetLanguageLabel: label, model };
}

export interface OutgoingTranslation {
  body: string;
  subject?: string;
  /** What was dictated, kept so the person can see both halves of what they approved. */
  original: { body: string; subject?: string };
  language: VoiceLanguage;
  languageLabel: string;
}

/**
 * Translate a message that is about to be sent.
 *
 * Subject and body are translated together in one request rather than
 * separately, so the subject is rendered in the light of the message it
 * belongs to rather than as a stray line of text.
 */
export async function translateOutgoingMessage(
  message: { body: string; subject?: string },
  sendIn: string
): Promise<OutgoingTranslation> {
  const subject = message.subject?.trim();
  const SEPARATOR = "\n\n<<<BODY>>>\n\n";
  const source = subject ? `${subject}${SEPARATOR}${message.body}` : message.body;
  const translated = await translateForSending(source, sendIn);
  if (!subject) {
    return {
      body: translated.text,
      original: { body: message.body },
      language: translated.targetLanguage,
      languageLabel: translated.targetLanguageLabel,
    };
  }
  const marker = translated.text.indexOf("<<<BODY>>>");
  if (marker < 0) {
    // The separator did not survive, so which half is which is unknown, and
    // guessing would put the message in the subject line of a real email.
    throw new TranslationUnavailable("TRANSLATION_FAILED", "The translated subject and body could not be told apart.");
  }
  return {
    body: translated.text.slice(marker + "<<<BODY>>>".length).trim(),
    subject: translated.text.slice(0, marker).trim(),
    original: { body: message.body, subject },
    language: translated.targetLanguage,
    languageLabel: translated.targetLanguageLabel,
  };
}

