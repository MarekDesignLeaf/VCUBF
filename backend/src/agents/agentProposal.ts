/**
 * The agent acting — masterplan F2b, layers D and E; project description §5,
 * §39–42 and §48.
 *
 * Where an administrator switched the agent on and the request's language and
 * path passed the shadow acceptance (agentMode.ts), a request the voice
 * interpretation recognised as a multi-step objective (kind "plan") goes to the
 * agent instead of only being read out. The agent:
 *  - runs reading tools at once, under the user's own permissions and the
 *    administrator's capability switches, and sees what they return, so a step
 *    names the exact record instead of a guess;
 *  - never runs a tool that changes something: each such call becomes one
 *    step of a proposal, previewed by its owning service where the service
 *    previews (the same review a spoken command gets);
 *  - hands back one proposal. It is read out in full and approved with one yes,
 *    bound to exactly that proposal through the Execution Engine (§41): the
 *    stored steps are fingerprinted, re-validated when claimed, and a changed
 *    proposal is never executed.
 *
 * On the yes the steps run in order through the same service paths a spoken
 * command takes, and stop at the first failure; the answer says which steps
 * ran. Switching the agent off withdraws a waiting proposal at its next yes
 * (the rollback of F2), and an emergency stop refuses the claim.
 *
 * Some tools are never part of a proposal, whatever the request (§48, layer
 * L): administration — the assistant's own permissions and behaviour, an
 * employee's terms — and connector governance — signing in, disconnecting,
 * switching or reconfiguring a connection, or changing the sending account. So
 * are commands with a review of their own, language changes and remembering.
 *
 * Decision D4 holds: the agent run and the audit keep tool names, kinds and
 * fingerprints — never the text of a request, a read result or a message.
 */

import type { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import { z } from "zod";
import { prisma } from "../db.js";
import type { AuthedUser } from "../middleware/auth.js";
import { recordAudit } from "../lib/audit.js";
import { EXECUTE_AGENT_PROPOSAL_ACTION } from "../lib/actionContracts.js";
import { buildId } from "../lib/buildInfo.js";
import { CANONICAL_COMMAND, parseTextCommand, type ParsedCommand } from "../lib/commandParser.js";
import { COMMAND_POLICY } from "../lib/emmaSurfaceCatalogue.js";
import {
  EMMA_EXECUTABLE_ACTIONS,
  isEmmaExecutableActionName,
  type EmmaExecutableActionName,
  type EmmaExecutableActionRequest,
} from "../lib/emmaExecutableActionCatalogue.js";
import {
  cancelReviewedAction,
  claimReviewedAction,
  hasReviewedActionPending,
  prepareReviewedAction,
  type ReviewedActionDefinition,
} from "../lib/executionEngine.js";
import { modelFor, modelRequest, recordUsage } from "../lib/modelGateway.js";
import { SAFE_MODE_ACTIVE, safeModeMessage, safeModeSince } from "../lib/safeMode.js";
import { spokenCancelled, spokenCompleted, spokenError, spokenOutcome, spokenReview } from "../lib/spokenActionMessages.js";
import { validateVoiceActionParameters } from "../lib/voiceActionCatalogue.js";
import { evaluateEmmaCommand } from "../services/emmaPolicyService.js";
import { executeApprovedEmmaAction, executeEmmaAction, previewEmmaActionForProposal } from "../services/emmaExecutableActionService.js";
import { agentMayActFor } from "./agentMode.js";
import { scopeOf, SPECIALIST_IDS, SPECIALISTS, type SpecialistId, type SpecialistScope } from "./specialists.js";
import {
  AGENT_FUNCTION_TOOLS,
  type FunctionTool,
  AGENT_RUN_BUDGET,
  AGENT_TOOLSET_FINGERPRINT,
  argumentsFingerprint,
  bridgeArgumentsSchema,
  COMMAND_BRIDGE,
  requestFingerprint,
} from "./shadowAgent.js";
import { AGENT_TOOL_CATALOGUE, TOOL_CATALOGUE_FINGERPRINT, TOOL_CATALOGUE_VERSION } from "./toolCatalogue.js";

type Row = Record<string, any>;

/**
 * Run budgets (decision D5): at most six tool calls and fifteen seconds per
 * run, and never later than the caller's own deadline (the voice client waits
 * eighteen seconds for its answer). Four model rounds are enough to read,
 * read what the first read pointed to, and propose.
 */
export const AGENT_ACT_BUDGET = {
  maxRounds: 4,
  maxCalls: AGENT_RUN_BUDGET.maxSteps,
  maxOutputTokens: 800,
  deadlineMs: 15_000,
  /** Below this, a run would only time out: the request is read out as a plan instead. */
  minimumTimeMs: 4_000,
  /** What one read hands back to the model, at most. */
  readResultChars: 4_000,
  /**
   * The longest proposal that is put up. The Windows companion speaks at most
   * 900 characters and shows the rest; a yes must never approve steps that
   * were not heard, so a longer proposal is not put up at all.
   */
  maxProposalChars: 900,
} as const;

/** The tool catalogue by name. */
const catalogueTools = new Map(AGENT_TOOL_CATALOGUE.map((tool) => [tool.name as string, tool]));

/**
 * Tools an agent never proposes (§48):
 *  - administration, and governance of the connectors — what Secretary may
 *    reach and as whom; an administrator does these directly;
 *  - playbooks — running one executes stored steps that are neither read out
 *    nor checked step by step here, and writing one would store such steps;
 *  - the assistant's own settings, memory and learning rules, which change how
 *    Secretary hears and answers — only the user's explicit words do that.
 * A test keeps every administration tool on this list.
 */
export const AGENT_NEVER_PROPOSES: ReadonlySet<string> = new Set([
  ...AGENT_TOOL_CATALOGUE.filter((tool) => tool.kind === "administration").map((tool) => tool.name as string),
  "start_gmail_oauth", "start_google_contacts_oauth", "start_google_calendar_oauth", "start_google_drive_oauth", "start_google_photos_oauth",
  "disconnect_gmail", "disconnect_google_contacts", "disconnect_google_calendar", "disconnect_google_drive", "disconnect_google_photos",
  "disconnect_whatsapp", "enable_connector_source", "disable_connector_source", "update_connector_source", "set_default_email_account",
  "run_playbook", "create_playbook", "update_playbook",
  "set_assistant_name", "set_hotword", "set_speech_rate", "archive_memory", "archive_learning_rule", "reactivate_learning_rule",
]);

/**
 * Parser commands a proposal may carry: changes whose owning service acts at
 * once, so the proposal's yes is their review — run as a confirmed workflow,
 * exactly as a confirmed playbook runs them. Not here: commands with a review
 * of their own (archiving, deleting notifications, the message flows — the send
 * and reply tools are used instead, and they are reviewed), language changes
 * (only the user's own explicit words switch the language), remembering and
 * learning rules (only an explicit "remember"), and connector administration.
 */
export const AGENT_PROPOSABLE_COMMANDS: ReadonlySet<ParsedCommand["intent"]> = new Set<ParsedCommand["intent"]>([
  "create_client", "update_client", "create_contact", "update_contact", "create_lead", "update_lead", "convert_lead",
  "create_job", "change_job_status", "assign_job", "create_service", "create_task", "change_task_status",
  "log_communication", "log_portfolio_photo",
]);

/**
 * Reading commands the planner gets no use from: pages and menus make sense
 * only on a screen, and moving through messages being read out is the user's
 * own place in a reading.
 */
const READS_NOT_RUN = new Set<string>(["navigate", "describe_menu", "unrecognized", "next_message_sender", "older_sender_messages"]);

function isApprovalTurn(intent: string) {
  return intent.startsWith("confirm_") || intent.startsWith("cancel_");
}

function isReadCommand(intent: ParsedCommand["intent"]) {
  return COMMAND_POLICY[intent].mode === "read" && !READS_NOT_RUN.has(intent);
}

// ---------------------------------------------------------------------------
// The proposal as it waits for its yes.

const actionStepSchema = z.object({
  kind: z.literal("action"),
  action: z.string(),
  parameters: z.record(z.unknown()),
  /** The action answers with a preview: it runs with the yes it was reviewed for. */
  reviewed: z.boolean(),
  description: z.string(),
}).strict();

const commandStepSchema = z.object({
  kind: z.literal("command"),
  /** One canonical command, parsed again by the parser when it runs. */
  command: z.string().min(1),
  intent: z.string(),
  description: z.string(),
}).strict();

const stepSchema = z.discriminatedUnion("kind", [actionStepSchema, commandStepSchema]);
export type ProposalStep = z.infer<typeof stepSchema>;

/** Key order does not survive the database's JSON; the fingerprint must not depend on it. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * What the yes approves: every step and the words it was read out with. Keyed
 * like every agent fingerprint, so a stored proposal cannot be rewritten
 * together with a matching fingerprint without the server's secret.
 */
export function proposalFingerprint(steps: readonly ProposalStep[]): string {
  return argumentsFingerprint(`agent-proposal:${stableJson(steps)}`);
}

/** What a step does, without the words: two calls doing the same thing are one step. */
function stepIdentity(step: ProposalStep): string {
  const { description: _description, ...operation } = step;
  return stableJson(operation);
}

/** Why a stored step may no longer be executed; undefined when it still may. */
function stepProblem(step: ProposalStep): string | undefined {
  if (step.kind === "action") {
    if (!isEmmaExecutableActionName(step.action)) return "The step's action is not executable.";
    if (AGENT_NEVER_PROPOSES.has(step.action)) return "The step's action is never part of a proposal.";
    if (step.reviewed !== (EMMA_EXECUTABLE_ACTIONS[step.action].confirmation === "service_preview")) return "The step's review no longer matches its action.";
    const validated = validateVoiceActionParameters(step.action, step.parameters);
    return validated.success ? undefined : validated.message;
  }
  const command = parseTextCommand(step.command, CANONICAL_COMMAND);
  if (command.intent !== step.intent) return "The step's command no longer reads as it did.";
  return AGENT_PROPOSABLE_COMMANDS.has(command.intent) ? undefined : "The step's command is not proposable.";
}

export const proposalPayloadSchema = z.object({
  version: z.literal(1),
  fingerprint: z.string(),
  steps: z.array(stepSchema).min(1).max(AGENT_ACT_BUDGET.maxCalls),
}).strict().superRefine((payload, context) => {
  if (proposalFingerprint(payload.steps) !== payload.fingerprint) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["fingerprint"], message: "The proposal changed after it was read out." });
  }
  payload.steps.forEach((step, index) => {
    const problem = stepProblem(step);
    if (problem) context.addIssue({ code: z.ZodIssueCode.custom, path: ["steps", index], message: problem });
  });
});

export type ProposalPayload = z.infer<typeof proposalPayloadSchema>;

export const AGENT_PROPOSAL_REVIEW: ReviewedActionDefinition<ProposalPayload> = {
  actionType: "agent_proposal",
  lifetimeMs: 10 * 60 * 1000,
  payloadSchema: proposalPayloadSchema,
  replacedStatus: "replaced",
};

export function hasAgentProposalPending(user: AuthedUser): Promise<boolean> {
  return hasReviewedActionPending(user, AGENT_PROPOSAL_REVIEW.actionType);
}

// ---------------------------------------------------------------------------
// Words. Czech, Polish or English like every review; the assistant is male.

type Locale = "cs" | "pl" | "en";

function localeOf(language: string): Locale {
  const code = language.slice(0, 2).toLowerCase();
  return code === "cs" || code === "pl" ? code : "en";
}

function quoted(value: unknown, lang: Locale) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return lang === "en" ? `“${text}”` : `„${text}“`;
}

function humanize(name: string) {
  return name.replaceAll("_", " ");
}

/** A review without the question that asks for its yes: the proposal asks once, at the end. */
export function withoutQuestion(text: string): string {
  return text.trim().replace(/\s+[^.!?“”„"]+\?$/u, "").trim();
}

function sentence(text: string) {
  const value = text.trim();
  return /[.!?…]$/u.test(value) ? value : `${value}.`;
}

/** A step as it is read out: the owning service's own review where it has one, else exactly what will be given. */
export function describeActionStep(action: string, parameters: Record<string, unknown>, preview: Row | undefined, language: string): string {
  const reviewed = preview ? spokenReview(action, preview, language) : undefined;
  if (reviewed) return withoutQuestion(reviewed);
  const lang = localeOf(language);
  // The tool twin of the task status command reads the same way.
  if (action === "set_task_status" && typeof parameters.task_title === "string" && typeof parameters.task_status === "string") {
    const phrase = commandPhrase({ intent: "change_task_status", entities: { title: parameters.task_title, task_status: parameters.task_status as never } }, lang);
    if (phrase) return phrase;
  }
  const fields = Object.entries(parameters)
    .filter(([key, value]) => value !== undefined && key !== "confirmed")
    .map(([key, value]) => `${humanize(key)} ${quoted(value, lang)}`);
  return fields.length ? `${humanize(action)}: ${fields.join(", ")}` : humanize(action);
}

const TASK_STATUS_WORDS: Record<string, Record<Locale, string>> = {
  open: { cs: "otevřený", pl: "otwarte", en: "open" },
  in_progress: { cs: "rozpracovaný", pl: "w toku", en: "in progress" },
  completed: { cs: "hotový", pl: "zakończone", en: "completed" },
  cancelled: { cs: "zrušený", pl: "anulowane", en: "cancelled" },
};

/** How a logged contact happened, in words; the direction is said separately. */
const CHANNEL_WORDS: Record<string, Record<Locale, string>> = {
  phone_call: { cs: "hovor", pl: "rozmowa telefoniczna", en: "a call" },
  email: { cs: "e-mail", pl: "e-mail", en: "an e-mail" },
  whatsapp: { cs: "zpráva na WhatsAppu", pl: "wiadomość WhatsApp", en: "a WhatsApp message" },
  sms: { cs: "SMS", pl: "SMS", en: "a text message" },
  messenger: { cs: "zpráva", pl: "wiadomość", en: "a message" },
  in_person: { cs: "osobní schůzka", pl: "spotkanie osobiste", en: "a meeting" },
  other: { cs: "jiný kontakt", pl: "inny kontakt", en: "another contact" },
};

/** ", e-mail …, telefon …" — only the values the command carries. */
function contactDetails(lang: Locale, details: { name?: string; email?: string; phone?: string }) {
  const words = lang === "cs" ? { name: "jméno", email: "e-mail", phone: "telefon" }
    : lang === "pl" ? { name: "nazwa", email: "e-mail", phone: "telefon" }
      : { name: "name", email: "email", phone: "phone" };
  return [
    details.name ? `${words.name} ${quoted(details.name, lang)}` : "",
    details.email ? `${words.email} ${details.email}` : "",
    details.phone ? `${words.phone} ${details.phone}` : "",
  ].filter(Boolean).join(", ");
}

/**
 * A parser command as it is read out: what it will do, in the user's language,
 * with the values the parser read from it — worded as a noun phrase,
 * so the same words serve the proposal and, with "– done", the outcome.
 * Commands without wording are read out literally.
 */
function commandPhrase(command: ParsedCommand, lang: Locale): string | undefined {
  const q = (value: string) => quoted(value, lang);
  const pick = (cs: string, pl: string, en: string) => (lang === "cs" ? cs : lang === "pl" ? pl : en);
  const withDetails = (lead: string, details: string) => (details ? `${lead}, ${details}` : lead);
  switch (command.intent) {
    case "create_client": {
      const e = command.entities;
      return withDetails(pick(`Nový klient ${e.display_name}`, `Nowy klient ${e.display_name}`, `New client ${e.display_name}`), contactDetails(lang, { email: e.email_primary, phone: e.phone_primary }));
    }
    case "update_client": {
      const e = command.entities;
      const details = contactDetails(lang, { name: e.display_name, email: e.email_primary, phone: e.phone_primary });
      return `${pick(`Úprava klienta ${e.client_name}`, `Zmiana klienta ${e.client_name}`, `Change to client ${e.client_name}`)}${details ? `: ${details}` : ""}`;
    }
    case "create_contact": {
      const e = command.entities;
      return withDetails(pick(`Nový kontakt ${e.display_name}`, `Nowy kontakt ${e.display_name}`, `New contact ${e.display_name}`), contactDetails(lang, { email: e.email, phone: e.phone }));
    }
    case "update_contact": {
      const e = command.entities;
      const details = contactDetails(lang, { name: e.display_name, email: e.email, phone: e.phone });
      return `${pick(`Úprava kontaktu ${e.contact_name}`, `Zmiana kontaktu ${e.contact_name}`, `Change to contact ${e.contact_name}`)}${details ? `: ${details}` : ""}`;
    }
    case "create_lead": {
      const e = command.entities;
      const service = e.service_requested ? pick(` na ${q(e.service_requested)}`, ` na ${q(e.service_requested)}`, ` for ${q(e.service_requested)}`) : "";
      return withDetails(pick(`Nová poptávka ${e.name}${service}`, `Nowe zapytanie ${e.name}${service}`, `New lead ${e.name}${service}`), contactDetails(lang, { email: e.email, phone: e.phone }));
    }
    case "convert_lead":
      return pick(`Převod poptávky ${command.entities.lead_name} na klienta`, `Zamiana zapytania ${command.entities.lead_name} na klienta`, `Lead ${command.entities.lead_name} converted to a client`);
    case "create_job":
      return pick(`Nová zakázka ${q(command.entities.job_title)} pro klienta ${command.entities.client_name}`, `Nowe zlecenie ${q(command.entities.job_title)} dla klienta ${command.entities.client_name}`, `New job ${q(command.entities.job_title)} for client ${command.entities.client_name}`);
    case "change_job_status":
      return pick(`Zakázka ${q(command.entities.job_title)} do stavu ${q(command.entities.job_status)}`, `Zlecenie ${q(command.entities.job_title)} w stanie ${q(command.entities.job_status)}`, `Job ${q(command.entities.job_title)} set to ${q(command.entities.job_status)}`);
    case "assign_job":
      return pick(`Zakázka ${q(command.entities.job_title)} přidělená: ${command.entities.employee_name}`, `Zlecenie ${q(command.entities.job_title)} przydzielone: ${command.entities.employee_name}`, `Job ${q(command.entities.job_title)} assigned to ${command.entities.employee_name}`);
    case "create_service": {
      const category = command.entities.category ? pick(`, kategorie ${q(command.entities.category)}`, `, kategoria ${q(command.entities.category)}`, `, category ${q(command.entities.category)}`) : "";
      return pick(`Nová služba ${q(command.entities.name)}${category}`, `Nowa usługa ${q(command.entities.name)}${category}`, `New service ${q(command.entities.name)}${category}`);
    }
    case "create_task": {
      const e = command.entities;
      const who = e.employee_name ? pick(` pro ${e.employee_name}`, ` dla ${e.employee_name}`, ` for ${e.employee_name}`) : "";
      const due = e.due_at ? pick(`, termín ${e.due_at}`, `, termin ${e.due_at}`, `, due ${e.due_at}`) : "";
      return pick(`Nový úkol ${q(e.title)}${who}${due}`, `Nowe zadanie ${q(e.title)}${who}${due}`, `New task ${q(e.title)}${who}${due}`);
    }
    case "change_task_status": {
      const status = TASK_STATUS_WORDS[command.entities.task_status]?.[lang] ?? command.entities.task_status;
      return pick(`Úkol ${q(command.entities.title)} do stavu ${status}`, `Zadanie ${q(command.entities.title)} w stanie ${status}`, `Task ${q(command.entities.title)} set to ${status}`);
    }
    case "log_communication": {
      const e = command.entities;
      const channel = CHANNEL_WORDS[e.channel]?.[lang] ?? e.channel;
      const inbound = e.direction === "inbound";
      return pick(
        `Záznam: ${channel} ${inbound ? "od klienta" : "klientovi"} ${e.client_name}: ${q(e.summary)}`,
        `Zapis: ${channel} ${inbound ? "od klienta" : "do klienta"} ${e.client_name}: ${q(e.summary)}`,
        `Record of ${channel} ${inbound ? "from" : "to"} client ${e.client_name}: ${q(e.summary)}`,
      );
    }
    default:
      return undefined;
  }
}

export function describeCommandStep(command: string, language: string): string {
  const lang = localeOf(language);
  const phrase = commandPhrase(parseTextCommand(command, CANONICAL_COMMAND), lang);
  if (phrase) return phrase;
  const lead = lang === "cs" ? "příkaz" : lang === "pl" ? "polecenie" : "command";
  return `${lead} ${quoted(command, lang)}`;
}

function leftOutSentence(names: readonly string[], lang: Locale) {
  if (!names.length) return "";
  const list = [...new Set(names)].join(", ");
  return lang === "cs"
    ? `Do návrhu jsem nezařadil: ${list}. To musíte udělat sami.`
    : lang === "pl"
      ? `Nie uwzględniłem w propozycji: ${list}. To musisz zrobić sam.`
      : `I left out of the proposal: ${list}. You would do that yourself.`;
}

function tooLongMessage(lang: Locale) {
  return lang === "cs"
    ? "Návrh by byl moc dlouhý na to, abych vám ho celý přečetl, a tak jsem nic nepřipravil. Rozdělte to prosím na menší části."
    : lang === "pl"
      ? "Propozycja byłaby za długa, żeby przeczytać ją w całości, więc niczego nie przygotowałem. Podziel to proszę na mniejsze części."
      : "The proposal would be too long to read out in full, so I have not prepared anything. Please split it into smaller requests.";
}

function czechSteps(count: number) {
  return count >= 2 && count <= 4 ? "kroky" : "kroků";
}

function polishSteps(count: number) {
  return count >= 2 && count <= 4 ? "kroki" : "kroków";
}

/** The whole proposal, read out before the one yes. */
export function proposalMessage(steps: readonly ProposalStep[], leftOut: readonly string[], language: string): string {
  const lang = localeOf(language);
  const list = steps.map((step, index) => `${index + 1}. ${sentence(step.description)}`).join(" ");
  const left = leftOutSentence(leftOut, lang);
  const one = steps.length === 1;
  const parts = lang === "cs"
    ? [one ? "Navrhuji tento krok:" : `Navrhuji ${steps.length} ${czechSteps(steps.length)}:`, list, left, one ? "Mám ho provést?" : "Mám je všechny provést?"]
    : lang === "pl"
      ? [one ? "Proponuję ten krok:" : `Proponuję ${steps.length} ${polishSteps(steps.length)}:`, list, left, one ? "Czy mam go wykonać?" : "Czy mam wykonać je wszystkie?"]
      : [one ? "I propose one step:" : `I propose ${steps.length} steps:`, list, left, one ? "Shall I carry it out?" : "Shall I carry out all of them?"];
  return parts.filter(Boolean).join(" ");
}

interface StepOutcome {
  ok: boolean;
  httpStatus: number;
  error?: string;
  message?: string;
}

/** What happened on the yes: each step that ran, the one that failed, and that the rest did not run. */
export function executionMessage(outcomes: readonly StepOutcome[], total: number, language: string): string {
  const lang = localeOf(language);
  const lines = outcomes.map((outcome, index) => {
    if (outcome.ok) return `${index + 1}. ${sentence(outcome.message || spokenCompleted(language))}`;
    const reason = sentence(outcome.message || outcome.error || "?");
    return `${index + 1}. ${lang === "cs" ? "Nepovedlo se" : lang === "pl" ? "Nie udało się" : "Failed"}: ${reason}`;
  }).join(" ");
  const done = outcomes.filter((outcome) => outcome.ok).length;
  if (done === total) return `${lang === "cs" ? "Hotovo." : lang === "pl" ? "Gotowe." : "Done."} ${lines}`;
  const remaining = total - outcomes.length;
  const lead = lang === "cs"
    ? `Provedl jsem ${done} z ${total} kroků.`
    : lang === "pl" ? `Wykonałem ${done} z ${total} kroków.` : `I carried out ${done} of ${total} steps.`;
  const rest = remaining <= 0
    ? ""
    : lang === "cs"
      ? `Zbylé kroky (${remaining}) jsem neprovedl.`
      : lang === "pl" ? `Pozostałych kroków (${remaining}) nie wykonałem.` : `I did not carry out the remaining ${remaining === 1 ? "step" : `${remaining} steps`}.`;
  return [lead, lines, rest].filter(Boolean).join(" ");
}

function claimRefusal(reason: "none" | "raced" | "invalid", lang: Locale): { error: string; message: string } {
  if (reason === "raced") {
    return {
      error: "PENDING_ACTION_ALREADY_RESOLVED",
      message: lang === "cs" ? "Tenhle návrh už byl vyřízený." : lang === "pl" ? "Ta propozycja została już załatwiona." : "That proposal has already been dealt with.",
    };
  }
  if (reason === "invalid") {
    return {
      error: "PENDING_ACTION_INVALID",
      message: lang === "cs"
        ? "Návrh se od přečtení změnil nebo už neplatí, a tak jsem nic neprovedl. Řekněte to prosím znovu."
        : lang === "pl"
          ? "Propozycja zmieniła się od odczytania albo już nie obowiązuje, więc nic nie wykonałem. Powiedz to proszę jeszcze raz."
          : "The proposal changed after it was read out or is no longer valid, so nothing was done. Please ask again.",
    };
  }
  return {
    error: "NO_PENDING_ACTION",
    message: lang === "cs" ? "Žádný návrh teď nečeká na potvrzení." : lang === "pl" ? "Żadna propozycja nie czeka teraz na potwierdzenie." : "No proposal is waiting for your yes.",
  };
}

function agentOffMessage(lang: Locale) {
  return lang === "cs"
    ? "Agent je vypnutý, a tak jsem jeho návrh zrušil a nic neprovedl."
    : lang === "pl"
      ? "Agent jest wyłączony, więc anulowałem jego propozycję i nic nie wykonałem."
      : "The agent is switched off, so I withdrew its proposal and did nothing.";
}

// ---------------------------------------------------------------------------
// Planning: reads run, changes are collected.

type CallUse = "route" | "read" | "step" | "refused" | "invalid";

/** One tool call as recorded on the agent run: never its arguments, only their fingerprint (D4). */
interface CallRecord {
  tool: string;
  kind: string;
  key: string | null;
  valid: boolean;
  argumentsFingerprint: string;
  use: CallUse;
}

interface PlanState {
  user: AuthedUser;
  language: string;
  /** The specialists' tools when the orchestrator chose roles; undefined plans with the whole catalogue. */
  scope?: SpecialistScope;
  /** How the orchestrator routed the request, recorded ahead of the calls. */
  route?: CallRecord;
  /** No tool runs after this (epoch milliseconds). */
  deadline: number;
  steps: ProposalStep[];
  leftOut: string[];
  calls: CallRecord[];
  tokensIn: number;
  tokensOut: number;
  rounds: number;
}

class AgentPlanError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function resultText(value: unknown): string {
  const text = JSON.stringify(value) ?? "null";
  return text.length > AGENT_ACT_BUDGET.readResultChars
    ? `${text.slice(0, AGENT_ACT_BUDGET.readResultChars)}… [truncated]`
    : text;
}

function record(state: PlanState, call: Omit<CallRecord, "argumentsFingerprint">, fingerprint: string) {
  state.calls.push({ ...call, argumentsFingerprint: fingerprint });
}

function collect(state: PlanState, step: ProposalStep, call: Omit<CallRecord, "argumentsFingerprint" | "use" | "valid">, fingerprint: string): string {
  const identity = stepIdentity(step);
  const existing = state.steps.findIndex((candidate) => stepIdentity(candidate) === identity);
  record(state, { ...call, valid: true, use: "step" }, fingerprint);
  if (existing >= 0) return `Already step ${existing + 1}; it is not added twice.`;
  state.steps.push(step);
  return `Collected as step ${state.steps.length} of the proposal. It runs only after the user's yes; do not call it again.`;
}

async function dispatcher() {
  // Imported when used: the command executor also dispatches the yes to this module.
  return (await import("../lib/commandExecutor.js")).dispatchParsedCommand;
}

async function handleAction(
  state: PlanState,
  action: EmmaExecutableActionName,
  parameters: unknown,
  call: { tool: string; kind: string },
  fingerprint: string,
): Promise<string> {
  const key = `execute_action:${action}`;
  if (AGENT_NEVER_PROPOSES.has(action)) {
    record(state, { ...call, key, valid: true, use: "refused" }, fingerprint);
    state.leftOut.push(humanize(action));
    return "This tool is never part of a proposal: an administrator does it directly. Do not call it again.";
  }
  if (state.scope && !state.scope.tools.has(action)) {
    // Outside the chosen roles: refused, and named, so the user hears it is not part of the proposal.
    record(state, { ...call, key, valid: true, use: "refused" }, fingerprint);
    state.leftOut.push(humanize(action));
    return "That tool is not available for this request. Use only the tools you are shown.";
  }
  const validated = validateVoiceActionParameters(action, parameters);
  if (!validated.success) {
    record(state, { ...call, key, valid: false, use: "invalid" }, fingerprint);
    return `Invalid parameters: ${validated.message}`;
  }
  const request: EmmaExecutableActionRequest = { action, parameters: validated.data };
  const tool = catalogueTools.get(action)!;
  const reads = tool.kind === "read" && EMMA_EXECUTABLE_ACTIONS[action].confirmation === "none";
  const decision = await evaluateEmmaCommand(state.user, { intent: "execute_action", entities: request });
  if (!decision.allowed) {
    record(state, { ...call, key, valid: true, use: "refused" }, fingerprint);
    if (!reads) state.leftOut.push(humanize(action));
    return `Not allowed: ${decision.message}`;
  }
  if (reads) {
    const result = await executeEmmaAction(state.user, request);
    record(state, { ...call, key, valid: result.ok, use: "read" }, fingerprint);
    return resultText(result.ok ? { ok: true, data: result.data } : { ok: false, error: result.error, message: result.message });
  }
  if (EMMA_EXECUTABLE_ACTIONS[action].confirmation === "service_preview") {
    const { result, reviewed } = await previewEmmaActionForProposal(state.user, request);
    if (result.ok) {
      // The service needed no yes: there was nothing to change.
      record(state, { ...call, key, valid: true, use: "read" }, fingerprint);
      return `Nothing to change, so this is not a step: ${resultText(result.data)}`;
    }
    if (result.error !== "CONFIRMATION_REQUIRED") {
      record(state, { ...call, key, valid: false, use: "invalid" }, fingerprint);
      return resultText({ ok: false, error: result.error, message: spokenError(result.error, result.extra, state.language) ?? result.message });
    }
    const preview = result.extra?.preview as Row | undefined;
    return collect(state, {
      kind: "action",
      action,
      parameters: reviewed.parameters,
      reviewed: true,
      description: describeActionStep(action, reviewed.parameters, preview, state.language),
    }, { ...call, key }, fingerprint);
  }
  return collect(state, {
    kind: "action",
    action,
    parameters: request.parameters,
    reviewed: false,
    description: describeActionStep(action, request.parameters, undefined, state.language),
  }, { ...call, key }, fingerprint);
}

async function handleCommand(state: PlanState, canonical: string, command: ParsedCommand, fingerprint: string): Promise<string> {
  const call = { tool: COMMAND_BRIDGE, kind: "command", key: command.intent === "unrecognized" ? null : command.intent };
  if (command.intent === "unrecognized") {
    record(state, { ...call, valid: false, use: "invalid" }, fingerprint);
    return "That is not one of the canonical commands. Use one of the listed forms exactly.";
  }
  if (isApprovalTurn(command.intent)) {
    record(state, { ...call, valid: true, use: "refused" }, fingerprint);
    return "Approvals and cancellations come from the user, never from a tool call.";
  }
  if (state.scope && !state.scope.intents.has(command.intent)) {
    record(state, { ...call, valid: true, use: "refused" }, fingerprint);
    if (!isReadCommand(command.intent)) state.leftOut.push(humanize(command.intent));
    return "That command is not available for this request. Use only the commands listed for it.";
  }
  if (isReadCommand(command.intent)) {
    const decision = await evaluateEmmaCommand(state.user, command);
    if (!decision.allowed) {
      record(state, { ...call, valid: true, use: "refused" }, fingerprint);
      return `Not allowed: ${decision.message}`;
    }
    const response = await (await dispatcher())(state.user, command, { planning: true });
    record(state, { ...call, valid: response.ok, use: "read" }, fingerprint);
    return resultText({ ok: response.ok, error: response.error, message: response.message, data: response.data });
  }
  if (READS_NOT_RUN.has(command.intent)) {
    record(state, { ...call, valid: true, use: "refused" }, fingerprint);
    return "Opening pages, reading menus and moving through a reading aloud are not part of planning.";
  }
  if (!AGENT_PROPOSABLE_COMMANDS.has(command.intent)) {
    record(state, { ...call, valid: true, use: "refused" }, fingerprint);
    state.leftOut.push(humanize(command.intent));
    return "This command cannot be part of a proposal; the user does it directly. Do not call it again. Messages go through the send and reply tools.";
  }
  const decision = await evaluateEmmaCommand(state.user, command);
  if (!decision.allowed) {
    record(state, { ...call, valid: true, use: "refused" }, fingerprint);
    state.leftOut.push(humanize(command.intent));
    return `Not allowed: ${decision.message}`;
  }
  const text = canonical.trim();
  return collect(state, { kind: "command", command: text, intent: command.intent, description: describeCommandStep(text, state.language) }, call, fingerprint);
}

async function handleCall(state: PlanState, name: string, rawArguments: string): Promise<string> {
  // A preview can take a while (a translation, a calendar lookup); past the
  // deadline the caller has given up, and nothing more is done for it.
  if (Date.now() > state.deadline) throw new AgentPlanError("TIMEOUT");
  const fingerprint = argumentsFingerprint(rawArguments);
  let args: unknown;
  try {
    args = JSON.parse(rawArguments);
  } catch {
    args = undefined;
  }
  if (name === COMMAND_BRIDGE) {
    const bridge = bridgeArgumentsSchema.safeParse(args);
    if (!bridge.success) {
      record(state, { tool: name, kind: "command", key: null, valid: false, use: "invalid" }, fingerprint);
      return `Invalid arguments: ${COMMAND_BRIDGE} takes exactly one canonical_command.`;
    }
    // The parser is the authority on what a canonical command means.
    const command = parseTextCommand(bridge.data.canonical_command, CANONICAL_COMMAND);
    if (command.intent === "execute_action") {
      return handleAction(state, command.entities.action, command.entities.parameters, { tool: name, kind: "command" }, fingerprint);
    }
    return handleCommand(state, bridge.data.canonical_command, command, fingerprint);
  }
  const tool = catalogueTools.get(name);
  if (!tool) {
    record(state, { tool: name, kind: "unknown", key: null, valid: false, use: "invalid" }, fingerprint);
    return `There is no tool called ${name}.`;
  }
  return handleAction(state, tool.name, args, { tool: name, kind: tool.kind }, fingerprint);
}

/** The command bridge as a role sees it: only the role's canonical forms. */
function scopedBridge(forms: readonly string[]): FunctionTool {
  const bridge = AGENT_FUNCTION_TOOLS.find((tool) => tool.name === COMMAND_BRIDGE)!;
  return {
    ...bridge,
    description:
      "Run one Secretary command, written in exactly one of the canonical forms below. Fill the placeholders only with values the user gave " +
      "or a read returned; keep names and message text exactly as said.\n" + forms.join("\n"),
  };
}

function toolsetFingerprintOf(tools: readonly FunctionTool[]): string {
  return createHash("sha256").update(JSON.stringify(tools)).digest("hex");
}

/** The tools the model is shown: the chosen roles' tools, or the whole catalogue. */
export function toolsFor(scope: SpecialistScope | undefined): readonly FunctionTool[] {
  if (!scope) return AGENT_FUNCTION_TOOLS;
  return [scopedBridge(scope.forms), ...AGENT_FUNCTION_TOOLS.filter((tool) => scope.tools.has(tool.name))];
}

function actingInstructions(language: string, scope: SpecialistScope | undefined) {
  const roles = scope
    ? `\nFor this request you work as these specialists, with only their tools:\n${scope.instructions}`
    : "";
  return `You are the planning layer of Secretary, a business operating system. Carry out the user's request with the tools.
Tools marked read, and ${COMMAND_BRIDGE} with a listing command, run at once and you see what they return: use them to find the exact records a step needs (names, titles, times, addresses, numbers) instead of guessing.
Every other call changes something and is not run now: it becomes one step of a proposal that the user hears in full and approves with a single yes. Call each changing tool once, in the order the steps should run, all together once you know what they need, with the exact values the user gave or a read returned.
For a Secretary command, call ${COMMAND_BRIDGE} with one canonical command.
Never invent names, identifiers, addresses, dates, amounts or message text. Keep names and message text exactly as the user said them; Secretary translates a message into the language it is sent in before the user hears it.
If something a step needs cannot be found, call no changing tool at all and say in one short sentence what is missing.
When the request needs no change, answer it in one or two short sentences using only what the reads returned.
Use at most ${AGENT_ACT_BUDGET.maxCalls} tool calls in total. The user speaks ${language}; answer in that language.${roles}`;
}

// ---------------------------------------------------------------------------
// The orchestrator's first decision (F3): which specialists plan the request.

/**
 * The routing call may use at most this much of the run's time, and never what
 * the planner needs: with less than a second to spare it is skipped and the
 * whole catalogue plans.
 */
const ROUTE_TIMEOUT_MS = 2_500;

const routeSchema = z.object({ specialists: z.array(z.enum([...SPECIALIST_IDS, "other"])) }).strict();

function routerInstructions() {
  return `You route a business request to Secretary's specialists. Choose every specialist the request needs, including one that only supplies information (a client's e-mail address or phone number comes from crm).
${SPECIALIST_IDS.map((id) => `- ${id}: ${SPECIALISTS[id].covers}`).join("\n")}
- other: anything none of them covers — quotes, invoices, payments, documents, recruitment, employees, photos, the website, services, playbooks, settings and connectors.
A specialist can do only what its line says; anything else (for example changing a client's details) is other. If any part of the request is "other", include "other". Answer only with the JSON.`;
}

function outputText(output: ModelOutputItem[] | undefined): string {
  return (output ?? [])
    .flatMap((item) => item.content ?? [])
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("")
    .trim();
}

/**
 * Choose the roles. A request wholly within the three roles is planned with
 * only their tools; anything else — "other", nothing chosen, or a routing
 * call that failed — is planned with the whole catalogue, exactly as before.
 */
async function route(state: PlanState, input: AgentInput, deadline: number): Promise<void> {
  const remaining = deadline - Date.now();
  if (remaining < 1_000) throw new AgentPlanError("TIMEOUT");
  const budget = Math.min(ROUTE_TIMEOUT_MS, remaining - AGENT_ACT_BUDGET.minimumTimeMs);
  if (budget < 1_000) {
    // Not enough time for both: the planner goes first, with the whole catalogue.
    state.route = { tool: "choose_specialists", kind: "orchestrator", key: "skipped", valid: true, argumentsFingerprint: argumentsFingerprint(""), use: "route" };
    return;
  }
  const model = modelFor("agent_plan");
  let raw = "";
  let chosen: Array<SpecialistId | "other"> | undefined;
  try {
    const response = await modelRequest("agent_plan", "/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(budget),
      body: JSON.stringify({
        model,
        store: false,
        ...(model.startsWith("gpt-5") ? { reasoning: { effort: model.startsWith("gpt-5.4") ? "none" : "minimal" } } : {}),
        max_output_tokens: 100,
        instructions: routerInstructions(),
        input: [...input.history, { role: "user", content: input.text }],
        text: {
          format: {
            type: "json_schema",
            name: "specialists",
            strict: true,
            schema: {
              type: "object",
              properties: { specialists: { type: "array", items: { type: "string", enum: [...SPECIALIST_IDS, "other"] } } },
              required: ["specialists"],
              additionalProperties: false,
            },
          },
        },
      }),
    });
    if (response.ok) {
      const body = (await response.json()) as { output?: ModelOutputItem[]; usage?: { input_tokens?: number; output_tokens?: number } };
      recordUsage("agent_plan", body.usage);
      state.tokensIn += typeof body.usage?.input_tokens === "number" ? body.usage.input_tokens : 0;
      state.tokensOut += typeof body.usage?.output_tokens === "number" ? body.usage.output_tokens : 0;
      raw = outputText(body.output);
      const parsed = routeSchema.safeParse(JSON.parse(raw));
      if (parsed.success) chosen = parsed.data.specialists;
    }
  } catch {
    // Routing is an optimisation of the tool set, never a gate: without it the whole catalogue plans.
  }
  const roles = chosen && chosen.length > 0 && !chosen.includes("other") ? (chosen as SpecialistId[]) : undefined;
  state.scope = roles ? scopeOf(roles) : undefined;
  state.route = {
    tool: "choose_specialists",
    kind: "orchestrator",
    key: state.scope ? state.scope.specialists.join("+") : "general",
    valid: chosen !== undefined,
    argumentsFingerprint: argumentsFingerprint(raw),
    use: "route",
  };
}

interface ModelOutputItem {
  type?: string;
  name?: string;
  arguments?: string;
  call_id?: string;
  content?: Array<{ type?: string; text?: string }>;
}

/** The model plans in rounds: reads are answered and it continues; a round of only changes ends it. */
async function plan(state: PlanState, input: AgentInput, deadline: number): Promise<{ answer?: string }> {
  const model = modelFor("agent_plan");
  const items: unknown[] = [];
  for (let round = 0; round < AGENT_ACT_BUDGET.maxRounds; round++) {
    const remaining = deadline - Date.now();
    if (remaining < 1_000) throw new AgentPlanError("TIMEOUT");
    state.rounds = round + 1;
    const response = await modelRequest("agent_plan", "/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(remaining),
      body: JSON.stringify({
        model,
        store: false,
        ...(model.startsWith("gpt-5") ? { reasoning: { effort: model.startsWith("gpt-5.4") ? "none" : "minimal" } } : {}),
        max_output_tokens: AGENT_ACT_BUDGET.maxOutputTokens,
        instructions: actingInstructions(input.language, state.scope),
        input: [...input.history, { role: "user", content: input.text }, ...items],
        tools: toolsFor(state.scope),
        tool_choice: "auto",
        parallel_tool_calls: true,
      }),
    });
    if (!response.ok) throw new AgentPlanError(`HTTP_${response.status}`);
    const body = (await response.json()) as {
      status?: string;
      incomplete_details?: { reason?: string } | null;
      output?: ModelOutputItem[];
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    recordUsage("agent_plan", body.usage);
    state.tokensIn += typeof body.usage?.input_tokens === "number" ? body.usage.input_tokens : 0;
    state.tokensOut += typeof body.usage?.output_tokens === "number" ? body.usage.output_tokens : 0;
    if (body.status !== undefined && body.status !== "completed") {
      throw new AgentPlanError(body.incomplete_details?.reason === "max_output_tokens" ? "OUTPUT_BUDGET" : `INCOMPLETE_${body.incomplete_details?.reason ?? body.status}`);
    }
    const output = body.output ?? [];
    const calls = output.filter((item) => item.type === "function_call" && typeof item.name === "string" && typeof item.call_id === "string");
    if (calls.length === 0) {
      const answer = output
        .filter((item) => item.type === "message")
        .flatMap((item) => item.content ?? [])
        .map((part) => (typeof part.text === "string" ? part.text : ""))
        .join(" ")
        .trim();
      return { answer: answer || undefined };
    }
    if (state.calls.length + calls.length > AGENT_ACT_BUDGET.maxCalls) throw new AgentPlanError("STEP_BUDGET");
    const before = state.calls.length;
    for (const call of calls) {
      items.push({ type: "function_call", call_id: call.call_id, name: call.name, arguments: call.arguments ?? "" });
    }
    for (const call of calls) {
      const result = await handleCall(state, call.name!, typeof call.arguments === "string" ? call.arguments : "");
      items.push({ type: "function_call_output", call_id: call.call_id, output: result });
    }
    // Nothing the model must react to: every call of this round became a step.
    // Otherwise it reads what came back — unless no round is left to do so.
    if (state.calls.slice(before).every((entry) => entry.use === "step")) return {};
  }
  throw new AgentPlanError("ROUND_BUDGET");
}

// ---------------------------------------------------------------------------
// Entry points.

export interface AgentInput {
  user: AuthedUser;
  language: string;
  /** The request as interpreted. Sent to the model, never stored. */
  text: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  /** When the caller must answer at the latest (epoch milliseconds). */
  deadline: number;
}

export type AgentOutcome =
  | { kind: "proposal"; message: string; steps: string[]; fingerprint: string }
  | { kind: "answer"; message: string }
  | { kind: "fallback"; reason: string };

/**
 * Whether a plan request goes to the agent: the switch, the acceptance for
 * this language on the voice path, no emergency stop (agentMayActFor), and the
 * administrator has not switched the agent's proposals off in the assistant's
 * permissions.
 */
export async function agentMayHandle(user: AuthedUser, language: string): Promise<boolean> {
  const mode = await agentMayActFor(user.companyId, language, "assistant");
  if (!mode.allowed) return false;
  return (await evaluateEmmaCommand(user, "confirm_agent_proposal")).allowed;
}

function stepSummary(step: ProposalStep) {
  return step.kind === "action"
    ? { kind: step.kind, action: step.action, reviewed: step.reviewed, fields: Object.keys(step.parameters).sort() }
    : { kind: step.kind, intent: step.intent };
}

async function recordRun(
  input: AgentInput,
  state: PlanState,
  startedAt: number,
  outcome: { status: "completed" | "error" | "budget_exceeded"; errorCode?: string },
) {
  try {
    await prisma.agentRun.create({
      data: {
        companyId: input.user.companyId,
        userId: input.user.id,
        mode: "proposal",
        channel: "assistant",
        language: input.language,
        inputFingerprint: requestFingerprint(input.text),
        catalogueVersion: TOOL_CATALOGUE_VERSION,
        catalogueFingerprint: TOOL_CATALOGUE_FINGERPRINT,
        // What this run was actually shown: a specialist plan sees a subset.
        toolsetFingerprint: state.scope ? toolsetFingerprintOf(toolsFor(state.scope)) : AGENT_TOOLSET_FINGERPRINT,
        build: buildId(),
        model: modelFor("agent_plan"),
        status: outcome.status,
        errorCode: outcome.errorCode ?? null,
        steps: state.calls.length,
        // The routing decision first, then every call (the route is not a call and not counted in steps).
        proposedTools: [...(state.route ? [state.route] : []), ...state.calls] as unknown as Prisma.InputJsonValue,
        parserIntent: "assistant_plan",
        parserAction: null,
        // Not compared with anything: a plan has no parser reference. Errors
        // are marked as errors so the Control Tower counts them.
        agreement: outcome.status === "completed" ? "not_compared" : "error",
        tokensIn: state.tokensIn || null,
        tokensOut: state.tokensOut || null,
        durationMs: Date.now() - startedAt,
      },
    });
  } catch (error) {
    console.error("[agent] could not record the run", error instanceof Error ? error.message : error);
  }
}

/**
 * Hand a plan request to the agent. Returns the proposal (put up for one yes),
 * an answer (the request needed no change), or "fallback" — the caller then
 * reads the plan out as before. A failed run never changes anything.
 */
export async function proposeWithAgent(input: AgentInput): Promise<AgentOutcome> {
  const startedAt = Date.now();
  const deadline = Math.min(input.deadline, startedAt + AGENT_ACT_BUDGET.deadlineMs);
  const state: PlanState = { user: input.user, language: input.language, deadline, steps: [], leftOut: [], calls: [], tokensIn: 0, tokensOut: 0, rounds: 0 };
  if (deadline - startedAt < AGENT_ACT_BUDGET.minimumTimeMs) {
    await recordRun(input, state, startedAt, { status: "error", errorCode: "NO_TIME_LEFT" });
    return { kind: "fallback", reason: "NO_TIME_LEFT" };
  }

  let answer: string | undefined;
  try {
    await route(state, input, deadline);
    ({ answer } = await plan(state, input, deadline));
  } catch (error) {
    const code = error instanceof AgentPlanError
      ? error.code
      : error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
        ? "TIMEOUT"
        : error instanceof Error && error.message === "OPENAI_NOT_CONFIGURED" ? error.message : "ERROR";
    if (code === "ERROR") console.error("[agent] planning failed", error instanceof Error ? error.message : error);
    const overBudget = ["STEP_BUDGET", "ROUND_BUDGET", "OUTPUT_BUDGET", "TIMEOUT"].includes(code);
    await recordRun(input, state, startedAt, { status: overBudget ? "budget_exceeded" : "error", errorCode: code });
    return { kind: "fallback", reason: code };
  }

  const lang = localeOf(input.language);
  if (state.steps.length === 0) {
    const message = [answer, leftOutSentence(state.leftOut, lang)].filter(Boolean).join(" ");
    await recordRun(input, state, startedAt, { status: "completed" });
    return message ? { kind: "answer", message } : { kind: "fallback", reason: "NOTHING_PROPOSED" };
  }

  const steps = state.steps;
  const message = proposalMessage(steps, state.leftOut, input.language);
  if (message.length > AGENT_ACT_BUDGET.maxProposalChars) {
    await recordRun(input, state, startedAt, { status: "budget_exceeded", errorCode: "PROPOSAL_TOO_LONG" });
    return { kind: "answer", message: tooLongMessage(lang) };
  }
  // The caller has given up by now: a proposal stored after that would wait
  // for a yes to something nobody heard.
  if (Date.now() > deadline) {
    await recordRun(input, state, startedAt, { status: "budget_exceeded", errorCode: "TIMEOUT" });
    return { kind: "fallback", reason: "TIMEOUT" };
  }
  const fingerprint = proposalFingerprint(steps);
  await prepareReviewedAction(input.user, AGENT_PROPOSAL_REVIEW, { version: 1, fingerprint, steps });
  await recordAudit({
    companyId: input.user.companyId,
    userId: input.user.id,
    actionName: EXECUTE_AGENT_PROPOSAL_ACTION.actionName,
    interpretedIntent: "agent_proposal",
    inputPayload: { fingerprint, specialists: state.scope?.specialists ?? "general", steps: steps.map(stepSummary), leftOut: [...new Set(state.leftOut)] },
    riskLevel: EXECUTE_AGENT_PROPOSAL_ACTION.riskLevel,
    confirmationRequired: true,
    confirmed: false,
    result: "error",
    errorMessage: "CONFIRMATION_REQUIRED",
  });
  await recordRun(input, state, startedAt, { status: "completed" });
  return {
    kind: "proposal",
    message,
    steps: steps.map((step) => step.description),
    fingerprint,
  };
}

export interface ProposalResult {
  ok: boolean;
  httpStatus: number;
  error?: string;
  message: string;
  data?: unknown;
}

/** "… – done": what a step did, when its service has no sentence of its own. */
function doneWith(what: string, language: string) {
  const lang = localeOf(language);
  return `${what} – ${lang === "cs" ? "hotovo" : lang === "pl" ? "gotowe" : "done"}`;
}

async function executeStep(user: AuthedUser, step: ProposalStep): Promise<StepOutcome> {
  if (step.kind === "action") {
    const request: EmmaExecutableActionRequest = { action: step.action as EmmaExecutableActionName, parameters: step.parameters };
    // The administrator may have switched a capability off since the proposal was read out.
    const decision = await evaluateEmmaCommand(user, { intent: "execute_action", entities: request });
    if (!decision.allowed) return { ok: false, httpStatus: 403, error: "EMMA_CAPABILITY_DISABLED", message: decision.message };
    const result = await executeApprovedEmmaAction(user, request, step.reviewed);
    if (result.ok) {
      const data = result.data as Row | undefined;
      return {
        ok: true,
        httpStatus: result.httpStatus,
        message: typeof data?.message === "string"
          ? data.message
          : spokenOutcome(step.action, data, user.voiceLanguage) ?? doneWith(humanize(step.action), user.voiceLanguage),
      };
    }
    return {
      ok: false,
      httpStatus: result.httpStatus,
      error: result.error,
      message: spokenError(result.error, result.extra, user.voiceLanguage) ?? result.message ?? result.error,
    };
  }
  const command = parseTextCommand(step.command, CANONICAL_COMMAND);
  const decision = await evaluateEmmaCommand(user, command);
  if (!decision.allowed) return { ok: false, httpStatus: 403, error: "EMMA_CAPABILITY_DISABLED", message: decision.message };
  const response = await (await dispatcher())(user, command, { confirmedWorkflow: true });
  // A command's own success sentence is about a screen ("opening jobs") or in
  // English only; the step as it was read out says what was done.
  return response.ok
    ? { ok: true, httpStatus: response.httpStatus, message: doneWith(step.description, user.voiceLanguage) }
    : { ok: false, httpStatus: response.httpStatus, error: response.error, message: response.message ?? response.error };
}

/** The yes to the waiting proposal: claim it once, run its steps in order, stop at the first failure. */
export async function confirmAgentProposal(user: AuthedUser): Promise<ProposalResult> {
  const lang = localeOf(user.voiceLanguage);
  const audit = { companyId: user.companyId, userId: user.id, actionName: EXECUTE_AGENT_PROPOSAL_ACTION.actionName, interpretedIntent: "confirm_agent_proposal", riskLevel: EXECUTE_AGENT_PROPOSAL_ACTION.riskLevel, confirmationRequired: true } as const;

  // The rollback of F2: once the agent is switched off, nothing it proposed runs.
  const company = await prisma.company.findUnique({ where: { id: user.companyId }, select: { agentEnabledAt: true } });
  if (!company?.agentEnabledAt) {
    const withdrawn = await cancelReviewedAction(user, AGENT_PROPOSAL_REVIEW.actionType);
    await recordAudit({ ...audit, inputPayload: { withdrawn }, result: "rejected", errorMessage: "AGENT_OFF" });
    return { ok: false, httpStatus: 409, error: "AGENT_OFF", message: agentOffMessage(lang) };
  }

  const claimed = await claimReviewedAction(user, AGENT_PROPOSAL_REVIEW);
  if (!claimed.ok) {
    const refusal = claimRefusal(claimed.reason, lang);
    await recordAudit({ ...audit, result: "error", errorMessage: refusal.error });
    return { ok: false, httpStatus: 409, ...refusal };
  }

  const { steps, fingerprint } = claimed.payload;
  const outcomes: StepOutcome[] = [];
  try {
    for (const step of steps) {
      // An emergency stop switched on while the steps run stops the rest.
      if (await safeModeSince(user.companyId)) {
        outcomes.push({ ok: false, httpStatus: 423, error: SAFE_MODE_ACTIVE, message: safeModeMessage(user.voiceLanguage) });
        break;
      }
      const outcome = await executeStep(user, step);
      outcomes.push(outcome);
      if (!outcome.ok) break;
    }
  } catch (error) {
    // A step threw instead of answering: what ran before it is still recorded.
    await claimed.complete(false);
    await recordAudit({
      ...audit,
      inputPayload: { fingerprint, steps: steps.map(stepSummary) },
      dataAfter: { outcomes: outcomes.map((outcome, index) => ({ step: index + 1, ok: outcome.ok, error: outcome.error })), thrownAtStep: outcomes.length + 1 },
      confirmed: true,
      result: "error",
      errorMessage: "STEP_THREW",
    });
    throw error;
  }
  const failed = outcomes.find((outcome) => !outcome.ok);
  const succeeded = !failed && outcomes.length === steps.length;
  await claimed.complete(succeeded);
  await recordAudit({
    ...audit,
    inputPayload: { fingerprint, steps: steps.map(stepSummary) },
    dataAfter: { outcomes: outcomes.map((outcome, index) => ({ step: index + 1, ok: outcome.ok, error: outcome.error })) },
    confirmed: true,
    result: succeeded ? "success" : "error",
    errorMessage: succeeded ? undefined : failed?.error ?? "STEP_FAILED",
  });
  return {
    ok: succeeded,
    httpStatus: succeeded ? 200 : failed?.httpStatus ?? 409,
    error: succeeded ? undefined : failed?.error ?? "STEP_FAILED",
    message: executionMessage(outcomes, steps.length, user.voiceLanguage),
    data: { steps: steps.length, completed: outcomes.filter((outcome) => outcome.ok).length },
  };
}

export async function cancelAgentProposal(user: AuthedUser): Promise<ProposalResult> {
  const cancelled = await cancelReviewedAction(user, AGENT_PROPOSAL_REVIEW.actionType);
  if (cancelled) {
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: EXECUTE_AGENT_PROPOSAL_ACTION.actionName,
      interpretedIntent: "cancel_agent_proposal",
      riskLevel: EXECUTE_AGENT_PROPOSAL_ACTION.riskLevel,
      confirmationRequired: true,
      result: "rejected",
      errorMessage: "CANCELLED_BY_USER",
    });
  }
  return { ok: true, httpStatus: 200, message: spokenCancelled(user.voiceLanguage), data: { cancelled } };
}
