/**
 * The specialists — masterplan F3, layer D; project description §6.
 *
 * A specialist is a role, not a process: a short instruction, the tools the
 * role needs and nothing more. The orchestrator (agentProposal.ts) first asks
 * which roles a request needs, then plans with only the union of their tools,
 * so the agent "receives only the information and tools required for its
 * role" (§6) and still puts up one proposal for one yes. A request no role
 * covers is planned with the whole catalogue, as before.
 *
 * The three roles are the three functions Marek wanted from the start:
 * communication (e-mail and WhatsApp, in English), scheduling (calendar, jobs,
 * tasks) and the CRM the addresses and numbers come from. Each role's tools are
 * enforced, not only offered: a call outside them is refused.
 */

import type { ParsedCommand } from "../lib/commandParser.js";
import type { EmmaExecutableActionName } from "../lib/emmaExecutableActionCatalogue.js";

export const SPECIALIST_IDS = ["communication", "scheduling", "crm"] as const;
export type SpecialistId = (typeof SPECIALIST_IDS)[number];

export interface Specialist {
  id: SpecialistId;
  /** What the orchestrator is told the role covers. */
  covers: string;
  /** What the planner is told while it works in this role. */
  instructions: string;
  /** Catalogue tools the role may call. */
  tools: readonly EmmaExecutableActionName[];
  /** Parser commands the role may send through the command bridge. */
  intents: readonly ParsedCommand["intent"][];
  /** The canonical forms of those commands, exactly as the parser's list writes them. */
  forms: readonly string[];
  /** One canonical command per intent, so a test proves forms and intents agree. */
  examples: readonly string[];
}

/** Reading customers: every role that writes to or about a customer needs it. */
const CUSTOMER_READS = {
  intents: ["list_clients", "list_contacts"] as const,
  forms: ["list clients", "list contacts"],
  examples: ["list clients", "list contacts"],
};

export const SPECIALISTS: Readonly<Record<SpecialistId, Specialist>> = {
  communication: {
    id: "communication",
    covers: "E-mail and WhatsApp: reading received messages, replying to them, sending new messages and drafts, marking messages as handled, and logging calls, e-mails and meetings with a client.",
    instructions:
      "Communication: a received message is answered with a reply tool, a new message with a send tool. Recipients' addresses and numbers come only from a read (clients, contacts, messages) or the user's own words. Keep the message text as the user said it; Secretary sends customer messages in English unless the user names another language, and translates before the user hears it.",
    tools: [
      "send_email", "reply_email", "send_whatsapp", "reply_whatsapp", "create_gmail_draft",
      "draft_communication_reply", "set_communication_intake_resolution", "resolve_communication_intakes",
      "convert_communication_intake",
    ],
    intents: ["list_channel_messages", "list_communications", "list_follow_ups", "list_unresolved_enquiries", "log_communication", ...CUSTOMER_READS.intents],
    forms: [
      "show emails",
      "show whatsapp messages",
      "list communications [for CLIENT NAME]",
      "list follow ups",
      "list unresolved enquiries [from the last N days]",
      "log call|email|meeting with|to|from CLIENT: SUMMARY",
      ...CUSTOMER_READS.forms,
    ],
    examples: [
      "show emails",
      "list communications for Petra Novak",
      "list follow ups",
      "list unresolved enquiries",
      "log call with Petra Novak: agreed the hedge on Friday",
      ...CUSTOMER_READS.examples,
    ],
  },
  scheduling: {
    id: "scheduling",
    covers: "Calendar and work planning: what is on when, creating, moving and cancelling calendar events, jobs and their status, assigning jobs, tasks, capacity and who is free.",
    instructions:
      "Scheduling: read the calendar (or the jobs and tasks) before moving, cancelling or changing anything, and name the exact event, job or task the read returned. Use only dates and times the user gave or a read returned; the calendar's preview reports any clash.",
    tools: ["create_calendar_event", "move_calendar_event", "cancel_calendar_event", "suggest_schedule", "check_capacity", "set_task_status"],
    intents: [
      "list_calendar_events", "list_jobs", "create_job", "change_job_status", "assign_job", "detect_overload", "create_task", "list_tasks",
      ...CUSTOMER_READS.intents,
    ],
    forms: [
      "show calendar today|tomorrow|next 7 days",
      "list jobs",
      "create job JOB TITLE for CLIENT NAME",
      "set job JOB TITLE as STATUS",
      "assign job JOB TITLE to EMPLOYEE NAME",
      "show overload",
      "create task for EMPLOYEE NAME: TITLE",
      "create task TITLE, assigned to EMPLOYEE NAME, due ISO DATE",
      "list tasks",
      ...CUSTOMER_READS.forms,
    ],
    examples: [
      "show calendar tomorrow",
      "list jobs",
      "create job Hedge trim for Petra Novak",
      "set job Hedge trim as dokonceno",
      "assign job Hedge trim to Daniel",
      "show overload",
      "create task for Daniel: Prepare materials",
      "list tasks",
      ...CUSTOMER_READS.examples,
    ],
  },
  crm: {
    id: "crm",
    covers: "Customers: clients, contacts and leads — finding them and their e-mail addresses and phone numbers, creating clients and leads, converting a lead, and merging duplicate clients.",
    instructions:
      "CRM: look for an existing record before creating one. E-mail addresses and phone numbers come only from these records or the user's own words; when two records match, say so instead of choosing one.",
    tools: ["merge_clients"],
    intents: ["create_client", "create_lead", "convert_lead", "list_leads", ...CUSTOMER_READS.intents],
    forms: [
      "create client NAME, email EMAIL, phone PHONE",
      "create lead NAME for SERVICE, email EMAIL, phone PHONE",
      "convert lead LEAD NAME",
      "list leads",
      ...CUSTOMER_READS.forms,
    ],
    examples: [
      "create client Jan Novy, email jan@example.com, phone 07700 900123",
      "create lead Jan Novy for hedge trimming, email jan@example.com, phone 07700 900123",
      "convert lead Jan Novy",
      "list leads",
      ...CUSTOMER_READS.examples,
    ],
  },
};

/** What a plan may use: the union of the chosen roles. */
export interface SpecialistScope {
  specialists: readonly SpecialistId[];
  tools: ReadonlySet<string>;
  intents: ReadonlySet<string>;
  forms: readonly string[];
  instructions: string;
}

export function scopeOf(ids: readonly SpecialistId[]): SpecialistScope {
  const chosen = SPECIALIST_IDS.filter((id) => ids.includes(id)).map((id) => SPECIALISTS[id]);
  return {
    specialists: chosen.map((specialist) => specialist.id),
    tools: new Set(chosen.flatMap((specialist) => specialist.tools)),
    intents: new Set(chosen.flatMap((specialist) => specialist.intents)),
    forms: [...new Set(chosen.flatMap((specialist) => specialist.forms))],
    instructions: chosen.map((specialist) => specialist.instructions).join("\n"),
  };
}
