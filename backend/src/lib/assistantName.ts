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
