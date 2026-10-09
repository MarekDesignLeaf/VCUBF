import type { ParsedCommand } from "./commandParser.js";
import { capabilityIdsForCommand, EMMA_CAPABILITIES } from "./emmaSurfaceCatalogue.js";

/**
 * Layer 2 of the emergency stop (see safeMode.ts): which commands may still run
 * while a company is in safe mode.
 *
 * A command runs only when every capability it uses is a read — the same modes
 * the administrator sees in the assistant permissions. Unclassified commands
 * are refused: when the mode is not known, the stop must win. Besides reads,
 * only commands that make things safer or touch nothing but the speaker's own
 * voice settings stay possible.
 */
const ALLOWED_IN_SAFE_MODE = new Set<ParsedCommand["intent"]>([
  "unrecognized",
  // Withdrawing a waiting review only ever removes an action.
  "cancel_execute_action", "cancel_create_client", "cancel_archive_client", "cancel_archive_contact",
  "cancel_delete_notifications", "cancel_gmail_message", "cancel_whatsapp_message",
  // The speaker's own language and speaking rate; no business data.
  "set_voice_language", "set_speech_rate",
]);

const modeById = new Map(EMMA_CAPABILITIES.map((capability) => [capability.id, capability.mode]));

export function commandAllowedInSafeMode(command: ParsedCommand): boolean {
  if (ALLOWED_IN_SAFE_MODE.has(command.intent)) return true;
  const ids = capabilityIdsForCommand(command);
  return ids.length > 0 && ids.every((id) => modeById.get(id) === "read");
}
