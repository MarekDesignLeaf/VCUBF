// Text/Voice Understanding Layer — deterministic, rule-based intent parser.
//
// This is intentionally NOT an LLM call. Per the VCUF master documentation and
// the vcubf-programmer-skill "business logic rule", business decisions must be
// stored in structured form, not guessed by a prompt. This MVP slice proves
// the Voice/Text Command Layer -> Intent Layer -> Action Engine pipeline with
// a small, auditable set of deterministic patterns. It can be replaced or
// augmented by an LLM-assisted extraction step later WITHOUT changing the
// Action Engine underneath, because the parser's only job is to produce a
// structured ParsedCommand — the same shape an LLM-based parser would need to
// produce.
//
import { resolveVoicePage, type VoicePage } from "./voiceNavigation.js";
import type { ConnectorKey } from "../connectors/registry.js";
import { resolveVoiceLanguage, type VoiceLanguage } from "./voiceLanguages.js";

// If nothing matches, the result is `unrecognized` — the system must not
// guess (VCUF error handling rule).

export type ParsedCommand =
  | { intent: "create_client"; entities: { display_name: string; email_primary?: string; phone_primary?: string } }
  | {
      intent: "create_lead";
      entities: { name: string; service_requested?: string; email?: string; phone?: string };
    }
  | { intent: "create_job"; entities: { job_title: string; client_name: string } }
  | { intent: "change_job_status"; entities: { job_title: string; job_status: string } }
  | { intent: "convert_lead"; entities: { lead_name: string } }
  | { intent: "assign_job"; entities: { job_title: string; employee_name: string } }
  | { intent: "detect_overload"; entities: Record<string, never> }
  | { intent: "create_service"; entities: { name: string; category?: string } }
  | { intent: "create_task"; entities: { title: string; employee_name?: string; due_at?: string } }
  | { intent: "list_tasks"; entities: Record<string, never> }
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
  | { intent: "list_data_quality"; entities: Record<string, never> }
  | { intent: "detect_action_patterns"; entities: Record<string, never> }
  | { intent: "list_clients"; entities: Record<string, never> }
  | { intent: "list_contacts"; entities: Record<string, never> }
  | { intent: "list_channel_messages"; entities: { channel: "email" | "whatsapp" } }
  | {
      intent: "prepare_gmail_message";
      entities: { to: string[]; cc: string[]; bcc: string[]; subject: string; body: string };
    }
  | { intent: "confirm_gmail_message"; entities: Record<string, never> }
  | { intent: "cancel_gmail_message"; entities: Record<string, never> }
  | { intent: "set_voice_language"; entities: { language: VoiceLanguage } }
  | { intent: "connector_status"; entities: { connector_key: ConnectorKey | "all" } }
  | { intent: "setup_connectors"; entities: { connector_key: ConnectorKey | "all" } }
  | { intent: "sync_connectors"; entities: { connector_key: ConnectorKey | "all" } }
  | { intent: "list_jobs"; entities: Record<string, never> }
  | { intent: "list_leads"; entities: Record<string, never> }
  | { intent: "navigate"; entities: { page: VoicePage } }
  | { intent: "unrecognized"; entities: Record<string, never> };

function extractLabelled(text: string, label: string): { value?: string; rest: string } {
  const re = new RegExp(`,?\\s*${label}\\s*[:]?\\s*([^,]+)`, "i");
  const match = text.match(re);
  if (!match) return { rest: text };
  const value = match[1].trim();
  const rest = (text.slice(0, match.index) + text.slice((match.index ?? 0) + match[0].length)).trim();
  return { value, rest };
}

function resolveConnectorTarget(raw: string): ConnectorKey | "all" | undefined {
  const normalized = raw.trim().toLowerCase().replace(/[.!?]+$/g, "").replace(/[-_]+/g, " ").replace(/\s+/g, " ")
    .replace(/^(?:the|my)\s+/, "").replace(/\s+(?:connector|integration)$/, "");
  const aliases: Record<string, ConnectorKey | "all"> = {
    all: "all", connectors: "all", integrations: "all", "all connectors": "all", "all integrations": "all",
    gmail: "gmail", email: "gmail", mail: "gmail",
    "google contacts": "google_contacts", contacts: "google_contacts",
    "google calendar": "google_calendar", calendar: "google_calendar",
    "google drive": "google_drive", "google drive photos": "google_drive", drive: "google_drive",
    "google photos": "google_photos", "google photo": "google_photos", photos: "google_photos",
    whatsapp: "whatsapp_business", "whatsapp business": "whatsapp_business",
  };
  return aliases[normalized];
}

function parseEmailAddresses(raw: string) {
  return raw
    .split(/\s*(?:,|\band\b)\s*/i)
    .map((value) => value.trim())
    .filter(Boolean);
}

function parseGmailMessageCommand(text: string): Extract<ParsedCommand, { intent: "prepare_gmail_message" }> | undefined {
  const prefix = text.match(/^(?:send|write|compose)\s+(?:an?\s+)?(?:email|mail)\s+to\s*:?\s*(.+)$/i);
  if (!prefix) return undefined;
  const rest = prefix[1].trim();

  // A natural spoken form is often transcribed with commas. It intentionally
  // supports only To, Subject and Body; the semicolon form below also permits
  // CC and BCC without confusing commas inside the message body.
  const commaForm = rest.match(/^(.+?)\s*,\s*subject\s*:?\s*(.+?)\s*,\s*(?:body|message)\s*:?\s*(.+)$/i);
  if (commaForm) {
    const to = parseEmailAddresses(commaForm[1]);
    const subject = commaForm[2].trim();
    const body = commaForm[3].trim();
    if (to.length && subject && body) return { intent: "prepare_gmail_message", entities: { to, cc: [], bcc: [], subject, body } };
    return undefined;
  }

  const sections = rest.split(/\s*;\s*/);
  const to = parseEmailAddresses(sections.shift() ?? "");
  let cc: string[] = [];
  let bcc: string[] = [];
  let subject = "";
  let body = "";
  for (let index = 0; index < sections.length; index += 1) {
    const section = sections[index];
    let match = section.match(/^cc\s*:?\s*(.+)$/i);
    if (match) {
      cc = parseEmailAddresses(match[1]);
      continue;
    }
    match = section.match(/^bcc\s*:?\s*(.+)$/i);
    if (match) {
      bcc = parseEmailAddresses(match[1]);
      continue;
    }
    match = section.match(/^subject\s*:?\s*(.+)$/i);
    if (match) {
      subject = match[1].trim();
      continue;
    }
    match = section.match(/^(?:body|message)\s*:?\s*(.*)$/i);
    if (match) {
      body = [match[1], ...sections.slice(index + 1)].join("; ").trim();
      break;
    }
  }
  if (!to.length || !subject || !body) return undefined;
  return { intent: "prepare_gmail_message", entities: { to, cc, bcc, subject, body } };
}

function parseVoiceLanguageCommand(text: string): Extract<ParsedCommand, { intent: "set_voice_language" }> | undefined {
  const patterns = [
    /^(?:set|change|switch)\s+(?:the\s+)?(?:(?:emma(?:'s)?|voice|menu|secretary)\s+)?language\s+(?:to\s+)?(.+)$/iu,
    /^(?:speak|talk|respond)\s+(?:in\s+)?(.+)$/iu,
    /^(?:zm[eě]ň|zmen|přepni|prepn[ií]|nastav)\s+(?:(?:jazyk\s+)?(?:emmy|menu|sekretary|sekretáře)|jazyk)\s*(?:na\s+)?(.+)$/iu,
    /^(?:mluv|mluvte|odpov[ií]dej)\s+(?:pros[ií]m\s+)?(?:v\s+)?(.+)$/iu,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const language = match ? resolveVoiceLanguage(match[1]) : undefined;
    if (language) return { intent: "set_voice_language", entities: { language } };
  }
  return undefined;
}

export function isGmailConfirmationPhrase(rawText: string) {
  const text = rawText.trim().toLocaleLowerCase().replace(/[.!?]+$/g, "");
  return /^(?:yes|yeah|yep|confirm|go ahead|do it|send it|ano|potvrzuji|potvrďuji|potvrdit)$/iu.test(text);
}

export function isGmailCancellationPhrase(rawText: string) {
  const text = rawText.trim().toLocaleLowerCase().replace(/[.!?]+$/g, "");
  return /^(?:no|cancel|cancel it|don't send|do not send|stop email|ne|zruš|zrus|nezasilat|neodesilat)$/iu.test(text);
}

export function parseTextCommand(rawText: string): ParsedCommand {
  const text = rawText.trim();

  const languageCommand = parseVoiceLanguageCommand(text);
  if (languageCommand) return languageCommand;
  const gmailMessage = parseGmailMessageCommand(text);
  if (gmailMessage) return gmailMessage;
  if (/^(?:confirm|send)\s+(?:the\s+)?(?:email|message)(?:\s+now)?$/i.test(text))
    return { intent: "confirm_gmail_message", entities: {} };
  if (/^(?:cancel|discard)\s+(?:the\s+)?(?:email|message)$/i.test(text))
    return { intent: "cancel_gmail_message", entities: {} };

  let connectorMatch = text.match(/^(?:check|show|list)\s+(.+?)\s+(?:connector\s+)?status$/i);
  if (connectorMatch) {
    const connectorKey = resolveConnectorTarget(connectorMatch[1]);
    if (connectorKey) return { intent: "connector_status", entities: { connector_key: connectorKey } };
  }
  if (/^(?:check|show|list)\s+(?:my\s+)?(?:connectors?|integrations?)(?:\s+status)?$/i.test(text))
    return { intent: "connector_status", entities: { connector_key: "all" } };

  connectorMatch = text.match(/^(?:set\s*up|setup|configure|connect|start|activate)\s+(.+)$/i);
  if (connectorMatch) {
    const connectorKey = resolveConnectorTarget(connectorMatch[1]);
    if (connectorKey) return { intent: "setup_connectors", entities: { connector_key: connectorKey } };
  }

  connectorMatch = text.match(/^(?:sync|synchronise|synchronize|refresh)\s+(.+)$/i);
  if (connectorMatch) {
    const connectorKey = resolveConnectorTarget(connectorMatch[1]);
    if (connectorKey) return { intent: "sync_connectors", entities: { connector_key: connectorKey } };
  }

  let m = text.match(/^(?:create|add|new)\s+client\s+(.+)$/i);
  if (m) {
    let rest = m[1];
    const email = extractLabelled(rest, "email");
    rest = email.rest;
    const phone = extractLabelled(rest, "phone");
    rest = phone.rest;
    const displayName = rest.replace(/,\s*$/, "").trim();
    if (!displayName) return { intent: "unrecognized", entities: {} };
    return {
      intent: "create_client",
      entities: { display_name: displayName, email_primary: email.value, phone_primary: phone.value },
    };
  }

  m = text.match(/^(?:create|add|new)\s+lead\s+(.+)$/i);
  if (m) {
    let rest = m[1];
    // Extract "for <service>" first — email/phone extraction is greedy and
    // would otherwise swallow a trailing "for ..." clause.
    const forMatch = rest.match(/\bfor\s+(.+)$/i);
    let service: string | undefined;
    if (forMatch) {
      service = forMatch[1].trim();
      rest = rest.slice(0, forMatch.index).trim();
    }
    const email = extractLabelled(rest, "email");
    rest = email.rest;
    const phone = extractLabelled(rest, "phone");
    rest = phone.rest;
    const name = rest.replace(/,\s*$/, "").trim();
    if (!name) return { intent: "unrecognized", entities: {} };
    return {
      intent: "create_lead",
      entities: { name, service_requested: service, email: email.value, phone: phone.value },
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
  if (m) {
    return { intent: "change_job_status", entities: { job_title: m[1].trim(), job_status: m[2].trim() } };
  }

  m = text.match(/^convert\s+lead\s+(.+)$/i);
  if (m) {
    return { intent: "convert_lead", entities: { lead_name: m[1].trim() } };
  }

  m = text.match(/^assign\s+job\s+(.+?)\s+to\s+(.+)$/i);
  if (m) {
    return { intent: "assign_job", entities: { job_title: m[1].trim(), employee_name: m[2].trim() } };
  }

  if (/^(?:show|check)\s+overload$/i.test(text)) return { intent: "detect_overload", entities: {} };

  // Task Management — deterministic forms:
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
    const title = rest.replace(/,\s*$/, "").trim();
    if (!title) return { intent: "unrecognized", entities: {} };
    return { intent: "create_task", entities: { title, employee_name: assigned.value, due_at: due.value } };
  }

  if (/^(?:list|show)\s+tasks?$/i.test(text)) return { intent: "list_tasks", entities: {} };

  m = text.match(/^(?:create|add|new)\s+service\s+(.+)$/i);
  if (m) {
    let rest = m[1];
    const category = extractLabelled(rest, "category");
    rest = category.rest;
    const name = rest.replace(/,\s*$/, "").trim();
    if (!name) return { intent: "unrecognized", entities: {} };
    return { intent: "create_service", entities: { name, category: category.value } };
  }

  m = text.match(/^(?:list|show)\s+quotes(?:\s+for\s+(.+))?$/i);
  if (m) return { intent: "list_quotes", entities: { client_name: m[1]?.trim() } };

  if (/^(?:list|show)\s+job\s+openings?$/i.test(text)) return { intent: "list_job_openings", entities: {} };

  m = text.match(/^when\s+i\s+say\s+(.+?)\s+i\s+mean\s+(.+)$/i);
  if (m) return { intent: "create_learning_rule", entities: { term: m[1].trim(), meaning: m[2].trim() } };

  m = text.match(/^(?:teach\s+me|remember)[:,]?\s+(.+?)\s+means\s+(.+)$/i);
  if (m) return { intent: "create_learning_rule", entities: { term: m[1].trim(), meaning: m[2].trim() } };

  if (/^(?:list|show)\s+learning\s+rules?$/i.test(text)) return { intent: "list_learning_rules", entities: {} };

  // Explicit durable Emma memory. This is deliberately separate from the
  // alias syntax above: arbitrary conversation is never promoted to memory,
  // only a direct "remember that" instruction is. Company scope must also be
  // stated explicitly; the service enforces crm.manage for that wider scope.
  m = text.match(/^(?:remember\s+for\s+(?:the\s+)?company\s+that|zapamatuj\s+si\s+pro\s+(?:firmu|společnost|spolecnost)\s*,?\s*(?:že|ze))\s+(.+)$/iu);
  if (m) return { intent: "create_assistant_memory", entities: { content: m[1].trim(), scope: "company" } };

  m = text.match(/^(?:remember(?:\s+for\s+me)?\s+that|zapamatuj\s+si(?:\s+pro\s+(?:mě|me))?\s*,?\s*(?:že|ze))\s+(.+)$/iu);
  if (m) return { intent: "create_assistant_memory", entities: { content: m[1].trim(), scope: "personal" } };

  m = text.match(/^(?:what\s+do\s+you\s+remember|co\s+si\s+(?:pamatuješ|pamatujes)|co\s+(?:máš|mas)\s+v\s+(?:paměti|pameti))(?:\s+(?:about|o)\s+(.+?))?\??$/iu);
  if (m) return { intent: "recall_assistant_memory", entities: { query: m[1]?.trim() } };

  // "log call with Jane Smith: discussed timeline, promised quote by Friday"
  // "log email from Jane Smith: sent quote"
  // Channel word maps to a real COMMUNICATION_CHANNELS entry; direction is
  // inferred from "with"/"to" (outbound) vs "from" (inbound) — a reasonable
  // deterministic default the user can always correct via the form/API.
  m = text.match(
    /^log\s+(call|phone call|email|whatsapp|sms|text|messenger|message|meeting|visit)\s+(with|to|from)\s+(.+?)\s*:\s*(.+)$/i
  );
  if (m) {
    const channelWord = m[1].toLowerCase();
    const directionWord = m[2].toLowerCase();
    const clientName = m[3].trim();
    const summary = m[4].trim();
    const channelMap: Record<string, string> = {
      call: "phone_call",
      "phone call": "phone_call",
      email: "email",
      whatsapp: "whatsapp",
      sms: "sms",
      text: "sms",
      messenger: "messenger",
      message: "messenger",
      meeting: "in_person",
      visit: "in_person",
    };
    const channel = channelMap[channelWord] ?? "other";
    const direction = directionWord === "from" ? "inbound" : "outbound";
    if (!clientName || !summary) return { intent: "unrecognized", entities: {} };
    return { intent: "log_communication", entities: { client_name: clientName, channel, direction, summary } };
  }

  // Portfolio and Photo Intelligence Module — manual-entry foundation.
  // "log photo IMG_001.jpg for Jane Smith: kitchen after refit"
  // "log photo IMG_002.jpg: site visit" (no client)
  m = text.match(/^log\s+photo\s+(\S+)\s+for\s+(.+?)\s*:\s*(.+)$/i);
  if (m) {
    const filename = m[1].trim();
    const clientName = m[2].trim();
    const caption = m[3].trim();
    if (!filename || !caption) return { intent: "unrecognized", entities: {} };
    return { intent: "log_portfolio_photo", entities: { filename, client_name: clientName, caption } };
  }
  m = text.match(/^log\s+photo\s+(\S+)\s*:\s*(.+)$/i);
  if (m) {
    const filename = m[1].trim();
    const caption = m[2].trim();
    if (!filename || !caption) return { intent: "unrecognized", entities: {} };
    return { intent: "log_portfolio_photo", entities: { filename, caption } };
  }

  // "list photos for Jane Smith" / "show marketing photos" / "list photos"
  if (/^(?:list|show)\s+marketing\s+photos?$/i.test(text))
    return { intent: "list_portfolio_photos", entities: { usable_for_marketing: true } };
  m = text.match(/^(?:list|show)\s+photos?(?:\s+for\s+(.+))?$/i);
  if (m) return { intent: "list_portfolio_photos", entities: { client_name: m[1]?.trim() } };

  if (/^(?:list|show)\s+follow[\s-]?ups?$/i.test(text)) return { intent: "list_follow_ups", entities: {} };

  // Communication Intelligence — deterministic forms matching the master
  // document examples: "show unresolved enquiries" and "check unresolved
  // enquiries from the last week/7 days".
  m = text.match(
    /^(?:list|show|check|find)\s+unresolved\s+enquir(?:y|ies)(?:\s+(?:from|in)\s+(?:the\s+)?last\s+(?:([1-9]\d*)\s+days?|week))?$/i
  );
  if (m) {
    const sinceDays = m[1] ? Number(m[1]) : /\bweek\b/i.test(text) ? 7 : undefined;
    return { intent: "list_unresolved_enquiries", entities: { since_days: sinceDays } };
  }

  // Notification and Escalation Module — surfaces the unified attention
  // feed (overdue follow-ups, capacity overload, expiring quotes).
  if (/^(?:list|show)\s+notifications?$/i.test(text)) return { intent: "list_notifications", entities: {} };
  if (/^what\s+needs\s+attention\??$/i.test(text)) return { intent: "list_notifications", entities: {} };

  // Data Quality Engine — read-only, structural duplicate/missing-contact
  // analysis over real CRM Core client data.
  if (/^(?:list|show|check)\s+data\s+quality(?:\s+issues?)?$/i.test(text))
    return { intent: "list_data_quality", entities: {} };
  if (/^(?:list|show)\s+(?:possible\s+)?duplicate\s+clients?$/i.test(text))
    return { intent: "list_data_quality", entities: {} };

  // merge_clients (the confirmation-gated Data Quality Engine action — see
  // dataQualityService.mergeClients) deliberately has NO text-command intent
  // here. Same judgment call the README already documents for prepare_quote
  // ("a real, multi-line-item form, so it isn't a one-line voice command in
  // this slice"): merging picks two specific client ids out of a possible
  // duplicate pair and re-links five different record types, which is not
  // safely expressible or reviewable as a single typed sentence. It stays a
  // dedicated form/API flow (POST /data-quality/merge-clients) that always
  // goes through the same confirmationRequired preview before anything
  // changes, whether called from the REST route or (in a future slice) a
  // playbook step — never a one-line command, even a confirmed one.

  // Memory Model — Pattern Detection: read-only analysis of the AuditLog for
  // repeated manual action sequences. Never creates a Playbook itself; see
  // memoryModelService.ts.
  if (/^(?:show|detect|list)\s+(?:repeated\s+)?(?:action\s+)?patterns?$/i.test(text))
    return { intent: "detect_action_patterns", entities: {} };

  m = text.match(/^(?:list|show)\s+communications?(?:\s+for\s+(.+))?$/i);
  if (m) return { intent: "list_communications", entities: { client_name: m[1]?.trim() } };

  if (/^(?:list|show(?:\s+me)?|open)\s+clients?$/i.test(text)) return { intent: "list_clients", entities: {} };
  if (/^(?:list|show(?:\s+me)?|open)\s+contacts?$/i.test(text)) return { intent: "list_contacts", entities: {} };
  if (/^(?:list|show(?:\s+me)?|read|open)\s+(?:my\s+)?(?:email|mail)(?:\s+messages?)?s?$/i.test(text))
    return { intent: "list_channel_messages", entities: { channel: "email" } };
  if (/^(?:list|show(?:\s+me)?|read|open)\s+(?:my\s+)?whatsapp(?:\s+messages?)?$/i.test(text))
    return { intent: "list_channel_messages", entities: { channel: "whatsapp" } };
  if (/^(?:list|show(?:\s+me)?|open)\s+jobs?$/i.test(text)) return { intent: "list_jobs", entities: {} };
  if (/^(?:list|show(?:\s+me)?|open)\s+leads?$/i.test(text)) return { intent: "list_leads", entities: {} };

  m = text.match(/^(?:open|go\s+to|navigate\s+to|take\s+me\s+to|show\s+me)\s+(.+)$/i);
  if (m) {
    const page = resolveVoicePage(m[1]);
    if (page) return { intent: "navigate", entities: { page } };
  }

  return { intent: "unrecognized", entities: {} };
}
