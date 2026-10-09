// English commands.
//
// English is also the system's own internal language. The language model
// rewrites a request into one of these canonical forms, and the Windows
// companion confirms a review with fixed English phrases; both are read with
// this grammar whatever language is switched on. A sentence the user says is
// read with it only while English is switched on.

import type { ParsedCommand } from "../commandParser.js";
import { resolveNavigationSection } from "../navigationCatalogue.js";
import {
  connectorTarget, extractContact, extractLabelled, fold, nameOnly, normalizeDictatedPhone, parseAgendaCommand,
  parseEmailCommand, parseLanguageSwitch, parseNavigation, parseWhatsAppCommand, withoutFinalPunctuation,
  type CommandGrammar, type Parsed,
} from "./shared.js";

const UNPAID_INVOICE_QUESTION =
  /^(?:(?:how many )?unpaid invoices(?: do (?:i|we) have)?|how many outstanding invoices(?: do (?:i|we) have)?|who owes (?:us|me)(?: money)?|who (?:has|have)(?:n['’]?t| not) paid(?: (?:us|me))?|how much (?:are we|am i) owed)$/;

const CONNECTORS = {
  all: "all", connectors: "all", integrations: "all", "all connectors": "all", "all integrations": "all",
  email: "gmail", mail: "gmail", contacts: "google_contacts", calendar: "google_calendar", drive: "google_drive", photos: "google_photos",
} as const;
const CONNECTOR_TRIM = [/^(?:the|my)\s+/, /\s+(?:connector|integration)$/];

const LEAD_STATUS: Record<string, "new" | "contacted" | "qualified" | "lost"> = {
  new: "new", contacted: "contacted", qualified: "qualified", lost: "lost",
};

const CHANNELS: Record<string, string> = {
  call: "phone_call", "phone call": "phone_call", email: "email", whatsapp: "whatsapp", sms: "sms", text: "sms",
  messenger: "messenger", message: "messenger", meeting: "in_person", visit: "in_person", "e-mail": "email",
};

function speechRate(text: string): Parsed<"set_speech_rate"> | undefined {
  const normalized = fold(text).replace(/[.!?,]+$/g, "");
  const numeric = normalized.match(/(?:speed|tempo)\D{0,12}(\d+(?:[.,]\d+)?)/);
  if (numeric) {
    const value = Number(numeric[1].replace(",", "."));
    // Said as a percentage ("speed 130") rather than a multiplier.
    if (Number.isFinite(value)) return { intent: "set_speech_rate", entities: { rate: value > 3 ? value / 100 : value } };
  }
  if (/\b(faster|speed up|quicker)\b/.test(normalized)) return { intent: "set_speech_rate", entities: { change: "faster" } };
  if (/\b(slower|slow down)\b/.test(normalized)) return { intent: "set_speech_rate", entities: { change: "slower" } };
  // "normal" alone is ambiguous; it has to be about speaking.
  if (/\b(normal|default)\b/.test(normalized) && /\b(speak|talk|speed|tempo)\b/.test(normalized)) {
    return { intent: "set_speech_rate", entities: { change: "normal" } };
  }
  return undefined;
}

function menu(text: string): Parsed<"describe_menu"> | undefined {
  const normalized = withoutFinalPunctuation(text);
  if (/^(?:read|show|list|describe)(?:\s+me)?\s+(?:the\s+)?(?:whole|full|complete|all)?\s*(?:menu|navigation)(?:\s+(?:tree|contents|items))?$/iu.test(normalized)
    || /^(?:what(?:'s|\s+is)\s+(?:in\s+)?(?:the\s+)?(?:menu|navigation)|what\s+can\s+i\s+do(?:\s+in\s+(?:the\s+)?(?:app|secretary))?)$/iu.test(normalized)) {
    return { intent: "describe_menu", entities: {} };
  }
  const named = normalized.match(/^(?:read|show|list|describe)(?:\s+me)?\s+(?:the\s+)?(?:whole|full|complete)?\s*(?:menu|navigation)(?:\s+section)?\s+(.+)$/iu);
  const section = named ? resolveNavigationSection(named[1]) : undefined;
  return section ? { intent: "describe_menu", entities: { section } } : undefined;
}

function notificationDeletion(text: string): ParsedCommand | undefined {
  const normalized = withoutFinalPunctuation(text);
  // "confirm delete notifications" is the exact form the language model and the
  // companion are told to use; it is listed with the other verbs for that reason.
  if (/^(?:confirm|approve)\s+(?:delete|deleting|deletion|removing|clearing)\s+(?:all\s+)?notifications?$/iu.test(normalized)) {
    return { intent: "confirm_delete_notifications", entities: {} };
  }
  if (/^(?:cancel|stop|abort)\s+(?:delete|deleting|deletion|removing|clearing)\s+(?:all\s+)?notifications?$/iu.test(normalized)) {
    return { intent: "cancel_delete_notifications", entities: {} };
  }
  if (/^(?:delete|remove|clear|dismiss)\s+(?:all\s+)?notifications?$/iu.test(normalized)) {
    return { intent: "prepare_delete_notifications", entities: {} };
  }
  return undefined;
}

function clientMutation(text: string): ParsedCommand | undefined {
  const normalized = withoutFinalPunctuation(text);
  if (/^(?:confirm|approve)\s+(?:the\s+)?(?:client\s+)?(?:deletion|archive|archiving)$/iu.test(normalized)) return { intent: "confirm_archive_client", entities: {} };
  if (/^(?:cancel|stop|abort)\s+(?:the\s+)?(?:client\s+)?(?:deletion|archive|archiving)$/iu.test(normalized)) return { intent: "cancel_archive_client", entities: {} };

  let match = normalized.match(/^(?:delete|remove|archive)\s+(?:the\s+)?client\s+(.+)$/iu);
  if (match) return { intent: "prepare_archive_client", entities: { client_name: match[1].trim() } };
  match = normalized.match(/^rename\s+(?:the\s+)?client\s+(.+?)\s+to\s+(.+)$/iu);
  if (match) return { intent: "update_client", entities: { client_name: match[1].trim(), display_name: match[2].trim() } };
  match = normalized.match(/^(?:change|set|update)\s+(?:the\s+)?(?:email|email address)\s+(?:for|of)\s+(?:the\s+)?client\s+(.+?)\s+to\s+(\S+@\S+)$/iu)
    ?? normalized.match(/^(?:change|set|update)\s+(?:the\s+)?client\s+(.+?)\s+(?:email|email address)\s+to\s+(\S+@\S+)$/iu);
  if (match) return { intent: "update_client", entities: { client_name: match[1].trim(), email_primary: match[2].trim() } };
  match = normalized.match(/^(?:change|set|update)\s+(?:the\s+)?(?:phone|phone number)\s+(?:for|of)\s+(?:the\s+)?client\s+(.+?)\s+to\s+(.+)$/iu)
    ?? normalized.match(/^(?:change|set|update)\s+(?:the\s+)?client\s+(.+?)\s+(?:phone|phone number)\s+to\s+(.+)$/iu);
  if (match) return { intent: "update_client", entities: { client_name: match[1].trim(), phone_primary: match[2].trim() } };

  match = normalized.match(/^(?:update|edit)\s+(?:the\s+)?client\s+(.+)$/iu);
  if (match) {
    let rest = match[1];
    const email = extractLabelled(rest, "email");
    rest = email.rest;
    const newName = extractLabelled(rest, "new name");
    rest = newName.rest;
    // Phone last: dictated digits may be comma-separated and take the remainder.
    const phone = extractLabelled(rest, "phone", true);
    rest = phone.rest;
    const clientName = nameOnly(rest);
    if (clientName && (email.value || phone.value || newName.value)) {
      return {
        intent: "update_client",
        entities: { client_name: clientName, email_primary: email.value, phone_primary: normalizeDictatedPhone(phone.value), display_name: newName.value },
      };
    }
  }
  return undefined;
}

function contactMutation(text: string): ParsedCommand | undefined {
  const normalized = withoutFinalPunctuation(text);
  if (/^(?:confirm|approve)\s+(?:the\s+)?contact\s+(?:deletion|archive|archiving)$/iu.test(normalized)) return { intent: "confirm_archive_contact", entities: {} };
  if (/^(?:cancel|stop|abort)\s+(?:the\s+)?contact\s+(?:deletion|archive|archiving)$/iu.test(normalized)) return { intent: "cancel_archive_contact", entities: {} };
  let match = normalized.match(/^(?:delete|remove|archive)\s+(?:the\s+)?contact\s+(.+)$/iu);
  if (match) return { intent: "prepare_archive_contact", entities: { contact_name: match[1].trim() } };
  match = normalized.match(/^rename\s+(?:the\s+)?contact\s+(.+?)\s+to\s+(.+)$/iu);
  if (match) return { intent: "update_contact", entities: { contact_name: match[1].trim(), display_name: match[2].trim() } };
  match = normalized.match(/^(?:change|set|update)\s+(?:the\s+)?(?:email|email address)\s+(?:for|of)\s+(?:the\s+)?contact\s+(.+?)\s+to\s+(\S+@\S+)$/iu);
  if (match) return { intent: "update_contact", entities: { contact_name: match[1].trim(), email: match[2].trim() } };
  match = normalized.match(/^(?:change|set|update)\s+(?:the\s+)?(?:phone|phone number)\s+(?:for|of)\s+(?:the\s+)?contact\s+(.+?)\s+to\s+(.+)$/iu);
  if (match) return { intent: "update_contact", entities: { contact_name: match[1].trim(), phone: match[2].trim() } };
  return undefined;
}

// "converted" is absent from the status words on purpose: saying it would claim
// a client record that only conversion creates.
function leadMutation(text: string): Parsed<"update_lead"> | undefined {
  const normalized = withoutFinalPunctuation(text);
  let match = normalized.match(/^rename\s+(?:the\s+)?lead\s+(.+?)\s+to\s+(.+)$/iu);
  if (match) return { intent: "update_lead", entities: { lead_name: match[1].trim(), name: match[2].trim() } };
  match = normalized.match(/^(?:change|set|update)\s+(?:the\s+)?(?:email|email address)\s+(?:for|of)\s+(?:the\s+)?lead\s+(.+?)\s+to\s+(\S+@\S+)$/iu);
  if (match) return { intent: "update_lead", entities: { lead_name: match[1].trim(), email: match[2].trim() } };
  match = normalized.match(/^(?:change|set|update)\s+(?:the\s+)?(?:phone|phone number)\s+(?:for|of)\s+(?:the\s+)?lead\s+(.+?)\s+to\s+(.+)$/iu);
  if (match) return { intent: "update_lead", entities: { lead_name: match[1].trim(), phone: normalizeDictatedPhone(match[2].trim()) } };
  match = normalized.match(/^(?:mark|set)\s+(?:the\s+)?lead\s+(.+?)\s+(?:as|to)\s+(.+)$/iu);
  const status = match ? LEAD_STATUS[match[2].trim().toLowerCase()] : undefined;
  // An unknown status word is not understood rather than guessed.
  if (match && status) return { intent: "update_lead", entities: { lead_name: match[1].trim(), lead_status: status } };
  return undefined;
}

function connectors(text: string): ParsedCommand | undefined {
  let match = text.match(/^(?:check|show|list)\s+(.+?)\s+(?:connector\s+)?status$/iu);
  let key = match ? connectorTarget(match[1], CONNECTORS, CONNECTOR_TRIM) : undefined;
  if (key) return { intent: "connector_status", entities: { connector_key: key } };
  if (/^(?:check|show|list)\s+(?:my\s+)?(?:connectors?|integrations?)(?:\s+status)?$/i.test(text)) return { intent: "connector_status", entities: { connector_key: "all" } };
  match = text.match(/^(?:set\s*up|setup|configure|connect|start|activate)\s+(.+)$/iu);
  key = match ? connectorTarget(match[1], CONNECTORS, CONNECTOR_TRIM) : undefined;
  if (key) return { intent: "setup_connectors", entities: { connector_key: key } };
  match = text.match(/^(?:sync|synchronise|synchronize|refresh)\s+(.+)$/iu);
  key = match ? connectorTarget(match[1], CONNECTORS, CONNECTOR_TRIM) : undefined;
  if (key) return { intent: "sync_connectors", entities: { connector_key: key } };
  return undefined;
}

function records(text: string): ParsedCommand | undefined {
  let m = text.match(/^(?:create|add|new)\s+client\s+(.+)$/i);
  if (m) {
    const contact = extractContact(m[1], { email: ["email"], phone: ["phone"] });
    const displayName = nameOnly(contact.rest);
    if (!displayName) return { intent: "unrecognized", entities: {} };
    return { intent: "create_client", entities: { display_name: displayName, email_primary: contact.email, phone_primary: contact.phone } };
  }

  m = text.match(/^(?:create|add|new)\s+contact\s+(.+)$/i);
  if (m) {
    const contact = extractContact(m[1], { email: ["email"], phone: ["phone"] });
    const displayName = nameOnly(contact.rest);
    if (!displayName || (!contact.email && !contact.phone)) return { intent: "unrecognized", entities: {} };
    return { intent: "create_contact", entities: { display_name: displayName, email: contact.email, phone: contact.phone } };
  }

  m = text.match(/^(?:create|add|new)\s+lead\s+(.+)$/i);
  if (m) {
    let rest = m[1];
    // "for <service>" first: the e-mail and phone fields would swallow it.
    const forMatch = rest.match(/\bfor\s+(.+)$/i);
    let service: string | undefined;
    // The canonical order puts e-mail and phone after the service
    // ("create lead NAME for SERVICE, email EMAIL, phone PHONE"): take them
    // out of the service too, or they would be stored as part of it.
    let fromService: { email?: string; phone?: string } = {};
    if (forMatch) {
      // Only labelled, comma-separated fields: "telephone repair" is a service.
      if (/,\s*(?:email|phone)(?!\p{L})/iu.test(forMatch[1])) {
        const trailing = extractContact(forMatch[1], { email: ["email"], phone: ["phone"] });
        service = nameOnly(trailing.rest) || undefined;
        fromService = { email: trailing.email, phone: trailing.phone };
      } else {
        service = forMatch[1].trim();
      }
      rest = rest.slice(0, forMatch.index).trim();
    }
    const contact = extractContact(rest, { email: ["email"], phone: ["phone"] });
    const name = nameOnly(contact.rest);
    if (!name) return { intent: "unrecognized", entities: {} };
    return {
      intent: "create_lead",
      entities: { name, service_requested: service, email: contact.email ?? fromService.email, phone: contact.phone ?? fromService.phone },
    };
  }

  m = text.match(/^(?:create|add|new)\s+job\s+(.+?)\s+for\s+(.+)$/i);
  if (m) {
    const jobTitle = m[1].trim();
    const clientName = m[2].trim();
    if (!jobTitle || !clientName) return { intent: "unrecognized", entities: {} };
    return { intent: "create_job", entities: { job_title: jobTitle, client_name: clientName } };
  }
  m = text.match(/^(?:set|change|mark)\s+job\s+(.+?)\s+(?:as|to|status)\s+(.+)$/i);
  if (m) return { intent: "change_job_status", entities: { job_title: m[1].trim(), job_status: m[2].trim() } };
  m = text.match(/^convert\s+lead\s+(.+)$/i);
  if (m) return { intent: "convert_lead", entities: { lead_name: m[1].trim() } };
  m = text.match(/^assign\s+job\s+(.+?)\s+to\s+(.+)$/i);
  if (m) return { intent: "assign_job", entities: { job_title: m[1].trim(), employee_name: m[2].trim() } };
  if (/^(?:show|check)\s+overload$/i.test(text)) return { intent: "detect_overload", entities: {} };

  // "create task for Daniel: Prepare materials"
  // "create task Prepare materials, assigned to Daniel, due 2026-08-01T09:00:00.000Z"
  m = text.match(/^(?:create|add|new)\s+task\s+for\s+(.+?)\s*:\s*(.+)$/i);
  if (m) {
    const employeeName = m[1].trim();
    const title = m[2].trim();
    if (!employeeName || !title) return { intent: "unrecognized", entities: {} };
    return { intent: "create_task", entities: { title, employee_name: employeeName } };
  }
  m = text.match(/^(?:create|add|new)\s+task\s+(.+)$/i);
  if (m) {
    let rest = m[1];
    const assigned = extractLabelled(rest, "assigned to");
    rest = assigned.rest;
    const due = extractLabelled(rest, "due");
    rest = due.rest;
    const title = nameOnly(rest);
    if (!title) return { intent: "unrecognized", entities: {} };
    return { intent: "create_task", entities: { title, employee_name: assigned.value, due_at: due.value } };
  }
  if (/^(?:list|show)\s+tasks?$/i.test(text)) return { intent: "list_tasks", entities: {} };
  m = text.match(/^(start|complete|cancel)\s+(?:task\s+)?(.+)$/i);
  if (m) {
    const verb = m[1].toLowerCase();
    const task_status = verb === "start" ? "in_progress" : verb === "complete" ? "completed" : "cancelled";
    return { intent: "change_task_status", entities: { title: m[2].trim(), task_status } };
  }

  m = text.match(/^(?:create|add|new)\s+service\s+(.+)$/i);
  if (m) {
    const category = extractLabelled(m[1], "category");
    const name = nameOnly(category.rest);
    if (!name) return { intent: "unrecognized", entities: {} };
    return { intent: "create_service", entities: { name, category: category.value } };
  }
  return undefined;
}

function knowledge(text: string): ParsedCommand | undefined {
  let m = text.match(/^(?:list|show)\s+quotes(?:\s+for\s+(.+))?$/i);
  if (m) return { intent: "list_quotes", entities: { client_name: m[1]?.trim() } };
  if (/^(?:list|show)\s+job\s+openings?$/i.test(text)) return { intent: "list_job_openings", entities: {} };
  m = text.match(/^when\s+i\s+say\s+(.+?)\s+i\s+mean\s+(.+)$/i)
    ?? text.match(/^(?:teach\s+me|remember)[:,]?\s+(.+?)\s+means\s+(.+)$/i);
  if (m) return { intent: "create_learning_rule", entities: { term: m[1].trim(), meaning: m[2].trim() } };
  if (/^(?:list|show)\s+learning\s+rules?$/i.test(text)) return { intent: "list_learning_rules", entities: {} };

  // Only a direct "remember" is ever kept; ordinary conversation never is.
  // Company scope has to be said, and the service checks crm.manage for it.
  m = text.match(/^remember\s+for\s+(?:the\s+)?company\s+(?:that\s+)?(.+)$/iu);
  if (m) return { intent: "create_assistant_memory", entities: { content: m[1].trim(), scope: "company" } };
  m = text.match(/^remember(?:\s+for\s+me)?\s+(?:that\s+)?(.+)$/iu);
  if (m) return { intent: "create_assistant_memory", entities: { content: m[1].trim(), scope: "personal" } };
  m = text.match(/^what\s+do\s+you\s+remember(?:\s+about\s+(.+?))?\??$/iu);
  if (m) return { intent: "recall_assistant_memory", entities: { query: m[1]?.trim() } };

  // "log call with Jane Smith: discussed timeline". With or to is outgoing,
  // from is incoming.
  m = text.match(/^log\s+(call|phone call|e-?mail|whatsapp|sms|text|messenger|message|meeting|visit)\s+(with|to|from)\s+(?:client\s+)?(.+?)\s*:\s*(.+)$/iu);
  if (m) {
    const clientName = m[3].trim();
    const summary = m[4].trim();
    if (!clientName || !summary) return { intent: "unrecognized", entities: {} };
    return {
      intent: "log_communication",
      entities: { client_name: clientName, channel: CHANNELS[fold(m[1])] ?? "other", direction: fold(m[2]) === "from" ? "inbound" : "outbound", summary },
    };
  }

  m = text.match(/^log\s+photo\s+(\S+)\s+for\s+(.+?)\s*:\s*(.+)$/i);
  if (m) {
    const caption = m[3].trim();
    if (!m[1].trim() || !caption) return { intent: "unrecognized", entities: {} };
    return { intent: "log_portfolio_photo", entities: { filename: m[1].trim(), client_name: m[2].trim(), caption } };
  }
  m = text.match(/^log\s+photo\s+(\S+)\s*:\s*(.+)$/i);
  if (m) {
    const caption = m[2].trim();
    if (!m[1].trim() || !caption) return { intent: "unrecognized", entities: {} };
    return { intent: "log_portfolio_photo", entities: { filename: m[1].trim(), caption } };
  }
  if (/^(?:list|show)\s+marketing\s+photos?$/i.test(text)) return { intent: "list_portfolio_photos", entities: { usable_for_marketing: true } };
  m = text.match(/^(?:list|show)\s+photos?(?:\s+for\s+(.+))?$/i);
  if (m) return { intent: "list_portfolio_photos", entities: { client_name: m[1]?.trim() } };
  if (/^(?:list|show)\s+follow[\s-]?ups?$/i.test(text)) return { intent: "list_follow_ups", entities: {} };

  m = text.match(/^(?:list|show|check|find)\s+unresolved\s+enquir(?:y|ies)(?:\s+(?:from|in)\s+(?:the\s+)?last\s+(?:([1-9]\d*)\s+days?|week))?$/i);
  if (m) {
    const sinceDays = m[1] ? Number(m[1]) : /\bweek\b/i.test(text) ? 7 : undefined;
    return { intent: "list_unresolved_enquiries", entities: { since_days: sinceDays } };
  }

  if (/^(?:list|show)\s+notifications?$/i.test(text) || /^notifications?$/i.test(text) || /^what\s+needs\s+attention\??$/i.test(text)) {
    return { intent: "list_notifications", entities: {} };
  }
  if (/^(?:list|show|check)\s+data\s+quality(?:\s+issues?)?$/i.test(text) || /^(?:list|show)\s+(?:possible\s+)?duplicate\s+clients?$/i.test(text)) {
    return { intent: "list_data_quality", entities: {} };
  }
  // merge_clients has no sentence on purpose: choosing two client ids out of a
  // duplicate pair and re-linking five kinds of record is not something one
  // spoken sentence can state or a review can check. It stays a form.
  if (/^(?:show|detect|list)\s+(?:repeated\s+)?(?:action\s+)?patterns?$/i.test(text)) return { intent: "detect_action_patterns", entities: {} };
  m = text.match(/^(?:list|show)\s+communications?(?:\s+for\s+(.+))?$/i);
  if (m) return { intent: "list_communications", entities: { client_name: m[1]?.trim() } };

  if (/^(?:list|show(?:\s+me)?|open)\s+clients?$/i.test(text)) return { intent: "list_clients", entities: {} };
  if (/^(?:list|show(?:\s+me)?|open)\s+contacts?$/i.test(text)) return { intent: "list_contacts", entities: {} };
  if (/^(?:list|show(?:\s+me)?|read|open)\s+(?:my\s+)?(?:email|mail)(?:\s+messages?)?s?$/i.test(text)) return { intent: "list_channel_messages", entities: { channel: "email" } };
  if (/^(?:list|show(?:\s+me)?|read|open)\s+(?:my\s+)?whatsapp(?:\s+messages?)?$/i.test(text)) return { intent: "list_channel_messages", entities: { channel: "whatsapp" } };
  if (/^(?:list|show(?:\s+me)?|open)\s+jobs?$/i.test(text)) return { intent: "list_jobs", entities: {} };
  if (/^(?:list|show(?:\s+me)?|open)\s+leads?$/i.test(text)) return { intent: "list_leads", entities: {} };
  return undefined;
}

export const english: CommandGrammar = {
  language: "en",
  yes: /^(?:yes|yeah|yep|confirm(?:\s+action)?|go ahead|do it|send it)$/iu,
  no: /^(?:no|cancel(?:\s+action)?|cancel it|cancel that|don't send|do not send|stop email)$/iu,
  languageSwitch: {
    patterns: [
      /^(?:set|change|switch)\s+(?:the\s+)?(?:(?:emma(?:'s)?|voice|menu|secretary)\s+)?language\s+(?:to\s+)?(.+)$/iu,
      /^(?:yes[,\s]+)?(?:change|switch)(?:\s+(?:yourself|over))?\s+to\s+(.+)$/iu,
      /^(?:please\s+)?(?:turn|set|change|switch)(?:\s+the)?(?:\s+language)?(?:\s+(?:on|to|into))?\s+(.+)$/iu,
      /^(?:speak|talk|respond)\s+(?:in\s+)?(.+)$/iu,
      /^language\s+(.+)$/iu,
      /^(.+)\s+language$/iu,
    ],
    fillers: ["the", "language", "now", "please", "to", "into", "on", "fucking", "set", "change", "switch", "turn"],
  },
  parse(text) {
    const question = fold(text).replace(/[.!?]+$/g, "").trim();
    // Answered from the real invoice balances without a round trip to the model.
    if (UNPAID_INVOICE_QUESTION.test(question)) return { intent: "execute_action", entities: { action: "get_unpaid_invoices", parameters: {} } };
    const found = parseLanguageSwitch(text, english.languageSwitch)
      ?? speechRate(text)
      ?? menu(text)
      ?? parseEmailCommand(text, {
        prefix: /^(?:send|write|compose)\s+(?:an?\s+)?(?:email|mail)\s+(?:from\s+(?<from>.+?)\s+)?to\s*:?\s*(?<rest>.+)$/iu,
        accountAfterRecipients: "from",
        accountSection: "from|sender|account",
        subject: "subject",
        body: "body|message|text",
      })
      ?? parseWhatsAppCommand(text, "(?:send|write)\\s+(?:a\\s+)?whatsapp\\s+(?:message\\s+)?to", "message|body|text")
      ?? parseAgendaCommand(text, {
        asks: /^(?:what|show|list|read|open|check|tell)(?:\s|$)/iu,
        calendar: /(?:calendar|schedule|events?|program)/iu,
        ownQuestion: /^what\s+do\s+i\s+have/iu,
        tomorrow: /tomorrow/iu,
        week: /(?:next\s+(?:seven|7)\s+days|this\s+week)/iu,
        today: /today/iu,
      })
      ?? notificationDeletion(text)
      ?? clientMutation(text)
      ?? leadMutation(text)
      ?? contactMutation(text);
    if (found) return found;
    if (/^(?:confirm|send)\s+(?:the\s+)?(?:email|message)(?:\s+now)?$/iu.test(text)) return { intent: "confirm_gmail_message", entities: {} };
    if (/^(?:cancel|discard)\s+(?:the\s+)?(?:email|message)$/iu.test(text)) return { intent: "cancel_gmail_message", entities: {} };
    if (/^(?:confirm|send)\s+(?:the\s+)?whatsapp(?:\s+message)?(?:\s+now)?$/iu.test(text)) return { intent: "confirm_whatsapp_message", entities: {} };
    if (/^(?:cancel|discard)\s+(?:the\s+)?whatsapp(?:\s+message)?$/iu.test(text)) return { intent: "cancel_whatsapp_message", entities: {} };
    // "Opan" and "oppen" are how speech recognition often writes "open". Only
    // the verb is forgiven; the page still has to be in the menu.
    return connectors(text)
      ?? records(text)
      ?? knowledge(text)
      ?? parseNavigation(text, "open|opan|oppen|go\\s+to|navigate\\s+to|take\\s+me\\s+to|show\\s+me");
  },
};
