// Text/Voice Understanding Layer — deterministic, rule-based intent parser.
//
// This is intentionally NOT an LLM call. Per the VCUBF master documentation and
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
import { mentionsLanguage, resolveSpokenLanguageName, resolveVoiceLanguage, type VoiceLanguage } from "./voiceLanguages.js";
import { resolveNavigationSection, type NavigationSectionId } from "./navigationCatalogue.js";
import { parseEmmaExecutableActionCommand, type EmmaExecutableActionName, type EmmaExecutableActionRequest } from "./emmaExecutableActionCatalogue.js";

// If nothing matches, the result is `unrecognized` — the system must not
// guess (VCUBF error handling rule).

export type ParsedCommand =
  | { intent: "execute_action"; entities: EmmaExecutableActionRequest }
  | { intent: "confirm_execute_action"; entities: { action: EmmaExecutableActionName } }
  | { intent: "cancel_execute_action"; entities: { action: EmmaExecutableActionName } }
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
  | {
      intent: "prepare_gmail_message";
      entities: { to: string[]; cc: string[]; bcc: string[]; subject: string; body: string };
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

const PHONE_FIELD_LABELS = new Set(["phone", "telefon", "telefonu"]);

function extractLabelled(text: string, label: string): { value?: string; rest: string } {
  // Phone is the final labelled field in canonical create commands. Speech
  // recognition commonly emits dictated digits separated by commas; capture
  // the complete remainder instead of truncating the number at its first
  // comma. Other fields retain comma-delimited parsing.
  const re = new RegExp(
    PHONE_FIELD_LABELS.has(label.toLowerCase())
      ? `,?\\s*${label}\\s*[:]?\\s*(.+)$`
      : `,?\\s*${label}\\s*[:]?\\s*([^,]+)`,
    "i",
  );
  const match = text.match(re);
  if (!match) return { rest: text };
  const value = match[1].trim();
  const rest = (text.slice(0, match.index) + text.slice((match.index ?? 0) + match[0].length)).trim();
  return { value, rest };
}

/** The labels people actually speak. "email" is the same word in Czech, the
 *  phone field is not, and a create command is worthless if the number is
 *  dropped because the speaker said "telefon". */
function extractSpokenContact(text: string) {
  const email = extractLabelled(text, "email");
  let phone = extractLabelled(email.rest, "phone");
  for (const label of ["telefon", "telefonu"]) {
    if (phone.value) break;
    phone = extractLabelled(email.rest, label);
  }
  return { email: email.value, phone: normalizeDictatedPhone(phone.value), rest: phone.rest };
}

function normalizeDictatedPhone(value: string | undefined): string | undefined {
  if (!value) return value;
  // Preserve a leading international plus and remove punctuation inserted
  // between dictated digits. Spaces remain valid for human-readable numbers.
  return value
    .replace(/(?<=\d)[,;](?=\s*\d)/g, "")
    .replace(/(?<=\d)\.(?=\s*\d)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function resolveConnectorTarget(raw: string): ConnectorKey | "all" | undefined {
  const normalized = raw.trim().normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/[.!?]+$/g, "").replace(/[-_]+/g, " ").replace(/\s+/g, " ")
    .replace(/^(?:the|my)\s+/, "").replace(/\s+(?:connector|integration)$/, "");
  const aliases: Record<string, ConnectorKey | "all"> = {
    all: "all", connectors: "all", integrations: "all", "all connectors": "all", "all integrations": "all",
    vsechny: "all", vse: "all", konektory: "all", integrace: "all", wszystkie: "all", integracje: "all",
    gmail: "gmail", email: "gmail", mail: "gmail", posta: "gmail", poczta: "gmail", poczte: "gmail",
    "google contacts": "google_contacts", contacts: "google_contacts", kontakty: "google_contacts",
    "google calendar": "google_calendar", calendar: "google_calendar", kalendar: "google_calendar", kalendarz: "google_calendar",
    "google drive": "google_drive", "google drive photos": "google_drive", drive: "google_drive",
    "google photos": "google_photos", "google photo": "google_photos", photos: "google_photos",
    whatsapp: "whatsapp_business", "whatsapp business": "whatsapp_business",
    // "stav gmailu", "stav kalendare" — Czech asks in the genitive, and the
    // connector is the same connector whichever case names it.
    gmailu: "gmail", posty: "gmail", kontaktu: "google_contacts", kalendare: "google_calendar",
    konektoru: "all", integraci: "all",
  };
  return aliases[normalized];
}

function parseWhatsAppMessageCommand(text: string): Extract<ParsedCommand, { intent: "prepare_whatsapp_message" }> | undefined {
  const match = text.match(/^(?:(?:send|write)\s+(?:a\s+)?whatsapp\s+(?:message\s+)?to|(?:pošli|posli|napiš|napis)\s+(?:zprávu\s+)?(?:na\s+)?whatsapp\s+(?:na|pro)|(?:wyślij|wyslij|napisz)\s+(?:wiadomość\s+)?(?:na\s+)?whatsapp\s+(?:do|na))\s*:?[ ]*(\+?[\d ()-]{7,30})\s*(?:;|,)?\s*(?:(?:message|body|text|zpráva|zprava|wiadomość|wiadomosc|treść|tresc)\s*:?)?\s*(.+)$/iu);
  if (!match) return undefined;
  const to = match[1].trim();
  const body = match[2].trim();
  return to && body ? { intent: "prepare_whatsapp_message", entities: { to, body } } : undefined;
}

function parseCalendarAgendaCommand(text: string): Extract<ParsedCommand, { intent: "list_calendar_events" }> | undefined {
  const normalized = text.trim().replace(/[.!?]+$/g, "");
  const isAgendaRequest = /^(?:what|show|list|read|open|check|tell|co|jak[éeý]?|ukaž|ukaz|přečti|precti|zkontroluj|pokaż|pokaz|sprawdź|sprawdz|przeczytaj|jakie)(?:\s|$)/iu.test(normalized);
  if (!isAgendaRequest) return undefined;
  const isCalendarRequest = /(?:calendar|schedule|events?|kalendar|kalendář|kalendari|událost|udalost|program|kalendarz|wydarzeni|termin)/iu.test(normalized)
    || /^(?:what\s+do\s+i\s+have|co\s+m[aá]m|jakie\s+mam)/iu.test(normalized);
  if (!isCalendarRequest) return undefined;
  if (/(?:tomorrow|z[ií]tra|jutro)/iu.test(normalized)) return { intent: "list_calendar_events", entities: { period: "tomorrow" } };
  if (/(?:next\s+(?:seven|7)\s+days|this\s+week|př[ií]št[ií]ch\s+(?:sedm|7)\s+dn[ií]|tento\s+t[yý]den|najbliższe\s+(?:siedem|7)\s+dni|ten\s+tydzień)/iu.test(normalized))
    return { intent: "list_calendar_events", entities: { period: "next_7_days" } };
  if (/(?:today|dnes|dzisiaj|dziś)/iu.test(normalized)) return { intent: "list_calendar_events", entities: { period: "today" } };
  return undefined;
}

function parseEmailAddresses(raw: string) {
  return raw
    .split(/\s*(?:,|\band\b)\s*/i)
    .map((value) => value.trim())
    .filter(Boolean);
}

function parseGmailMessageCommand(text: string): Extract<ParsedCommand, { intent: "prepare_gmail_message" }> | undefined {
  const prefix = text.match(/^(?:(?:send|write|compose)\s+(?:an?\s+)?(?:email|mail)\s+to|(?:pošli|posli|odešli|odesli|napiš|napis)\s+(?:e-?mail|mail)\s+(?:na|pro)|(?:wyślij|wyslij|napisz)\s+(?:e-?mail|mail)\s+(?:do|na))\s*:?\s*(.+)$/iu);
  if (!prefix) return undefined;
  const rest = prefix[1].trim();

  // A natural spoken form is often transcribed with commas. It intentionally
  // supports only To, Subject and Body; the semicolon form below also permits
  // CC and BCC without confusing commas inside the message body.
  const commaForm = rest.match(/^(.+?)\s*,\s*(?:subject|předmět|predmet|temat)\s*:?\s*(.+?)\s*,\s*(?:body|message|zpráva|zprava|text|treść|tresc|wiadomość|wiadomosc)\s*:?\s*(.+)$/iu);
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
    match = section.match(/^(?:subject|předmět|predmet|temat)\s*:?\s*(.+)$/iu);
    if (match) {
      subject = match[1].trim();
      continue;
    }
    match = section.match(/^(?:body|message|zpráva|zprava|text|treść|tresc|wiadomość|wiadomosc)\s*:?\s*(.*)$/iu);
    if (match) {
      body = [match[1], ...sections.slice(index + 1)].join("; ").trim();
      break;
    }
  }
  if (!to.length || !subject || !body) return undefined;
  return { intent: "prepare_gmail_message", entities: { to, cc, bcc, subject, body } };
}

function parseVoiceLanguageCommand(text: string): Extract<ParsedCommand, { intent: "set_voice_language" }> | undefined {
  const resolveTarget = (rawTarget: string) => {
    const direct = resolveVoiceLanguage(rawTarget);
    if (direct) return direct;
    const cleaned = rawTarget
      .replace(/[^\p{L}\p{N}-]+/gu, " ")
      .split(/\s+/u)
      .filter((word) => word.length > 0 && !new Set([
        "the", "language", "język", "jezyk", "jazyk", "now", "teraz", "please", "proszę", "prosze",
        "prosím", "prosim", "mi", "na", "do", "to", "into", "on", "kurwa", "fucking",
        "set", "change", "switch", "turn", "sprache", "spreche", "sprechen",
      ]).has(word.toLocaleLowerCase("en")))
      .join(" ");
    return resolveVoiceLanguage(cleaned);
  };
  const patterns = [
    /^(?:set|change|switch)\s+(?:the\s+)?(?:(?:emma(?:'s)?|voice|menu|secretary)\s+)?language\s+(?:to\s+)?(.+)$/iu,
    /^(?:yes[,\s]+)?(?:change|switch)(?:\s+(?:yourself|over))?\s+to\s+(.+)$/iu,
    /^(?:please\s+)?(?:turn|set|change|switch)(?:\s+the)?(?:\s+language)?(?:\s+(?:on|to|into))?\s+(.+)$/iu,
    /^(?:speak|talk|respond)\s+(?:in\s+)?(.+)$/iu,
    /^(?:zm[eě]ň|zmen|přepni|prepn[ií]|nastav)\s+(?:(?:jazyk\s+)?(?:emmy|menu|sekretary|sekretáře)|jazyk)\s*(?:(?:na|do)\s+)?(.+)$/iu,
    /^(?:(?:ano|ne)[,\s]+)?(?:přepni|prepni|zepni)(?:\s+se)?(?:\s+okamžitě)?\s+(?:do|na)\s+(.+)$/iu,
    /^(?:mluv|mluvte|odpov[ií]dej)\s+(?:pros[ií]m\s+)?(?:v\s+)?(.+)$/iu,
    /^(?:zmień|zmien|przełącz|przelacz|ustaw)\s+(?:język|jezyk)(?:\s+emmy|\s+menu)?\s*(?:(?:na|do)\s+)?(.+)$/iu,
    /^(?:tak[,\s]+)?(?:przełącz|przelacz)(?:\s+się|\s+sie)?\s+na\s+(.+)$/iu,
    /^(?:włącz|wlacz|zmień|zmien|przełącz|przelacz|ustaw|uruchom)(?:\s+mi)?\s+(.+)$/iu,
    /^(?:.+\s+)?(?:zmień|zmien|przełącz|przelacz|ustaw)(?:\s+to)?(?:\s+od\s+razu)?(?:\s+język|\s+jezyk)?\s*(?:(?:na|do)\s+)?(.+)$/iu,
    /^(?:chcę|chce|poproszę|poprosze)(?:\s+mieć|\s+miec)?\s+(.+)$/iu,
    /^(?:język|jezyk|language)\s+(.+)$/iu,
    /^(?:mów|mow|odpowiadaj)\s+(?:po\s+)?(.+)$/iu,
    /^(?:change|passe|bascule|mets)\s+(?:la\s+)?langue\s*(?:(?:en|vers)\s+)?(.+)$/iu,
    /^(?:parle|réponds|reponds)\s+(?:en\s+)?(.+)$/iu,
    /^(?:wechsle|ändere|andere|stelle)\s+(?:die\s+)?sprache\s*(?:(?:auf|zu)\s+)?(.+)$/iu,
    /^(?:wechsle|wechsel|schalte)(?:\s+die)?(?:\s+sprache)?\s*(?:(?:auf|zu)\s+)?(.+)$/iu,
    /^(?:ich\s+(?:will|möchte|mochte)|bitte)(?:\s+die)?(?:\s+sprache)?\s*(?:(?:auf|in)\s+)?(.+)$/iu,
    /^(?:kann\s+ich|kannst\s+du|können\s+sie|konnen\s+sie)(?:\s+die)?\s+sprache\s*(?:(?:auf|in)\s+)?(.+)$/iu,
    /^(?:bestell|stell|stelle|setz|setze|wähl|wahl|wahle)(?:\s+die)?(?:\s+sprache)?\s*(?:auf\s+)?(.+)$/iu,
    /^sprache\s+(.+)$/iu,
    /^(.+)\s+(?:sprache|language|jazyk|język|jezyk)$/iu,
    /^(?:sprich|antworte)\s+(?:auf\s+)?(.+)$/iu,
    /^(?:cambia|cambiar|pon)\s+(?:el\s+)?idioma\s*(?:(?:a|en)\s+)?(.+)$/iu,
    /^(?:habla|responde)\s+(?:en\s+)?(.+)$/iu,
    /^(?:cambia|imposta)\s+(?:la\s+)?lingua\s*(?:(?:in|su)\s+)?(.+)$/iu,
    /^(?:parla|rispondi)\s+(?:in\s+)?(.+)$/iu,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const language = match ? resolveTarget(match[1]) : undefined;
    if (language) return { intent: "set_voice_language", entities: { language } };
  }
  // A bare language variant is an explicit answer to a preceding variant
  // question and is safe because changing language is reversible. Named in full,
  // though: a bare "it" or "pl" is a word or a fragment of noise, not a request.
  const bareLanguage = resolveSpokenLanguageName(text);
  if (bareLanguage) return { intent: "set_voice_language", entities: { language: bareLanguage } };
  return undefined;
}

/**
 * "mluv rychleji", "pomaleji", "mluv normálně" and their English forms.
 *
 * Recognised here rather than left to the model: adjusting her own voice is a
 * single word, and making it depend on a round trip means it sometimes does
 * nothing, which is exactly how it behaved.
 */
function parseSpeechRateCommand(text: string): Extract<ParsedCommand, { intent: "set_speech_rate" }> | undefined {
  const normalized = text
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[.!?,]+$/g, "")
    .replace(/\s+/g, " ");

  // An explicit number, so "mluv na 1.4" works as well as a direction.
  const numeric = normalized.match(/(?:rychlost|speed|tempo)\D{0,12}(\d+(?:[.,]\d+)?)/);
  if (numeric) {
    const value = Number(numeric[1].replace(",", "."));
    if (Number.isFinite(value)) {
      // Spoken as a percentage ("mluv na 130") rather than a multiplier.
      const rate = value > 3 ? value / 100 : value;
      return { intent: "set_speech_rate", entities: { rate } };
    }
  }

  const faster = /\b(rychleji|zrychli|zrychlit|rychlejc|faster|speed up|quicker)\b/;
  const slower = /\b(pomaleji|zpomal|zpomalit|pomalejc|slower|slow down)\b/;
  const normal = /\b(normalne|normalni|obvykle|puvodni|normal|default)\b/;

  if (faster.test(normalized)) return { intent: "set_speech_rate", entities: { change: "faster" } };
  if (slower.test(normalized)) return { intent: "set_speech_rate", entities: { change: "slower" } };
  // "normally" alone is ambiguous; require it to be about speaking.
  if (normal.test(normalized) && /\b(mluv|rikej|speak|talk|rychlost|speed|tempo)\b/.test(normalized)) {
    return { intent: "set_speech_rate", entities: { change: "normal" } };
  }
  return undefined;
}

export function isExplicitVoiceLanguageChange(text: string, language: VoiceLanguage): boolean {
  const cleaned = text.trim().replace(/[.!?]+$/g, "");
  const command = parseVoiceLanguageCommand(cleaned);
  if (command) return command.entities.language === language;
  // The parser did not recognise this sentence — which is the only reason the
  // caller is asking, since an unrecognised command is what sends it to the model.
  // Requiring the parser to succeed here therefore refused every request that got
  // this far, and answered "ask me explicitly" to people who just had. Whether the
  // language was named is the question that can actually be answered at this point.
  return mentionsLanguage(cleaned, language);
}

function parseMenuDescriptionCommand(text: string): Extract<ParsedCommand, { intent: "describe_menu" }> | undefined {
  const normalized = text.trim().replace(/[.!?]+$/g, "");
  if (
    /^(?:read|show|list|describe)(?:\s+me)?\s+(?:the\s+)?(?:whole|full|complete|all)?\s*(?:menu|navigation)(?:\s+(?:tree|contents|items))?$/iu.test(normalized)
    || /^(?:what(?:'s|\s+is)\s+(?:in\s+)?(?:the\s+)?(?:menu|navigation)|what\s+can\s+i\s+do(?:\s+in\s+(?:the\s+)?(?:app|secretary))?)$/iu.test(normalized)
    || /^(?:přečti|precti|ukaž|ukaz|vypiš|vypis)\s+(?:mi\s+)?(?:(?:cel[ée]|všechny)\s+)?(?:(?:položky|polozky)\s+)?(?:menu|navigaci|navigace)(?:\s+programu)?$/iu.test(normalized)
    || /^co\s+je\s+v\s+(?:cel[ée]m\s+)?(?:menu|navigaci)$/iu.test(normalized)
    || /^(?:przeczytaj|pokaż|pokaz|wyświetl|wyswietl)\s+(?:mi\s+)?(?:(?:całe|cale|pełne|pelne|wszystkie)\s+)?(?:(?:pozycje|elementy)\s+)?(?:menu|nawigację|nawigacje)(?:\s+programu)?$/iu.test(normalized)
    || /^co\s+jest\s+w\s+(?:całym|calym|pełnym|pelnym\s+)?(?:menu|nawigacji)$/iu.test(normalized)
  ) {
    return { intent: "describe_menu", entities: {} };
  }

  const sectionMatch = normalized.match(/^(?:read|show|list|describe)(?:\s+me)?\s+(?:the\s+)?(?:whole|full|complete)?\s*(?:menu|navigation)(?:\s+section)?\s+(.+)$/iu)
    ?? normalized.match(/^(?:přečti|precti|ukaž|ukaz|vypiš|vypis)\s+(?:mi\s+)?(?:menu|navigaci|navigace)(?:\s+sekci)?\s+(.+)$/iu)
    ?? normalized.match(/^co\s+je\s+v\s+(?:menu|navigaci)\s+(.+)$/iu)
    ?? normalized.match(/^(?:przeczytaj|pokaż|pokaz|wyświetl|wyswietl)\s+(?:mi\s+)?(?:menu|nawigację|nawigacje)(?:\s+sekcję|\s+sekcje)?\s+(.+)$/iu)
    ?? normalized.match(/^co\s+jest\s+w\s+(?:menu|nawigacji)\s+(.+)$/iu);
  const section = sectionMatch ? resolveNavigationSection(sectionMatch[1]) : undefined;
  return section ? { intent: "describe_menu", entities: { section } } : undefined;
}

export function isGmailConfirmationPhrase(rawText: string) {
  const text = rawText.trim().toLocaleLowerCase().replace(/[.!?]+$/g, "");
  return /^(?:yes|yeah|yep|confirm(?:\s+action)?|go ahead|do it|send it|ano|potvrzuji|potvrďuji|potvrdit|potvrď\s+akci|potvrd\s+akci|odešli|odesli|tak\s+ano|tak\s+jo|potwierdzam|potwierdź|potwierdz|potwierdź\s+akcję|potwierdz\s+akcje|wyślij|wyslij)$/iu.test(text);
}

export function isGmailCancellationPhrase(rawText: string) {
  const text = rawText.trim().toLocaleLowerCase().replace(/[.!?]+$/g, "");
  return /^(?:no|cancel(?:\s+action)?|cancel it|don't send|do not send|stop email|ne|zruš|zrus|zruš\s+akci|zrus\s+akci|nezasilat|neodesilat|nie|anuluj|anuluj\s+akcję|anuluj\s+akcje|nie\s+wysyłaj|nie\s+wysylaj)$/iu.test(text);
}

function parseNotificationDeletionCommand(text: string): Extract<
  ParsedCommand,
  { intent: "prepare_delete_notifications" | "confirm_delete_notifications" | "cancel_delete_notifications" }
> | undefined {
  const normalized = text.trim().replace(/[.!?]+$/g, "");
  if (
    /^(?:confirm|approve)\s+(?:deleting|deletion|removing|clearing)\s+(?:all\s+)?notifications?$/iu.test(normalized)
    || /^(?:potvrď|potvrd)\s+(?:smazání|smazani|odstranění|odstraneni)\s+(?:všech|vsech|všechna|vsechna|všechny|vsechny)?\s*(?:oznámení|oznameni|upozornění|upozorneni)$/iu.test(normalized)
    || /^(?:potwierdź|potwierdz)\s+(?:usunięcie|usuniecie|kasowanie)\s+(?:wszystkich|wszystkie)?\s*(?:powiadomień|powiadomien|powiadomienia)$/iu.test(normalized)
  ) return { intent: "confirm_delete_notifications", entities: {} };

  if (
    /^(?:cancel|stop|abort)\s+(?:deleting|deletion|removing|clearing)\s+(?:all\s+)?notifications?$/iu.test(normalized)
    || /^(?:zruš|zrus)\s+(?:smazání|smazani|odstranění|odstraneni)\s+(?:všech|vsech|všechna|vsechna|všechny|vsechny)?\s*(?:oznámení|oznameni|upozornění|upozorneni)$/iu.test(normalized)
    || /^(?:anuluj|przerwij)\s+(?:usunięcie|usuniecie|kasowanie)\s+(?:wszystkich|wszystkie)?\s*(?:powiadomień|powiadomien|powiadomienia)$/iu.test(normalized)
  ) return { intent: "cancel_delete_notifications", entities: {} };

  if (
    /^(?:delete|remove|clear|dismiss)\s+(?:all\s+)?notifications?$/iu.test(normalized)
    || /^(?:smaž|smaz|vymaž|vymaz|odstraň|odstran)\s+(?:všechna|vsechna|všechny|vsechny)?\s*(?:oznámení|oznameni|upozornění|upozorneni)$/iu.test(normalized)
    || /^(?:usuń|usun|skasuj|wyczyść|wyczysc)\s+(?:wszystkie)?\s*(?:powiadomienia|powiadomień|powiadomien)$/iu.test(normalized)
    || /^(?:mazání|mazani|usuwanie)\s+(?:oznámení|oznameni|powiadomienia|powiadomień|powiadomien)$/iu.test(normalized)
  ) return { intent: "prepare_delete_notifications", entities: {} };

  return undefined;
}

function parseClientMutationCommand(text: string): Extract<
  ParsedCommand,
  { intent: "update_client" | "prepare_archive_client" | "confirm_archive_client" | "cancel_archive_client" }
> | undefined {
  const normalized = text.trim().replace(/[.!?]+$/g, "");

  if (
    /^(?:confirm|approve)\s+(?:the\s+)?(?:client\s+)?(?:deletion|archive|archiving)$/iu.test(normalized)
    || /^(?:potvrď|potvrd)\s+(?:smazání|smazani|archivaci)\s+klienta$/iu.test(normalized)
    || /^(?:potwierdź|potwierdz)\s+(?:usunięcie|usuniecie|archiwizację|archiwizacje)\s+klienta$/iu.test(normalized)
  ) return { intent: "confirm_archive_client", entities: {} };

  if (
    /^(?:cancel|stop|abort)\s+(?:the\s+)?(?:client\s+)?(?:deletion|archive|archiving)$/iu.test(normalized)
    || /^(?:zruš|zrus)\s+(?:smazání|smazani|archivaci)\s+klienta$/iu.test(normalized)
    || /^(?:anuluj|przerwij)\s+(?:usunięcie|usuniecie|archiwizację|archiwizacje)\s+klienta$/iu.test(normalized)
  ) return { intent: "cancel_archive_client", entities: {} };

  let match = normalized.match(/^(?:delete|remove|archive)\s+(?:the\s+)?client\s+(.+)$/iu)
    ?? normalized.match(/^(?:smaž|smaz|vymaž|vymaz|odstraň|odstran|archivuj)\s+klienta\s+(.+)$/iu)
    ?? normalized.match(/^(?:usuń|usun|skasuj|zarchiwizuj)\s+klienta\s+(.+)$/iu);
  if (match) return { intent: "prepare_archive_client", entities: { client_name: match[1].trim() } };

  match = normalized.match(/^(?:rename)\s+(?:the\s+)?client\s+(.+?)\s+to\s+(.+)$/iu)
    ?? normalized.match(/^(?:přejmenuj|prejmenuj)\s+klienta\s+(.+?)\s+na\s+(.+)$/iu)
    ?? normalized.match(/^(?:zmień|zmien)\s+nazwę\s+klienta\s+(.+?)\s+na\s+(.+)$/iu);
  if (match) return { intent: "update_client", entities: { client_name: match[1].trim(), display_name: match[2].trim() } };

  match = normalized.match(/^(?:change|set|update)\s+(?:the\s+)?(?:email|email address)\s+(?:for|of)\s+(?:the\s+)?client\s+(.+?)\s+to\s+(\S+@\S+)$/iu)
    ?? normalized.match(/^(?:change|set|update)\s+(?:the\s+)?client\s+(.+?)\s+(?:email|email address)\s+to\s+(\S+@\S+)$/iu)
    ?? normalized.match(/^(?:změň|zmen)\s+(?:e-?mail|email)\s+klienta\s+(.+?)\s+na\s+(\S+@\S+)$/iu)
    ?? normalized.match(/^(?:zmień|zmien)\s+(?:e-?mail|email)\s+klienta\s+(.+?)\s+na\s+(\S+@\S+)$/iu);
  if (match) return { intent: "update_client", entities: { client_name: match[1].trim(), email_primary: match[2].trim() } };

  match = normalized.match(/^(?:change|set|update)\s+(?:the\s+)?(?:phone|phone number)\s+(?:for|of)\s+(?:the\s+)?client\s+(.+?)\s+to\s+(.+)$/iu)
    ?? normalized.match(/^(?:change|set|update)\s+(?:the\s+)?client\s+(.+?)\s+(?:phone|phone number)\s+to\s+(.+)$/iu)
    ?? normalized.match(/^(?:změň|zmen)\s+(?:telefon|telefonní číslo|telefonni cislo)\s+klienta\s+(.+?)\s+na\s+(.+)$/iu)
    ?? normalized.match(/^(?:zmień|zmien)\s+(?:telefon|numer telefonu)\s+klienta\s+(.+?)\s+na\s+(.+)$/iu);
  if (match) return { intent: "update_client", entities: { client_name: match[1].trim(), phone_primary: match[2].trim() } };

  match = normalized.match(/^(?:update|edit)\s+(?:the\s+)?client\s+(.+)$/iu);
  if (match) {
    let rest = match[1];
    const email = extractLabelled(rest, "email");
    rest = email.rest;
    const newName = extractLabelled(rest, "new name");
    rest = newName.rest;
    // Phone is intentionally extracted last because dictated digits may be
    // comma-separated and therefore consume the remaining canonical field.
    const phone = extractLabelled(rest, "phone");
    rest = phone.rest;
    const clientName = rest.replace(/,\s*$/, "").trim();
    if (clientName && (email.value || phone.value || newName.value)) {
      return {
        intent: "update_client",
        entities: {
          client_name: clientName,
          email_primary: email.value,
          phone_primary: normalizeDictatedPhone(phone.value),
          display_name: newName.value,
        },
      };
    }
  }
  return undefined;
}

function parseContactMutationCommand(text: string): Extract<
  ParsedCommand,
  { intent: "update_contact" | "prepare_archive_contact" | "confirm_archive_contact" | "cancel_archive_contact" }
> | undefined {
  const normalized = text.trim().replace(/[.!?]+$/g, "");
  if (
    /^(?:confirm|approve)\s+(?:the\s+)?contact\s+(?:deletion|archive|archiving)$/iu.test(normalized)
    || /^(?:potvrď|potvrd)\s+(?:smazání|smazani|archivaci)\s+kontaktu$/iu.test(normalized)
    || /^(?:potwierdź|potwierdz)\s+(?:usunięcie|usuniecie|archiwizację|archiwizacje)\s+kontaktu$/iu.test(normalized)
  ) return { intent: "confirm_archive_contact", entities: {} };
  if (
    /^(?:cancel|stop|abort)\s+(?:the\s+)?contact\s+(?:deletion|archive|archiving)$/iu.test(normalized)
    || /^(?:zruš|zrus)\s+(?:smazání|smazani|archivaci)\s+kontaktu$/iu.test(normalized)
    || /^(?:anuluj|przerwij)\s+(?:usunięcie|usuniecie|archiwizację|archiwizacje)\s+kontaktu$/iu.test(normalized)
  ) return { intent: "cancel_archive_contact", entities: {} };

  let match = normalized.match(/^(?:delete|remove|archive)\s+(?:the\s+)?contact\s+(.+)$/iu)
    ?? normalized.match(/^(?:smaž|smaz|vymaž|vymaz|odstraň|odstran|archivuj)\s+kontakt\s+(.+)$/iu)
    ?? normalized.match(/^(?:usuń|usun|skasuj|zarchiwizuj)\s+kontakt\s+(.+)$/iu);
  if (match) return { intent: "prepare_archive_contact", entities: { contact_name: match[1].trim() } };

  match = normalized.match(/^(?:rename)\s+(?:the\s+)?contact\s+(.+?)\s+to\s+(.+)$/iu)
    ?? normalized.match(/^(?:přejmenuj|prejmenuj)\s+kontakt\s+(.+?)\s+na\s+(.+)$/iu)
    ?? normalized.match(/^(?:zmień|zmien)\s+nazwę\s+kontaktu\s+(.+?)\s+na\s+(.+)$/iu);
  if (match) return { intent: "update_contact", entities: { contact_name: match[1].trim(), display_name: match[2].trim() } };

  match = normalized.match(/^(?:change|set|update)\s+(?:the\s+)?(?:email|email address)\s+(?:for|of)\s+(?:the\s+)?contact\s+(.+?)\s+to\s+(\S+@\S+)$/iu)
    ?? normalized.match(/^(?:změň|zmen)\s+(?:e-?mail|email)\s+kontaktu\s+(.+?)\s+na\s+(\S+@\S+)$/iu)
    ?? normalized.match(/^(?:zmień|zmien)\s+(?:e-?mail|email)\s+kontaktu\s+(.+?)\s+na\s+(\S+@\S+)$/iu);
  if (match) return { intent: "update_contact", entities: { contact_name: match[1].trim(), email: match[2].trim() } };

  match = normalized.match(/^(?:change|set|update)\s+(?:the\s+)?(?:phone|phone number)\s+(?:for|of)\s+(?:the\s+)?contact\s+(.+?)\s+to\s+(.+)$/iu)
    ?? normalized.match(/^(?:změň|zmen)\s+(?:telefon|telefonní číslo|telefonni cislo)\s+kontaktu\s+(.+?)\s+na\s+(.+)$/iu)
    ?? normalized.match(/^(?:zmień|zmien)\s+(?:telefon|numer telefonu)\s+kontaktu\s+(.+?)\s+na\s+(.+)$/iu);
  if (match) return { intent: "update_contact", entities: { contact_name: match[1].trim(), phone: match[2].trim() } };
  return undefined;
}

/**
 * Correcting a lead by voice, mirroring the client and contact commands.
 *
 * "converted" is absent from the status words on purpose. Saying it would claim a
 * client record that only conversion creates, so the only way to reach that status
 * stays the convert command.
 */
const SPOKEN_LEAD_STATUS: Record<string, "new" | "contacted" | "qualified" | "lost"> = {
  new: "new", novy: "new", "nový": "new", nowy: "new",
  contacted: "contacted", kontaktovany: "contacted", "kontaktovaný": "contacted", skontaktowany: "contacted",
  qualified: "qualified", kvalifikovany: "qualified", "kvalifikovaný": "qualified", zakwalifikowany: "qualified",
  lost: "lost", ztraceny: "lost", "ztracený": "lost", utracony: "lost", przegrany: "lost",
};

function parseLeadMutationCommand(text: string): Extract<ParsedCommand, { intent: "update_lead" }> | undefined {
  const normalized = text.trim().replace(/[.!?]+$/g, "");

  let match = normalized.match(/^(?:rename)\s+(?:the\s+)?lead\s+(.+?)\s+to\s+(.+)$/iu)
    ?? normalized.match(/^(?:přejmenuj|prejmenuj)\s+(?:lead|poptávku|poptavku)\s+(.+?)\s+na\s+(.+)$/iu)
    ?? normalized.match(/^(?:zmień|zmien)\s+nazwę\s+leada\s+(.+?)\s+na\s+(.+)$/iu);
  if (match) return { intent: "update_lead", entities: { lead_name: match[1].trim(), name: match[2].trim() } };

  match = normalized.match(/^(?:change|set|update)\s+(?:the\s+)?(?:email|email address)\s+(?:for|of)\s+(?:the\s+)?lead\s+(.+?)\s+to\s+(\S+@\S+)$/iu)
    ?? normalized.match(/^(?:změň|zmen)\s+(?:e-?mail|email)\s+(?:leadu|poptávky|poptavky)\s+(.+?)\s+na\s+(\S+@\S+)$/iu)
    ?? normalized.match(/^(?:zmień|zmien)\s+(?:e-?mail|email)\s+leada\s+(.+?)\s+na\s+(\S+@\S+)$/iu);
  if (match) return { intent: "update_lead", entities: { lead_name: match[1].trim(), email: match[2].trim() } };

  match = normalized.match(/^(?:change|set|update)\s+(?:the\s+)?(?:phone|phone number)\s+(?:for|of)\s+(?:the\s+)?lead\s+(.+?)\s+to\s+(.+)$/iu)
    ?? normalized.match(/^(?:změň|zmen)\s+(?:telefon|telefonní číslo|telefonni cislo)\s+(?:leadu|poptávky|poptavky)\s+(.+?)\s+na\s+(.+)$/iu)
    ?? normalized.match(/^(?:zmień|zmien)\s+(?:telefon|numer telefonu)\s+leada\s+(.+?)\s+na\s+(.+)$/iu);
  if (match) {
    return { intent: "update_lead", entities: { lead_name: match[1].trim(), phone: normalizeDictatedPhone(match[2].trim()) } };
  }

  match = normalized.match(/^(?:mark|set)\s+(?:the\s+)?lead\s+(.+?)\s+(?:as|to)\s+(.+)$/iu)
    ?? normalized.match(/^(?:označ|oznac|nastav)\s+(?:lead|poptávku|poptavku)\s+(.+?)\s+(?:jako|na)\s+(.+)$/iu)
    ?? normalized.match(/^(?:oznacz|ustaw)\s+leada\s+(.+?)\s+(?:jako|na)\s+(.+)$/iu);
  if (match) {
    const spoken = match[2].trim().toLowerCase();
    const status = SPOKEN_LEAD_STATUS[spoken];
    // An unrecognised status word falls through rather than guessing: setting the
    // wrong status silently is worse than saying the command was not understood.
    if (status) return { intent: "update_lead", entities: { lead_name: match[1].trim(), lead_status: status } };
  }
  return undefined;
}

// "How many are unpaid", "how much is outstanding" and "who has not paid" are
// three ways of asking one question, and get_unpaid_invoices answers all three
// from the same real balances: the counts, the totals and the largest debtors.
// A spoken Czech command reaches the parser with whatever diacritics the
// transcription produced, so the subject is compared without them.
function foldCzech(value: string) {
  return value.trim().normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/\s+/g, " ");
}

// "ukaž klienty", "vypiš nabídky pro Nováka", "zobraz nevyřízené poptávky".
// The optional tail after "pro" is a client name for the listings that take one.
const CZECH_LIST_COMMAND =
  /^(?:uka[žz]|vyp[ií][šs]|zobraz|p[řr]e[čc]ti|dej\s+mi|seznam)\s+(?:mi\s+)?((?:nevy[řr][ií]zen[ée]\s+)?[\p{L}\s]+?)(?:\s+pro\s+(.+))?$/iu;

const UNPAID_INVOICE_QUESTION =
  /^(?:kolik (?:mam|mame) (?:nezaplacenych|neuhrazenych) faktur(?:y)?|kolik (?:je|mame) (?:nezaplacenych|neuhrazenych) faktur(?:y)?|kdo (?:mi|nam) nezaplatil|kdo (?:mi|nam) dluzi|kolik (?:mi|nam) dluzi(?: klienti)?|(?:how many )?unpaid invoices(?: do (?:i|we) have)?|how many outstanding invoices(?: do (?:i|we) have)?|who owes (?:us|me)(?: money)?|who (?:has|have)(?:n['\u2019]?t| not) paid(?: (?:us|me))?|how much (?:are we|am i) owed)$/;

export function parseTextCommand(rawText: string): ParsedCommand {
  const text = rawText.trim();
  const invoiceQuestion = text.normalize("NFD").replace(/\p{Diacritic}/gu, "")
    .toLowerCase().replace(/[.!?]+$/g, "").replace(/\s+/g, " ").trim();
  // Money questions answered from real invoice balances. They are matched here
  // rather than sent to the language model so the common phrasings answer
  // without a network round trip; anything else still reaches the model, which
  // returns the same allowlisted action.
  if (UNPAID_INVOICE_QUESTION.test(invoiceQuestion)) {
    return { intent: "execute_action", entities: { action: "get_unpaid_invoices", parameters: {} } };
  }

  // This format is emitted only by {assistant}'s structured interpretation layer.
  // It is allowlisted and JSON-parsed here; the owning business service still
  // performs the authoritative validation before any mutation.
  const executableAction = parseEmmaExecutableActionCommand(text);
  if (executableAction) return { intent: "execute_action", entities: executableAction };

  const languageCommand = parseVoiceLanguageCommand(text);
  if (languageCommand) return languageCommand;
  // Before the menu and message parsers: "mluv rychleji" is about her voice, not
  // a search for anything.
  const speechRate = parseSpeechRateCommand(text);
  if (speechRate) return speechRate;
  const menuDescription = parseMenuDescriptionCommand(text);
  if (menuDescription) return menuDescription;
  const gmailMessage = parseGmailMessageCommand(text);
  if (gmailMessage) return gmailMessage;
  const whatsappMessage = parseWhatsAppMessageCommand(text);
  if (whatsappMessage) return whatsappMessage;
  const calendarAgenda = parseCalendarAgendaCommand(text);
  if (calendarAgenda) return calendarAgenda;
  const notificationDeletion = parseNotificationDeletionCommand(text);
  if (notificationDeletion) return notificationDeletion;
  const clientMutation = parseClientMutationCommand(text);
  if (clientMutation) return clientMutation;
  const leadMutation = parseLeadMutationCommand(text);
  if (leadMutation) return leadMutation;

  const contactMutation = parseContactMutationCommand(text);
  if (contactMutation) return contactMutation;
  if (/^(?:confirm|send)\s+(?:the\s+)?(?:email|message)(?:\s+now)?$/iu.test(text)
    || /^(?:potvrď|potvrd|odešli|odesli)\s+(?:ten\s+)?(?:e-?mail|zprávu|zpravu)$/iu.test(text)
    || /^(?:potwierdź|potwierdz|wyślij|wyslij)\s+(?:ten\s+)?(?:e-?mail|wiadomość|wiadomosc)$/iu.test(text))
    return { intent: "confirm_gmail_message", entities: {} };
  if (/^(?:cancel|discard)\s+(?:the\s+)?(?:email|message)$/iu.test(text)
    || /^(?:zruš|zrus)\s+(?:ten\s+)?(?:e-?mail|zprávu|zpravu)$/iu.test(text)
    || /^(?:anuluj)\s+(?:ten\s+)?(?:e-?mail|wiadomość|wiadomosc)$/iu.test(text))
    return { intent: "cancel_gmail_message", entities: {} };
  if (/^(?:confirm|send)\s+(?:the\s+)?whatsapp(?:\s+message)?(?:\s+now)?$/iu.test(text)
    || /^(?:potvrď|potvrd|odešli|odesli)\s+(?:zprávu\s+)?(?:na\s+)?whatsapp$/iu.test(text)
    || /^(?:potwierdź|potwierdz|wyślij|wyslij)\s+(?:wiadomość\s+)?(?:na\s+)?whatsapp$/iu.test(text))
    return { intent: "confirm_whatsapp_message", entities: {} };
  if (/^(?:cancel|discard)\s+(?:the\s+)?whatsapp(?:\s+message)?$/iu.test(text)
    || /^(?:zruš|zrus)\s+(?:zprávu\s+)?(?:na\s+)?whatsapp$/iu.test(text)
    || /^(?:anuluj)\s+(?:wiadomość\s+)?(?:na\s+)?whatsapp$/iu.test(text))
    return { intent: "cancel_whatsapp_message", entities: {} };

  let connectorMatch = text.match(/^(?:check|show|list|zkontroluj|ukaž|ukaz|sprawdź|sprawdz|pokaż|pokaz)\s+(.+?)\s+(?:(?:connector|konektoru|konektora)\s+)?(?:status|stav)$/iu);
  if (connectorMatch) {
    const connectorKey = resolveConnectorTarget(connectorMatch[1]);
    if (connectorKey) return { intent: "connector_status", entities: { connector_key: connectorKey } };
  }
  connectorMatch = text.match(/^stav\s+(.+?)$/iu);
  if (connectorMatch) {
    const connectorKey = resolveConnectorTarget(connectorMatch[1]);
    if (connectorKey) return { intent: "connector_status", entities: { connector_key: connectorKey } };
  }
  if (/^(?:check|show|list)\s+(?:my\s+)?(?:connectors?|integrations?)(?:\s+status)?$/i.test(text))
    return { intent: "connector_status", entities: { connector_key: "all" } };

  connectorMatch = text.match(/^(?:set\s*up|setup|configure|connect|start|activate|nastav|nakonfiguruj|připoj|pripoj|spusť|spust|skonfiguruj|połącz|polacz|uruchom)\s+(.+)$/iu);
  if (connectorMatch) {
    const connectorKey = resolveConnectorTarget(connectorMatch[1]);
    if (connectorKey) return { intent: "setup_connectors", entities: { connector_key: connectorKey } };
  }

  connectorMatch = text.match(/^(?:sync|synchronise|synchronize|refresh|synchronizuj|obnov|zsynchronizuj|odśwież|odswiez)\s+(.+)$/iu);
  if (connectorMatch) {
    const connectorKey = resolveConnectorTarget(connectorMatch[1]);
    if (connectorKey) return { intent: "sync_connectors", entities: { connector_key: connectorKey } };
  }

  let m = text.match(/^(?:create|add|new)\s+client\s+(.+)$/i)
    ?? text.match(/^(?:vytvo[řr]|p[řr]idej|nov[ýy])\s+(?:klienta|klient|z[áa]kazn[íi]ka|z[áa]kazn[íi]k)\s+(.+)$/iu);
  if (m) {
    const contact = extractSpokenContact(m[1]);
    const displayName = contact.rest.replace(/,\s*$/, "").trim();
    if (!displayName) return { intent: "unrecognized", entities: {} };
    return {
      intent: "create_client",
      entities: { display_name: displayName, email_primary: contact.email, phone_primary: contact.phone },
    };
  }

  m = text.match(/^(?:create|add|new)\s+contact\s+(.+)$/i)
    ?? text.match(/^(?:vytvoř|vytvor|přidej|pridej)\s+kontakt\s+(.+)$/iu)
    ?? text.match(/^(?:utwórz|utworz|dodaj)\s+kontakt\s+(.+)$/iu);
  if (m) {
    let rest = m[1];
    const email = extractLabelled(rest, "email");
    rest = email.rest;
    const phone = extractLabelled(rest, "phone");
    rest = phone.rest;
    const displayName = rest.replace(/,\s*$/, "").trim();
    if (!displayName || (!email.value && !phone.value)) return { intent: "unrecognized", entities: {} };
    return { intent: "create_contact", entities: { display_name: displayName, email: email.value, phone: normalizeDictatedPhone(phone.value) } };
  }

  m = text.match(/^(?:create|add|new)\s+lead\s+(.+)$/i)
    ?? text.match(/^(?:vytvo[řr]|p[řr]idej|nov[áa])\s+(?:poptávku|poptavku|popt[áa]vka)\s+(.+)$/iu);
  if (m) {
    let rest = m[1];
    // Extract "for <service>" first — email/phone extraction is greedy and
    // would otherwise swallow a trailing "for ..." clause.
    const forMatch = rest.match(/\b(?:for|pro|na)\s+(.+)$/i);
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
      entities: { name, service_requested: service, email: email.value, phone: normalizeDictatedPhone(phone.value) },
    };
  }

  m = text.match(/^(?:create|add|new)\s+job\s+(.+?)\s+for\s+(.+)$/i)
    ?? text.match(/^(?:vytvo[řr]|p[řr]idej|nov[áa])\s+(?:zak[áa]zku|zak[áa]zka)\s+(.+?)\s+pro\s+(?:klienta\s+)?(.+)$/iu);
  if (m) {
    const jobTitle = m[1].trim();
    const clientName = m[2].trim();
    if (!jobTitle || !clientName) return { intent: "unrecognized", entities: {} };
    return { intent: "create_job", entities: { job_title: jobTitle, client_name: clientName } };
  }

  m = text.match(/^(?:set|change|mark)\s+job\s+(.+?)\s+(?:as|to|status)\s+(.+)$/i)
    ?? text.match(/^(?:zm[ěe][ňn]|nastav|ozna[čc])\s+(?:stav\s+)?zak[áa]zk[yu]\s+(.+?)\s+na\s+(.+)$/iu);
  if (m) {
    return { intent: "change_job_status", entities: { job_title: m[1].trim(), job_status: m[2].trim() } };
  }

  m = text.match(/^convert\s+lead\s+(.+)$/i)
    ?? text.match(/^(?:p[řr]eve[ďd]|zm[ěe][ňn])\s+popt[áa]vku\s+(.+?)\s+na\s+(?:klienta|z[áa]kazn[íi]ka)$/iu);
  if (m) {
    return { intent: "convert_lead", entities: { lead_name: m[1].trim() } };
  }

  m = text.match(/^assign\s+job\s+(.+?)\s+to\s+(.+)$/i)
    ?? text.match(/^(?:p[řr]i[řr]a[ďd]|p[řr]ide[ľl]|zadej)\s+zak[áa]zku\s+(.+?)\s+(?:zam[ěe]stnanci|pracovn[íi]kovi|kolegovi)\s+(.+)$/iu);
  if (m) {
    return { intent: "assign_job", entities: { job_title: m[1].trim(), employee_name: m[2].trim() } };
  }

  if (/^(?:show|check)\s+overload$/i.test(text)
    || /^(?:zkontroluj|uka[žz]|ov[ěe][řr])\s+p[řr]et[íi][žz]en[íi]$/iu.test(text))
    return { intent: "detect_overload", entities: {} };

  // Task Management — deterministic forms:
  // "create task for Daniel: Prepare materials"
  // "create task Prepare materials, assigned to Daniel, due 2026-08-01T09:00:00.000Z"
  m = text.match(/^(?:create|add|new)\s+task\s+for\s+(.+?)\s*:\s*(.+)$/i)
    ?? text.match(/^(?:vytvo[řr]|p[řr]idej|nov[ýy])\s+[úu]kol\s+pro\s+(.+?)\s*:\s*(.+)$/iu);
  if (m) {
    const employeeName = m[1].trim();
    const title = m[2].trim();
    if (!employeeName || !title) return { intent: "unrecognized", entities: {} };
    return { intent: "create_task", entities: { title, employee_name: employeeName } };
  }

  m = text.match(/^(?:create|add|new)\s+task\s+(.+)$/i)
    ?? text.match(/^(?:vytvo[řr]|p[řr]idej|nov[ýy])\s+[úu]kol\s+(.+)$/iu);
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
  const taskStatusMatch = text.match(/^(?:start|complete|cancel)\s+(?:task\s+)?(.+)$/i)
    ?? text.match(/^(?:zahaj|za[čc]ni|dokon[čc]i|dokon[čc]it|hotovo|zru[šs])\s+(?:[úu]kol\s+)?(.+)$/iu);
  if (taskStatusMatch) {
    const verb = text.match(/^(start|complete|cancel|zahaj|za[čc]ni|dokon[čc]i|dokon[čc]it|hotovo|zru[šs])/iu)?.[1].toLowerCase();
    const started = /^(start|zahaj|za[čc]ni)/iu.test(verb ?? "");
    const finished = /^(complete|dokon[čc]|hotovo)/iu.test(verb ?? "");
    const task_status = started ? "in_progress" : finished ? "completed" : "cancelled";
    return { intent: "change_task_status", entities: { title: taskStatusMatch[1].trim(), task_status } };
  }

  m = text.match(/^(?:create|add|new)\s+service\s+(.+)$/i)
    ?? text.match(/^(?:vytvo[řr]|p[řr]idej|nov[áa])\s+(?:slu[žz]bu|slu[žz]ba)\s+(.+)$/iu);
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

  // Explicit durable {assistant} memory. This is deliberately separate from the
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
    /^(?:log|zaznamenej|zapi[šs])\s+(call|phone call|email|whatsapp|sms|text|messenger|message|meeting|visit|hovor|telefon[áa]t|e-?mail|zpr[áa]vu|sch[ůu]zku|n[áa]v[šs]t[ěe]vu)\s+(with|to|from|s|se|pro|od)\s+(?:klientem\s+|klientkou\s+|client\s+)?(.+?)\s*:\s*(.+)$/iu
  );
  if (m) {
    const channelWord = foldCzech(m[1]);
    const directionWord = foldCzech(m[2]);
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
      // The same channels named in Czech, folded so a dictated diacritic does
      // not decide whether a call is recorded as a call or as "other".
      hovor: "phone_call",
      telefonat: "phone_call",
      zpravu: "messenger",
      schuzku: "in_person",
      navstevu: "in_person",
    };
    const channel = channelMap[channelWord] ?? "other";
    const direction = /^(?:from|od)$/u.test(directionWord) ? "inbound" : "outbound";
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
  if (/^(?:list|show)\s+notifications?$/i.test(text)
    || /^(?:ukaž|ukaz|zobraz|vypiš|vypis)\s+(?:oznámení|oznameni|upozornění|upozorneni)$/iu.test(text)
    || /^(?:pokaż|pokaz|wyświetl|wyswietl)\s+powiadomienia$/iu.test(text)
    || /^(?:notifications?|oznámení|oznameni|upozornění|upozorneni|powiadomienia)$/iu.test(text))
    return { intent: "list_notifications", entities: {} };
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
  if (/^(?:uka[žz]|najdi|zobraz|vyhledej)\s+(?:opakovan[ée]\s+)?(?:[čc]innosti|vzorce|postupy)$/iu.test(text))
    return { intent: "detect_action_patterns", entities: {} };
  if (/^(?:show|detect|list)\s+(?:repeated\s+)?(?:action\s+)?patterns?$/i.test(text))
    return { intent: "detect_action_patterns", entities: {} };

  m = text.match(/^(?:list|show)\s+communications?(?:\s+for\s+(.+))?$/i);
  if (m) return { intent: "list_communications", entities: { client_name: m[1]?.trim() } };

  if (/^(?:list|show(?:\s+me)?|open)\s+clients?$/i.test(text)) return { intent: "list_clients", entities: {} };
  if (/^(?:list|show(?:\s+me)?|open)\s+contacts?$/i.test(text)) return { intent: "list_contacts", entities: {} };
  if (/^(?:list|show(?:\s+me)?|read|open)\s+(?:my\s+)?(?:email|mail)(?:\s+messages?)?s?$/i.test(text))
    return { intent: "list_channel_messages", entities: { channel: "email" } };
  if (/^(?:ukaž|ukaz|přečti|precti|otevři|otevri)\s+(?:mi\s+)?(?:e-?maily|poštu|postu)$/iu.test(text)
    || /^(?:pokaż|pokaz|przeczytaj|otwórz|otworz)\s+(?:mi\s+)?(?:e-?maile|pocztę|poczte)$/iu.test(text))
    return { intent: "list_channel_messages", entities: { channel: "email" } };
  if (/^(?:list|show(?:\s+me)?|read|open)\s+(?:my\s+)?whatsapp(?:\s+messages?)?$/i.test(text))
    return { intent: "list_channel_messages", entities: { channel: "whatsapp" } };
  if (/^(?:list|show(?:\s+me)?|open)\s+jobs?$/i.test(text)) return { intent: "list_jobs", entities: {} };
  if (/^(?:list|show(?:\s+me)?|open)\s+leads?$/i.test(text)) return { intent: "list_leads", entities: {} };

  // Czech listing commands. These existed in English only, so a Czech speaker
  // reached them through the language model: a second of latency, a charge per
  // sentence, and one more place to be misheard. The same words spoken here go
  // straight to the deterministic path the constitution asks for.
  // The nouns are written in the accusative, because that is the case a spoken
  // command uses: "ukaž klienty", not "ukaž klienti".
  m = text.match(CZECH_LIST_COMMAND);
  if (m) {
    const subject = foldCzech(m[1]);
    const client = m[2]?.trim();
    switch (subject) {
      case "klienty": case "zakazniky": return { intent: "list_clients", entities: {} };
      case "kontakty": return { intent: "list_contacts", entities: {} };
      case "zakazky": return { intent: "list_jobs", entities: {} };
      case "ukoly": return { intent: "list_tasks", entities: {} };
      case "poptavky": return { intent: "list_leads", entities: {} };
      case "nabidky": return { intent: "list_quotes", entities: { client_name: client } };
      case "komunikaci": return { intent: "list_communications", entities: { client_name: client } };
      case "fotky": case "fotografie": return { intent: "list_portfolio_photos", entities: { client_name: client } };
      case "volna mista": case "nabor": return { intent: "list_job_openings", entities: {} };
      case "pravidla uceni": return { intent: "list_learning_rules", entities: {} };
      case "nasledne kroky": return { intent: "list_follow_ups", entities: {} };
      case "nevyrizene poptavky": case "nevyrizene dotazy": return { intent: "list_unresolved_enquiries", entities: {} };
      case "oznameni": return { intent: "list_notifications", entities: {} };
      case "kvalitu dat": return { intent: "list_data_quality", entities: {} };
      default: break;
    }
  }

  // "Opan" and "oppen" are common English speech-to-text renderings of
  // "open". Accept them only as command verbs; the page name must still
  // resolve through the authoritative navigation catalogue below.
  m = text.match(/^(?:open|opan|oppen|go\s+to|navigate\s+to|take\s+me\s+to|show\s+me|otevři|otevri|přejdi\s+na|prejdi\s+na|ukaž|ukaz|otwórz|otworz|przejdź\s+do|przejdz\s+do|pokaż|pokaz|ouvre|ouvrir|va\s+à|va\s+a|affiche|öffne|offne|gehe\s+zu|zeige|abre|abrir|ve\s+a|muestra|apri|vai\s+a|mostra)\s+(.+)$/iu);
  if (m) {
    const page = resolveVoicePage(m[1]);
    if (page) return { intent: "navigate", entities: { page } };
  }

  return { intent: "unrecognized", entities: {} };
}
