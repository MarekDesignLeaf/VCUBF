// Text/Voice Understanding Layer — deterministic, rule-based intent parser.
//
// This is intentionally NOT an LLM call. Per the VCUBF master documentation and
// the vcubf-programmer-skill "business logic rule", business decisions must be
// stored in structured form, not guessed by a prompt. The parser's only job is
// to produce a structured ParsedCommand — the same shape the language model's
// canonical command is turned into — so the Action Engine underneath never
// depends on how a request was understood.
//
// Each language has its own grammar (commandGrammar/). A sentence the user
// says or types is read only with the grammar of the language switched on:
// with Czech on, only Czech is understood, and Polish only after switching to
// Polish. English is also the system's internal language — the language
// model's canonical commands are read with the English grammar whatever
// language is on.
//
import type { VoicePage } from "./voiceNavigation.js";
import type { ConnectorKey } from "../connectors/registry.js";
import { mentionsLanguage, type VoiceLanguage } from "./voiceLanguages.js";
import type { NavigationSectionId } from "./navigationCatalogue.js";
import { parseEmmaExecutableActionCommand, type EmmaExecutableActionName, type EmmaExecutableActionRequest } from "./emmaExecutableActionCatalogue.js";
import { czech } from "./commandGrammar/czech.js";
import { english } from "./commandGrammar/english.js";
import { french, german, italian, spanish } from "./commandGrammar/otherLanguages.js";
import { polish } from "./commandGrammar/polish.js";
import { fold, namedIn, parseLanguageName, parseLanguageSwitch, type CommandGrammar } from "./commandGrammar/shared.js";

// If nothing matches, the result is `unrecognized` — the system must not
// guess (VCUBF error handling rule).

export type ParsedCommand =
  | { intent: "execute_action"; entities: EmmaExecutableActionRequest }
  | { intent: "confirm_execute_action"; entities: { action: EmmaExecutableActionName } }
  | { intent: "cancel_execute_action"; entities: { action: EmmaExecutableActionName } }
  // The one yes or no to a proposal the agent put together (masterplan F2b).
  | { intent: "confirm_agent_proposal"; entities: Record<string, never> }
  | { intent: "cancel_agent_proposal"; entities: Record<string, never> }
  | { intent: "create_client"; entities: { display_name: string; email_primary?: string; phone_primary?: string } }
  | { intent: "confirm_create_client"; entities: Record<string, never> }
  | { intent: "cancel_create_client"; entities: Record<string, never> }
  | {
      intent: "update_client";
      entities: { client_name: string; display_name?: string; email_primary?: string; phone_primary?: string };
    }
  | { intent: "prepare_archive_client"; entities: { client_name: string } }
  | { intent: "confirm_archive_client"; entities: Record<string, never> }
  | { intent: "cancel_archive_client"; entities: Record<string, never> }
  | { intent: "create_contact"; entities: { display_name: string; email?: string; phone?: string } }
  | { intent: "update_contact"; entities: { contact_name: string; display_name?: string; email?: string; phone?: string } }
  | { intent: "prepare_archive_contact"; entities: { contact_name: string } }
  | { intent: "confirm_archive_contact"; entities: Record<string, never> }
  | { intent: "cancel_archive_contact"; entities: Record<string, never> }
  | {
      intent: "create_lead";
      entities: { name: string; service_requested?: string; email?: string; phone?: string };
    }
  | { intent: "create_job"; entities: { job_title: string; client_name: string } }
  | { intent: "change_job_status"; entities: { job_title: string; job_status: string } }
  | { intent: "convert_lead"; entities: { lead_name: string } }
  | {
      intent: "update_lead";
      entities: {
        lead_name: string;
        name?: string;
        email?: string;
        phone?: string;
        lead_status?: "new" | "contacted" | "qualified" | "lost";
      };
    }
  | { intent: "assign_job"; entities: { job_title: string; employee_name: string } }
  | { intent: "detect_overload"; entities: Record<string, never> }
  | { intent: "create_service"; entities: { name: string; category?: string } }
  | { intent: "create_task"; entities: { title: string; employee_name?: string; due_at?: string } }
  | { intent: "list_tasks"; entities: Record<string, never> }
  | { intent: "change_task_status"; entities: { title: string; task_status: "open" | "in_progress" | "completed" | "cancelled" } }
  | { intent: "list_quotes"; entities: { client_name?: string } }
  | { intent: "list_job_openings"; entities: Record<string, never> }
  | { intent: "create_learning_rule"; entities: { term: string; meaning: string } }
  | { intent: "list_learning_rules"; entities: Record<string, never> }
  | { intent: "create_assistant_memory"; entities: { content: string; scope: "personal" | "company" } }
  | { intent: "recall_assistant_memory"; entities: { query?: string } }
  | {
      intent: "log_communication";
      entities: { client_name: string; channel: string; direction: string; summary: string };
    }
  | { intent: "list_communications"; entities: { client_name?: string } }
  | {
      intent: "log_portfolio_photo";
      entities: { filename: string; client_name?: string; caption?: string; source?: string };
    }
  | { intent: "list_portfolio_photos"; entities: { client_name?: string; usable_for_marketing?: boolean } }
  | { intent: "list_follow_ups"; entities: Record<string, never> }
  | { intent: "list_unresolved_enquiries"; entities: { since_days?: number } }
  | { intent: "list_notifications"; entities: Record<string, never> }
  | { intent: "prepare_delete_notifications"; entities: Record<string, never> }
  | { intent: "confirm_delete_notifications"; entities: Record<string, never> }
  | { intent: "cancel_delete_notifications"; entities: Record<string, never> }
  | { intent: "list_data_quality"; entities: Record<string, never> }
  | { intent: "detect_action_patterns"; entities: Record<string, never> }
  | { intent: "list_clients"; entities: Record<string, never> }
  | { intent: "list_contacts"; entities: Record<string, never> }
  | { intent: "list_channel_messages"; entities: { channel: "email" | "whatsapp" } }
  // While received messages are read out one sender at a time: the next
  // sender, or more of the same sender's older messages.
  // sender: the name said with it ("přeskoč Petru"), when one was.
  | { intent: "next_message_sender"; entities: { sender?: string } }
  | { intent: "older_sender_messages"; entities: Record<string, never> }
  | {
      intent: "prepare_gmail_message";
      // from: the sending account as the user named it ("personal",
      // "z osobního účtu"), present only when named.
      entities: { to: string[]; cc: string[]; bcc: string[]; subject: string; body: string; from?: string };
    }
  | { intent: "confirm_gmail_message"; entities: Record<string, never> }
  | { intent: "cancel_gmail_message"; entities: Record<string, never> }
  | { intent: "list_calendar_events"; entities: { period: "today" | "tomorrow" | "next_7_days" } }
  | { intent: "prepare_whatsapp_message"; entities: { to: string; body: string } }
  | { intent: "confirm_whatsapp_message"; entities: Record<string, never> }
  | { intent: "cancel_whatsapp_message"; entities: Record<string, never> }
  | { intent: "set_voice_language"; entities: { language: VoiceLanguage } }
  /** Adjusting how fast she talks. A direction is relative to the current
   *  value, which the speaker has no way of knowing. */
  | { intent: "set_speech_rate"; entities: { change?: "faster" | "slower" | "normal"; rate?: number } }
  | { intent: "describe_menu"; entities: { section?: NavigationSectionId } }
  | { intent: "connector_status"; entities: { connector_key: ConnectorKey | "all" } }
  | { intent: "setup_connectors"; entities: { connector_key: ConnectorKey | "all" } }
  | { intent: "sync_connectors"; entities: { connector_key: ConnectorKey | "all" } }
  | { intent: "list_jobs"; entities: Record<string, never> }
  | { intent: "list_leads"; entities: Record<string, never> }
  | { intent: "navigate"; entities: { page: VoicePage } }
  | { intent: "unrecognized"; entities: Record<string, never> };

/**
 * Who wrote the text being read. A voice language ("cs-CZ") means the user
 * said or typed it, and only that language's grammar reads it. CANONICAL_COMMAND
 * means the system wrote it — the language model's canonical command — and the
 * English grammar reads it.
 */
export const CANONICAL_COMMAND = "canonical";

const GRAMMARS: Record<string, CommandGrammar> = { en: english, cs: czech, pl: polish, fr: french, de: german, es: spanish, it: italian };

function grammarFor(reader: string): CommandGrammar {
  if (reader === CANONICAL_COMMAND) return english;
  return GRAMMARS[reader.trim().toLowerCase().split("-", 1)[0] ?? ""] ?? english;
}

// The fixed English phrases the Windows companion sends after a spoken yes or
// no to a review. They are a protocol between two parts of the system, not
// something a person says, and are accepted whatever language is on.
const COMPANION_PHRASES = new Set([
  "confirm email", "cancel email", "confirm whatsapp", "cancel whatsapp",
  "confirm delete notifications", "cancel delete notifications", "confirm action", "cancel action",
]);

function bare(rawText: string) {
  return rawText.trim().toLocaleLowerCase().replace(/[.!?]+$/g, "").replace(/\s+/g, " ");
}

export function parseTextCommand(rawText: string, reader: string): ParsedCommand {
  const text = rawText.trim();
  // "voice action NAME {json}" is written only by the language model. It is
  // allowlisted and JSON-parsed here; the owning business service still
  // performs the authoritative validation before any mutation.
  const executableAction = parseEmmaExecutableActionCommand(text);
  if (executableAction) return { intent: "execute_action", entities: executableAction };

  const grammar = COMPANION_PHRASES.has(fold(text).replace(/[.!?]+$/g, "")) ? english : grammarFor(reader);
  // A bare yes or no answers the one review that is waiting; the caller knows
  // which one, the sentence does not ("zruš akci" is not a task called "akci").
  const said = bare(text);
  if (grammar.yes.test(said) || grammar.no.test(said)) return { intent: "unrecognized", entities: {} };
  return parseLanguageName(text) ?? grammar.parse(text) ?? { intent: "unrecognized", entities: {} };
}

/**
 * A written, reviewed step of a playbook. It was typed in whichever language
 * its author used and is run only after the user confirms the listed steps, so
 * it is read with every grammar rather than only the one switched on now.
 */
export function parseStoredCommand(rawText: string): ParsedCommand {
  for (const reader of [CANONICAL_COMMAND, "cs", "pl"]) {
    const command = parseTextCommand(rawText, reader);
    if (command.intent !== "unrecognized") return command;
  }
  return { intent: "unrecognized", entities: {} };
}

/**
 * "přeskoč ho", "další", "starší": moving through messages being read out, in
 * the language switched on. These words mean something only while a reading is
 * in progress, so the caller asks only then. `senders` are the sender just read
 * and the one named as next: words after "přeskoč" count only when they name
 * one of them.
 */
export function readingControl(rawText: string, reader: string, context: { addressedAs?: string[]; senders?: Array<string | undefined> } = {}): ParsedCommand | undefined {
  let said = fold(bare(rawText).replace(/[,;:]+/g, " "));
  // In an open conversation the name may still lead the sentence ("Alfonzo, přeskoč").
  for (const name of (context.addressedAs ?? []).map(fold).filter(Boolean)) {
    if (said.startsWith(`${name} `)) { said = said.slice(name.length + 1); break; }
  }
  const grammar = grammarFor(reader);
  if (grammar.readingSkip.test(said)) return { intent: "next_message_sender", entities: {} };
  if (grammar.readingOlder.test(said)) return { intent: "older_sender_messages", entities: {} };
  const named = said.match(grammar.readingSkipNamed)?.[1];
  if (named && (context.senders ?? []).some((sender) => sender && namedIn(named, sender))) {
    return { intent: "next_message_sender", entities: { sender: named } };
  }
  return undefined;
}

/** A bare yes to the one review that is waiting, in the language switched on. */
export function isGmailConfirmationPhrase(rawText: string, reader: string) {
  const said = bare(rawText);
  return grammarFor(reader).yes.test(said) || said === "confirm action";
}

/** A bare no to the one review that is waiting, in the language switched on. */
export function isGmailCancellationPhrase(rawText: string, reader: string) {
  const said = bare(rawText);
  return grammarFor(reader).no.test(said) || said === "cancel action";
}

/**
 * Whether the user asked for this language themselves, rather than the model
 * inferring it. A guard, not a reading of a command, so it recognises a request
 * to switch in any language.
 */
export function isExplicitVoiceLanguageChange(text: string, language: VoiceLanguage): boolean {
  const cleaned = text.trim().replace(/[.!?]+$/g, "");
  for (const grammar of Object.values(GRAMMARS)) {
    const command = parseLanguageSwitch(cleaned, grammar.languageSwitch) ?? parseLanguageName(cleaned);
    if (command) return command.entities.language === language;
  }
  // No grammar recognised the sentence — which is why it reached the model.
  // Whether the language was named is the question that can still be answered.
  return mentionsLanguage(cleaned, language);
}
