/** The name a new company gets until someone chooses another one. The account
 *  is the authority; this is the fallback for a request with no user on it. */
export const DEFAULT_ASSISTANT_NAME = "Alfonzo";

/** Interface copy, spoken replies and the menu map hold the assistant's name
 *  as {assistant}, so one account setting renames it on every surface and in
 *  every language. Only that token is replaced, which is why a client, job or
 *  message that happens to be named after the assistant is left alone. */
export const ASSISTANT_NAME_TOKEN = "{assistant}";

export function assistantNameFor(user?: { assistantName?: string | null } | null) {
  return (user?.assistantName ?? "").trim() || DEFAULT_ASSISTANT_NAME;
}

export function withAssistantName(text: string, assistantName: string) {
  return text.replaceAll(ASSISTANT_NAME_TOKEN, assistantName);
}

/**
 * Whether a sentence is nothing but the assistant's name, or the wake phrase
 * ("Alfonzo.", "Hej Alfonzo!"). In an open conversation it is answered as the
 * name is answered when the conversation opens, not sent to the model.
 */
export function onlyTheName(text: string, names: string[]): boolean {
  const fold = (value: string) => value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
  const said = fold(text).replace(/^(?:hej|hey|hi|ahoj) /, "");
  if (!said) return false;
  return names.map((name) => fold(name.replace(/\{assistant\}/g, "")).replace(/^(?:hej|hey|hi|ahoj) /, "")).filter(Boolean).some((name) => said === name);
}

/** What the assistant says to his bare name. */
export function nameAcknowledgement(language: string) {
  const locale = language.slice(0, 2).toLowerCase();
  return locale === "cs" ? "Ano?" : locale === "pl" ? "Tak?" : "Yes?";
}
