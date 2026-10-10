// Czech commands, read only while Czech is the language switched on.
//
// Everything here is Czech: the verbs, the labels inside a command ("předmět",
// "telefon") and the words for yes and no. A sentence in another language is
// not matched here, so with Czech on it is not understood.

import type { ParsedCommand } from "../commandParser.js";
import { resolveNavigationSection } from "../navigationCatalogue.js";
import {
  connectorTarget, extractContact, fold, nameOnly, normalizeDictatedPhone, parseAgendaCommand, parseEmailCommand,
  parseLanguageSwitch, parseNavigation, parseWhatsAppCommand, withoutFinalPunctuation,
  type CommandGrammar, type Parsed,
} from "./shared.js";

// Compared without diacritics: the transcription decides whether they are there.
const UNPAID_INVOICE_QUESTION =
  /^(?:kolik (?:mam|mame) (?:nezaplacenych|neuhrazenych) faktur(?:y)?|kolik (?:je|mame) (?:nezaplacenych|neuhrazenych) faktur(?:y)?|kdo (?:mi|nam) nezaplatil|kdo (?:mi|nam) dluzi|kolik (?:mi|nam) dluzi(?: klienti)?)$/;

// "stav gmailu", "stav kalendáře": Czech names the connector in the genitive,
// and it is the same connector whichever case names it.
const CONNECTORS = {
  vsechny: "all", vse: "all", konektory: "all", integrace: "all", konektoru: "all", integraci: "all",
  email: "gmail", mail: "gmail", posta: "gmail", posty: "gmail", gmailu: "gmail",
  kontakty: "google_contacts", kontaktu: "google_contacts", kalendar: "google_calendar", kalendare: "google_calendar",
} as const;

const LEAD_STATUS: Record<string, "new" | "contacted" | "qualified" | "lost"> = {
  novy: "new", "nový": "new", kontaktovany: "contacted", "kontaktovaný": "contacted",
  kvalifikovany: "qualified", "kvalifikovaný": "qualified", ztraceny: "lost", "ztracený": "lost",
};

// Folded, so a dictated diacritic does not decide whether a call is recorded as
// a call or as "other".
const CHANNELS: Record<string, string> = {
  hovor: "phone_call", telefonat: "phone_call", email: "email", "e-mail": "email", whatsapp: "whatsapp", sms: "sms",
  zpravu: "messenger", schuzku: "in_person", navstevu: "in_person",
};

const CONTACT_LABELS = { email: ["e-mail", "email"], phone: ["telefonní číslo", "telefonni cislo", "telefonu", "telefon"] };

// "ukaž klienty", "vypiš nabídky pro Nováka", "zobraz nevyřízené poptávky". The
// nouns are in the accusative, the case a spoken command uses, and an optional
// "pro …" names the client for the listings that take one.
const LIST_COMMAND =
  /^(?:uka[žz]|vyp[ií][šs]|zobraz|p[řr]e[čc]ti|dej\s+mi|seznam)\s+(?:mi\s+)?((?:nevy[řr][ií]zen[ée]\s+)?[\p{L}\s]+?)(?:\s+pro\s+(.+))?$/iu;

function speechRate(text: string): Parsed<"set_speech_rate"> | undefined {
  const normalized = fold(text).replace(/[.!?,]+$/g, "");
  // An explicit number, so "nastav rychlost 1.4" works as well as a direction;
  // "rychlost 130" is a percentage.
  const numeric = normalized.match(/(?:rychlost|tempo)\D{0,12}(\d+(?:[.,]\d+)?)/);
  if (numeric) {
    const value = Number(numeric[1].replace(",", "."));
    if (Number.isFinite(value)) return { intent: "set_speech_rate", entities: { rate: value > 3 ? value / 100 : value } };
  }
  if (/\b(rychleji|zrychli|zrychlit|rychlejc)\b/.test(normalized)) return { intent: "set_speech_rate", entities: { change: "faster" } };
  if (/\b(pomaleji|zpomal|zpomalit|pomalejc)\b/.test(normalized)) return { intent: "set_speech_rate", entities: { change: "slower" } };
  // "normálně" alone is ambiguous; it has to be about speaking.
  if (/\b(normalne|normalni|obvykle|puvodni)\b/.test(normalized) && /\b(mluv|rikej|rychlost|tempo)\b/.test(normalized)) {
    return { intent: "set_speech_rate", entities: { change: "normal" } };
  }
  return undefined;
}

function menu(text: string): Parsed<"describe_menu"> | undefined {
  const normalized = withoutFinalPunctuation(text);
  if (/^(?:přečti|precti|ukaž|ukaz|vypiš|vypis)\s+(?:mi\s+)?(?:(?:cel[ée]|všechny)\s+)?(?:(?:položky|polozky)\s+)?(?:menu|navigaci|navigace)(?:\s+programu)?$/iu.test(normalized)
    || /^co\s+je\s+v\s+(?:cel[ée]m\s+)?(?:menu|navigaci)$/iu.test(normalized)) {
    return { intent: "describe_menu", entities: {} };
  }
  const named = normalized.match(/^(?:přečti|precti|ukaž|ukaz|vypiš|vypis)\s+(?:mi\s+)?(?:menu|navigaci|navigace)(?:\s+sekci)?\s+(.+)$/iu)
    ?? normalized.match(/^co\s+je\s+v\s+(?:menu|navigaci)\s+(.+)$/iu);
  const section = named ? resolveNavigationSection(named[1]) : undefined;
  return section ? { intent: "describe_menu", entities: { section } } : undefined;
}

function notificationDeletion(text: string): ParsedCommand | undefined {
  const normalized = withoutFinalPunctuation(text);
  if (/^(?:potvrď|potvrd)\s+(?:smazání|smazani|odstranění|odstraneni)\s+(?:všech|vsech|všechna|vsechna|všechny|vsechny)?\s*(?:oznámení|oznameni|upozornění|upozorneni)$/iu.test(normalized)) {
    return { intent: "confirm_delete_notifications", entities: {} };
  }
  if (/^(?:zruš|zrus)\s+(?:smazání|smazani|odstranění|odstraneni)\s+(?:všech|vsech|všechna|vsechna|všechny|vsechny)?\s*(?:oznámení|oznameni|upozornění|upozorneni)$/iu.test(normalized)) {
    return { intent: "cancel_delete_notifications", entities: {} };
  }
  if (/^(?:smaž|smaz|vymaž|vymaz|odstraň|odstran)\s+(?:všechna|vsechna|všechny|vsechny)?\s*(?:oznámení|oznameni|upozornění|upozorneni)$/iu.test(normalized)
    || /^(?:mazání|mazani)\s+(?:oznámení|oznameni)$/iu.test(normalized)) {
    return { intent: "prepare_delete_notifications", entities: {} };
  }
  return undefined;
}

function clientMutation(text: string): ParsedCommand | undefined {
  const normalized = withoutFinalPunctuation(text);
  if (/^(?:potvrď|potvrd)\s+(?:smazání|smazani|archivaci)\s+klienta$/iu.test(normalized)) return { intent: "confirm_archive_client", entities: {} };
  if (/^(?:zruš|zrus)\s+(?:smazání|smazani|archivaci)\s+klienta$/iu.test(normalized)) return { intent: "cancel_archive_client", entities: {} };
  let match = normalized.match(/^(?:smaž|smaz|vymaž|vymaz|odstraň|odstran|archivuj)\s+klienta\s+(.+)$/iu);
  if (match) return { intent: "prepare_archive_client", entities: { client_name: match[1].trim() } };
  match = normalized.match(/^(?:přejmenuj|prejmenuj)\s+klienta\s+(.+?)\s+na\s+(.+)$/iu);
  if (match) return { intent: "update_client", entities: { client_name: match[1].trim(), display_name: match[2].trim() } };
  match = normalized.match(/^(?:změň|zmen)\s+(?:e-?mail|email)\s+klienta\s+(.+?)\s+na\s+(\S+@\S+)$/iu);
  if (match) return { intent: "update_client", entities: { client_name: match[1].trim(), email_primary: match[2].trim() } };
  match = normalized.match(/^(?:změň|zmen)\s+(?:telefon|telefonní číslo|telefonni cislo)\s+klienta\s+(.+?)\s+na\s+(.+)$/iu);
  if (match) return { intent: "update_client", entities: { client_name: match[1].trim(), phone_primary: match[2].trim() } };
  return undefined;
}

function contactMutation(text: string): ParsedCommand | undefined {
  const normalized = withoutFinalPunctuation(text);
  if (/^(?:potvrď|potvrd)\s+(?:smazání|smazani|archivaci)\s+kontaktu$/iu.test(normalized)) return { intent: "confirm_archive_contact", entities: {} };
  if (/^(?:zruš|zrus)\s+(?:smazání|smazani|archivaci)\s+kontaktu$/iu.test(normalized)) return { intent: "cancel_archive_contact", entities: {} };
  let match = normalized.match(/^(?:smaž|smaz|vymaž|vymaz|odstraň|odstran|archivuj)\s+kontakt\s+(.+)$/iu);
  if (match) return { intent: "prepare_archive_contact", entities: { contact_name: match[1].trim() } };
  match = normalized.match(/^(?:přejmenuj|prejmenuj)\s+kontakt\s+(.+?)\s+na\s+(.+)$/iu);
  if (match) return { intent: "update_contact", entities: { contact_name: match[1].trim(), display_name: match[2].trim() } };
  match = normalized.match(/^(?:změň|zmen)\s+(?:e-?mail|email)\s+kontaktu\s+(.+?)\s+na\s+(\S+@\S+)$/iu);
  if (match) return { intent: "update_contact", entities: { contact_name: match[1].trim(), email: match[2].trim() } };
  match = normalized.match(/^(?:změň|zmen)\s+(?:telefon|telefonní číslo|telefonni cislo)\s+kontaktu\s+(.+?)\s+na\s+(.+)$/iu);
  if (match) return { intent: "update_contact", entities: { contact_name: match[1].trim(), phone: match[2].trim() } };
  return undefined;
}

function leadMutation(text: string): Parsed<"update_lead"> | undefined {
  const normalized = withoutFinalPunctuation(text);
  let match = normalized.match(/^(?:přejmenuj|prejmenuj)\s+(?:lead|poptávku|poptavku)\s+(.+?)\s+na\s+(.+)$/iu);
  if (match) return { intent: "update_lead", entities: { lead_name: match[1].trim(), name: match[2].trim() } };
  match = normalized.match(/^(?:změň|zmen)\s+(?:e-?mail|email)\s+(?:leadu|poptávky|poptavky)\s+(.+?)\s+na\s+(\S+@\S+)$/iu);
  if (match) return { intent: "update_lead", entities: { lead_name: match[1].trim(), email: match[2].trim() } };
  match = normalized.match(/^(?:změň|zmen)\s+(?:telefon|telefonní číslo|telefonni cislo)\s+(?:leadu|poptávky|poptavky)\s+(.+?)\s+na\s+(.+)$/iu);
  if (match) return { intent: "update_lead", entities: { lead_name: match[1].trim(), phone: normalizeDictatedPhone(match[2].trim()) } };
  match = normalized.match(/^(?:označ|oznac|nastav)\s+(?:lead|poptávku|poptavku)\s+(.+?)\s+(?:jako|na)\s+(.+)$/iu);
  const status = match ? LEAD_STATUS[match[2].trim().toLowerCase()] : undefined;
  if (match && status) return { intent: "update_lead", entities: { lead_name: match[1].trim(), lead_status: status } };
  return undefined;
}

function connectors(text: string): ParsedCommand | undefined {
  let match = text.match(/^(?:zkontroluj|ukaž|ukaz)\s+(.+?)\s+(?:(?:konektoru|konektora)\s+)?(?:stav|status)$/iu)
    ?? text.match(/^stav\s+(.+?)$/iu);
  let key = match ? connectorTarget(match[1], CONNECTORS) : undefined;
  if (key) return { intent: "connector_status", entities: { connector_key: key } };
  match = text.match(/^(?:nastav|nakonfiguruj|připoj|pripoj|spusť|spust)\s+(.+)$/iu);
  key = match ? connectorTarget(match[1], CONNECTORS) : undefined;
  if (key) return { intent: "setup_connectors", entities: { connector_key: key } };
  match = text.match(/^(?:synchronizuj|obnov)\s+(.+)$/iu);
  key = match ? connectorTarget(match[1], CONNECTORS) : undefined;
  if (key) return { intent: "sync_connectors", entities: { connector_key: key } };
  return undefined;
}

function records(text: string): ParsedCommand | undefined {
  let m = text.match(/^(?:vytvo[řr]|p[řr]idej|nov[ýy])\s+(?:klienta|klient|z[áa]kazn[íi]ka|z[áa]kazn[íi]k)\s+(.+)$/iu);
  if (m) {
    const contact = extractContact(m[1], CONTACT_LABELS);
    const displayName = nameOnly(contact.rest);
    if (!displayName) return { intent: "unrecognized", entities: {} };
    return { intent: "create_client", entities: { display_name: displayName, email_primary: contact.email, phone_primary: contact.phone } };
  }

  m = text.match(/^(?:vytvoř|vytvor|přidej|pridej)\s+kontakt\s+(.+)$/iu);
  if (m) {
    const contact = extractContact(m[1], CONTACT_LABELS);
    const displayName = nameOnly(contact.rest);
    if (!displayName || (!contact.email && !contact.phone)) return { intent: "unrecognized", entities: {} };
    return { intent: "create_contact", entities: { display_name: displayName, email: contact.email, phone: contact.phone } };
  }

  m = text.match(/^(?:vytvo[řr]|p[řr]idej|nov[áa])\s+(?:poptávku|poptavku|popt[áa]vka)\s+(.+)$/iu);
  if (m) {
    let rest = m[1];
    // "pro <službu>" first: the e-mail and phone fields would swallow it.
    const forMatch = rest.match(/\b(?:pro|na)\s+(.+)$/iu);
    let service: string | undefined;
    if (forMatch) {
      service = forMatch[1].trim();
      rest = rest.slice(0, forMatch.index).trim();
    }
    const contact = extractContact(rest, CONTACT_LABELS);
    const name = nameOnly(contact.rest);
    if (!name) return { intent: "unrecognized", entities: {} };
    return { intent: "create_lead", entities: { name, service_requested: service, email: contact.email, phone: contact.phone } };
  }

  m = text.match(/^(?:vytvo[řr]|p[řr]idej|nov[áa])\s+(?:zak[áa]zku|zak[áa]zka)\s+(.+?)\s+pro\s+(?:klienta\s+)?(.+)$/iu);
  if (m) {
    const jobTitle = m[1].trim();
    const clientName = m[2].trim();
    if (!jobTitle || !clientName) return { intent: "unrecognized", entities: {} };
    return { intent: "create_job", entities: { job_title: jobTitle, client_name: clientName } };
  }
  m = text.match(/^(?:zm[ěe][ňn]|nastav|ozna[čc])\s+(?:stav\s+)?zak[áa]zk[yu]\s+(.+?)\s+na\s+(.+)$/iu);
  if (m) return { intent: "change_job_status", entities: { job_title: m[1].trim(), job_status: m[2].trim() } };
  m = text.match(/^(?:p[řr]eve[ďd]|zm[ěe][ňn])\s+popt[áa]vku\s+(.+?)\s+na\s+(?:klienta|z[áa]kazn[íi]ka)$/iu);
  if (m) return { intent: "convert_lead", entities: { lead_name: m[1].trim() } };
  m = text.match(/^(?:p[řr]i[řr]a[ďd]|p[řr]ide[ľl]|zadej)\s+zak[áa]zku\s+(.+?)\s+(?:zam[ěe]stnanci|pracovn[íi]kovi|kolegovi)\s+(.+)$/iu);
  if (m) return { intent: "assign_job", entities: { job_title: m[1].trim(), employee_name: m[2].trim() } };
  if (/^(?:zkontroluj|uka[žz]|ov[ěe][řr])\s+p[řr]et[íi][žz]en[íi]$/iu.test(text)) return { intent: "detect_overload", entities: {} };

  m = text.match(/^(?:vytvo[řr]|p[řr]idej|nov[ýy])\s+[úu]kol\s+pro\s+(.+?)\s*:\s*(.+)$/iu);
  if (m) {
    const employeeName = m[1].trim();
    const title = m[2].trim();
    if (!employeeName || !title) return { intent: "unrecognized", entities: {} };
    return { intent: "create_task", entities: { title, employee_name: employeeName } };
  }
  m = text.match(/^(?:vytvo[řr]|p[řr]idej|nov[ýy])\s+[úu]kol\s+(.+)$/iu);
  if (m) {
    const title = nameOnly(m[1]);
    if (!title) return { intent: "unrecognized", entities: {} };
    return { intent: "create_task", entities: { title } };
  }
  m = text.match(/^(zahaj|za[čc]ni|dokon[čc]i|dokon[čc]it|hotovo|zru[šs])\s+(?:[úu]kol\s+)?(.+)$/iu);
  if (m) {
    const verb = fold(m[1]);
    const task_status = /^(?:zahaj|zacni)$/.test(verb) ? "in_progress" : /^(?:dokonc|hotovo)/.test(verb) ? "completed" : "cancelled";
    return { intent: "change_task_status", entities: { title: m[2].trim(), task_status } };
  }

  m = text.match(/^(?:vytvo[řr]|p[řr]idej|nov[áa])\s+(?:slu[žz]bu|slu[žz]ba)\s+(.+)$/iu);
  if (m) {
    const name = nameOnly(m[1]);
    if (!name) return { intent: "unrecognized", entities: {} };
    return { intent: "create_service", entities: { name } };
  }
  return undefined;
}

// "přečti zprávy na WhatsAppu", "ukaž mi WhatsApp", "přečti e-maily." Folded and
// without the full stop dictation adds, so reading them needs no language model.
const READ_MESSAGES = /^(?:ukaz|precti|otevri|zobraz)(?:\s+mi)?\s+(?:(?:zpravy|posledni\s+zpravy)\s+(?:na|z|ze|v|ve)\s+)?(whatsappu?|whatsappove\s+zpravy|e-?maily|e-?mailove\s+zpravy|postu)$/u;

function knowledge(text: string): ParsedCommand | undefined {
  // Only a direct "zapamatuj si" is ever kept. Dictation drops "že" far more
  // often than the verb, so "že" is optional and the verb is not.
  let m = text.match(/^zapamatuj\s+si\s+pro\s+(?:firmu|společnost|spolecnost)\s*,?\s*(?:(?:že|ze)\s+)?(.+)$/iu);
  if (m) return { intent: "create_assistant_memory", entities: { content: m[1].trim(), scope: "company" } };
  m = text.match(/^zapamatuj\s+si(?:\s+pro\s+(?:mě|me))?\s*,?\s*(?:(?:že|ze)\s+)?(.+)$/iu);
  if (m) return { intent: "create_assistant_memory", entities: { content: m[1].trim(), scope: "personal" } };
  m = text.match(/^(?:co\s+si\s+(?:pamatuješ|pamatujes)|co\s+(?:máš|mas)\s+v\s+(?:paměti|pameti))(?:\s+o\s+(.+?))?\??$/iu);
  if (m) return { intent: "recall_assistant_memory", entities: { query: m[1]?.trim() } };

  // "zaznamenej hovor s Novákem: domluvili jsme termín". "od" is incoming.
  m = text.match(/^(?:zaznamenej|zapi[šs])\s+(hovor|telefon[áa]t|e-?mail|zpr[áa]vu|sch[ůu]zku|n[áa]v[šs]t[ěe]vu|whatsapp|sms)\s+(s|se|pro|od)\s+(?:klientem\s+|klientkou\s+)?(.+?)\s*:\s*(.+)$/iu);
  if (m) {
    const clientName = m[3].trim();
    const summary = m[4].trim();
    if (!clientName || !summary) return { intent: "unrecognized", entities: {} };
    return {
      intent: "log_communication",
      entities: { client_name: clientName, channel: CHANNELS[fold(m[1])] ?? "other", direction: fold(m[2]) === "od" ? "inbound" : "outbound", summary },
    };
  }

  if (/^(?:ukaž|ukaz|zobraz|vypiš|vypis)\s+(?:oznámení|oznameni|upozornění|upozorneni)$/iu.test(text)
    || /^(?:oznámení|oznameni|upozornění|upozorneni)$/iu.test(text)) {
    return { intent: "list_notifications", entities: {} };
  }
  if (/^(?:uka[žz]|najdi|zobraz|vyhledej)\s+(?:opakovan[ée]\s+)?(?:[čc]innosti|vzorce|postupy)$/iu.test(text)) return { intent: "detect_action_patterns", entities: {} };
  const read = fold(withoutFinalPunctuation(text)).match(READ_MESSAGES);
  if (read) return { intent: "list_channel_messages", entities: { channel: read[1].startsWith("w") ? "whatsapp" : "email" } };

  m = text.match(LIST_COMMAND);
  if (m) {
    const client = m[2]?.trim();
    switch (fold(m[1])) {
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
  return undefined;
}

export const czech: CommandGrammar = {
  language: "cs",
  yes: /^(?:ano|potvrzuji|potvrďuji|potvrdit|potvrď\s+akci|potvrd\s+akci|odešli|odesli|tak\s+ano|tak\s+jo)$/iu,
  // "zruš to" answers the review; it is not a task called "to".
  no: /^(?:ne|zruš|zrus|zruš\s+akci|zrus\s+akci|zruš\s+to|zrus\s+to|nezasilat|neodesilat)$/iu,
  // "přeskoč ho", "přeskočte", "přeskoč Petru", "další", "dál", "pokračuj", "čti dál".
  readingSkip: /^(?:(?:tak|ok|okej|dobre|dobra|jo)\s+)?(?:preskoc(?:it|te)?(?:\s+\S+){0,3}|dalsi(?:ho)?(?:\s+(?:odesilatel|odesilatele|kontakt|clovek|cloveka|uzivatel|uzivatele))?|dal|na\s+dalsiho|(?:prejdi|jdi|jdeme|jed|pokracuj)\s+(?:na\s+dalsiho|dal)|pokracuj(?:\s+ve\s+cteni)?|cti\s+dal|(?:precti|cti)\s+(?:zpravy\s+od\s+)?dalsiho)(?:\s+prosim)?$/u,
  // "starší", "přečti starší zprávy", "ještě od něj", "další zprávy od ní".
  readingOlder: /^(?:(?:tak|ok|okej|dobre|jo)\s+)?(?:(?:(?:precti|cti|ukaz)\s+(?:mi\s+)?)?(?:i\s+)?(?:starsi|predchozi)(?:\s+(?:zpravy|zpravu))?(?:\s+od\s+(?:nej|neho|ni|nich|toho|ty|tohoto\s+odesilatele))?|(?:jeste|vic|vice|dalsi\s+zpravy)\s+od\s+(?:nej|neho|ni|nich|toho|ty))(?:\s+prosim)?$/u,
  languageSwitch: {
    patterns: [
      /^(?:zm[eě]ň|zmen|přepni|prepn[ií]|nastav)\s+(?:(?:jazyk\s+)?(?:emmy|menu|sekretary|sekretáře)|jazyk)\s*(?:(?:na|do)\s+)?(.+)$/iu,
      /^(?:(?:ano|ne)[,\s]+)?(?:přepni|prepni|zepni)(?:\s+se)?(?:\s+okamžitě)?\s+(?:do|na)\s+(.+)$/iu,
      /^(?:mluv|mluvte|odpov[ií]dej)\s+(?:pros[ií]m\s+)?(?:v\s+)?(.+)$/iu,
      /^(.+)\s+jazyk$/iu,
    ],
    fillers: ["jazyk", "prosím", "prosim", "mi", "na", "do", "kurva"],
  },
  parse(text) {
    if (UNPAID_INVOICE_QUESTION.test(fold(text).replace(/[.!?]+$/g, "").trim())) {
      return { intent: "execute_action", entities: { action: "get_unpaid_invoices", parameters: {} } };
    }
    const found = parseLanguageSwitch(text, czech.languageSwitch)
      // Before the menu and message commands: "mluv rychleji" is about the voice.
      ?? speechRate(text)
      ?? menu(text)
      ?? parseEmailCommand(text, {
        prefix: /^(?:pošli|posli|odešli|odesli|napiš|napis)\s+(?:(?:z|ze)\s+(?<fromBefore>.+?)\s+)?(?:e-?mail|mail)\s+(?:(?:z|ze)\s+(?<from>.+?)\s+)?(?:na|pro)\s*:?\s*(?<rest>.+)$/iu,
        accountAfterRecipients: "ze|z",
        accountSection: "z\\s+[uú]čtu|z\\s+uctu|[uú]čet|ucet|odes[ií]latel",
        subject: "předmět|predmet",
        body: "zpráva|zprava|text",
      })
      ?? parseWhatsAppCommand(text, "(?:pošli|posli|napiš|napis)\\s+(?:zprávu\\s+)?(?:na\\s+)?whatsapp\\s+(?:na|pro)", "zpráva|zprava|text")
      ?? parseAgendaCommand(text, {
        asks: /^(?:co|jak[éeý]?|ukaž|ukaz|přečti|precti|zkontroluj)(?:\s|$)/iu,
        calendar: /(?:kalendar|kalendář|kalendari|událost|udalost|program|term[ií]n)/iu,
        ownQuestion: /^co\s+m[aá]m/iu,
        tomorrow: /z[ií]tra/iu,
        week: /(?:př[ií]št[ií]ch\s+(?:sedm|7)\s+dn[ií]|tento\s+t[yý]den)/iu,
        today: /dnes/iu,
      })
      ?? notificationDeletion(text)
      ?? clientMutation(text)
      ?? leadMutation(text)
      ?? contactMutation(text);
    if (found) return found;
    if (/^(?:potvrď|potvrd|odešli|odesli)\s+(?:ten\s+)?(?:e-?mail|zprávu|zpravu)$/iu.test(text)) return { intent: "confirm_gmail_message", entities: {} };
    if (/^(?:zruš|zrus)\s+(?:ten\s+)?(?:e-?mail|zprávu|zpravu)$/iu.test(text)) return { intent: "cancel_gmail_message", entities: {} };
    if (/^(?:potvrď|potvrd|odešli|odesli)\s+(?:zprávu\s+)?(?:na\s+)?whatsapp$/iu.test(text)) return { intent: "confirm_whatsapp_message", entities: {} };
    if (/^(?:zruš|zrus)\s+(?:zprávu\s+)?(?:na\s+)?whatsapp$/iu.test(text)) return { intent: "cancel_whatsapp_message", entities: {} };
    return connectors(text)
      ?? records(text)
      ?? knowledge(text)
      ?? parseNavigation(text, "otevři|otevri|přejdi\\s+na|prejdi\\s+na|ukaž|ukaz");
  },
};
