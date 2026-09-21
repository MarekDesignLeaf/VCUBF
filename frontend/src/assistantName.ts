import { useAuth } from "./context/useAuth";

/** The name a new company gets until someone chooses another one. The
 *  authoritative value is on the account; this is only the fallback for
 *  surfaces drawn before anyone has signed in. */
export const DEFAULT_ASSISTANT_NAME = "Alfonzo";

/** Static interface copy writes the assistant's name as {assistant}, so changing
 *  one account setting renames it on every surface and in every language
 *  without another pass through the source. It is applied to the
 *  application's own copy only, never to client, job or message content:
 *  a client called Alfonzo must keep their name. */
export function withAssistantName(copy: string, assistantName: string) {
  return copy.replaceAll("{assistant}", assistantName);
}

/** The name this account calls the assistant. */
export function useAssistantName() {
  const { user } = useAuth();
  return (user?.assistantName ?? "").trim() || DEFAULT_ASSISTANT_NAME;
}
