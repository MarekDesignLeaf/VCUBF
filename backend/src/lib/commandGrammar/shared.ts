// The mechanics every language's command grammar shares: pulling labelled
// fields out of a sentence, the sections of an e-mail, connector names, the
// language switch and page navigation. Nothing here contains the words of any
// language; each grammar passes in its own, so a Czech sentence is matched only
// by Czech words and a Polish one only by Polish words.

import type { ParsedCommand } from "../commandParser.js";
import type { ConnectorKey } from "../../connectors/registry.js";
import { resolveSpokenLanguageName, resolveVoiceLanguage } from "../voiceLanguages.js";
import { resolveVoicePage } from "../voiceNavigation.js";

export type Parsed<I extends ParsedCommand["intent"]> = Extract<ParsedCommand, { intent: I }>;

/** One language's commands. */
export interface CommandGrammar {
  /** The language prefix this grammar reads ("cs", "pl", "en", …). */
  language: string;
  /** The command this sentence states, or undefined when it states none. */
  parse(text: string): ParsedCommand | undefined;
  /** A bare yes to the one review that is waiting. */
  yes: RegExp;
  /** A bare no to the one review that is waiting. */
  no: RegExp;
  /**
   * While received messages are being read out: on to the next sender
   * ("přeskoč ho", "další"). Matched against the folded sentence — lowercase,
   * no accents, no punctuation — and only while a reading is in progress, so a
   * bare "další" means nothing at any other time.
   */
  readingSkip: RegExp;
  /**
   * "přeskoč Petru": a skip with words after it, captured. Taken as a skip
   * only when the words name the sender just read or the one named as next
   * (namedIn), so "skip tomorrow's job" is not swallowed. Folded.
   */
  readingSkipNamed: RegExp;
  /** While messages are being read out: more, older ones from the same sender ("starší"). Folded, as readingSkip. */
  readingOlder: RegExp;
  /** The phrases that switch the language, each capturing the language named. */
  languageSwitch: LanguageSwitchPhrases;
}

export interface LanguageSwitchPhrases {
  patterns: RegExp[];
  /** Words around the language's name that are not part of it ("jazyk", "please"). */
  fillers: string[];
}

export const NEVER = /(?!)/;

export function withoutFinalPunctuation(text: string) {
  return text.trim().replace(/[.!?]+$/g, "");
}

/** Lowercase, no accents, single spaces: how dictated words are compared. */
export function fold(value: string) {
  return value.trim().normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/\s+/g, " ");
}

/** Titles said before a name ("pana Nováka", "panią Ewę", "Mr Smith") that name nobody. */
const NAME_TITLES = new Set(["pan", "pana", "panu", "panem", "pani", "slecna", "slecnu", "pania", "mr", "mrs", "ms", "miss"]);

/**
 * Whether the words said name this person: every word but a title starts like
 * a word of the name ("Petru" for Petra, "Nováka" for Novák — Czech and Polish
 * decline names), and there are at most three of them. "Přeskoč zítřejší
 * zakázku" names nobody being read, so it is not taken as a skip.
 */
export function namedIn(said: string, name: string): boolean {
  const parts = fold(name).split(/[^\p{L}\p{N}]+/u).filter((part) => part.length >= 3);
  const words = fold(said).split(/[^\p{L}\p{N}]+/u).filter((word) => word && !NAME_TITLES.has(word));
  // Three letters in common, or all but the last of a short name ("Ewa" → "Ewę").
  const alike = (word: string, part: string) => {
    const length = Math.max(2, Math.min(3, Math.min(word.length, part.length) - 1));
    return word.slice(0, length) === part.slice(0, length);
  };
  return words.length > 0 && words.length <= 3
    && words.every((word) => word.length >= 3 && parts.some((part) => alike(word, part)));
}

/**
 * The value after a label ("email jane@example.com", "phone 0770…"). The last
 * field of a dictated create command is a phone number, and speech recognition
 * writes dictated digits with commas between them, so a field read `toEnd`
 * takes the whole remainder instead of stopping at the first comma.
 */
export function extractLabelled(text: string, label: string, toEnd = false): { value?: string; rest: string } {
  // The label is a whole word: "telefon" must not take the start of "telefonní".
  const re = new RegExp(toEnd ? `,?\\s*${label}(?!\\p{L})\\s*[:]?\\s*(.+)$` : `,?\\s*${label}(?!\\p{L})\\s*[:]?\\s*([^,]+)`, "iu");
  const match = text.match(re);
  if (!match) return { rest: text };
  const value = match[1].trim();
  const rest = (text.slice(0, match.index) + text.slice((match.index ?? 0) + match[0].length)).trim();
  return { value, rest };
}

export function normalizeDictatedPhone(value: string | undefined): string | undefined {
  if (!value) return value;
  // Keep a leading international plus; drop the punctuation dictation puts
  // between digits. Spaces stay, as people write numbers with them.
  return value
    .replace(/(?<=\d)[,;](?=\s*\d)/g, "")
    .replace(/(?<=\d)\.(?=\s*\d)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The e-mail and phone of a dictated create command, by this language's labels. */
export function extractContact(text: string, labels: { email: string[]; phone: string[] }) {
  let email: { value?: string; rest: string } = { rest: text };
  for (const label of labels.email) {
    email = extractLabelled(text, label);
    if (email.value) break;
  }
  let phone: { value?: string; rest: string } = { rest: email.rest };
  for (const label of labels.phone) {
    phone = extractLabelled(email.rest, label, true);
    if (phone.value) break;
  }
  return { email: email.value, phone: normalizeDictatedPhone(phone.value), rest: phone.rest };
}

export function nameOnly(rest: string) {
  return rest.replace(/,\s*$/, "").trim();
}

// --- e-mail -----------------------------------------------------------------

export interface EmailWords {
  /** The start of the command; groups whose names begin with "from" carry the sending account. */
  prefix: RegExp;
  /** Introduces the account straight after the recipients ("… to jane@example.com from personal"). */
  accountAfterRecipients: string;
  /** Labels a section naming the account ("; from: personal"). */
  accountSection: string;
  subject: string;
  body: string;
}

function parseEmailAddresses(raw: string) {
  return raw
    .split(/\s*(?:,|\band\b)\s*/i)
    .map((value) => value.trim())
    .filter(Boolean);
}

function gmailEntities(input: { to: string[]; cc: string[]; bcc: string[]; subject: string; body: string; from?: string }): Parsed<"prepare_gmail_message"> {
  const { from, ...message } = input;
  return { intent: "prepare_gmail_message", entities: from ? { ...message, from } : message };
}

// With two Gmail accounts connected the user may name the sending one. It is
// recognised only in explicit positions — before the recipients, right after
// them or as its own section — never guessed out of the body. The review always
// names the account, so a qualifier left inside the body is heard before
// anything is sent.
export function parseEmailCommand(text: string, words: EmailWords): Parsed<"prepare_gmail_message"> | undefined {
  const prefix = text.match(words.prefix);
  if (!prefix?.groups?.rest) return undefined;
  const rest = prefix.groups.rest.trim();
  const namedFirst = Object.entries(prefix.groups)
    .filter(([name, value]) => name.startsWith("from") && value?.trim())
    .map(([, value]) => value.trim())[0];
  const recipientsAndAccount = (raw: string): { to: string[]; from?: string } => {
    const named = raw.match(new RegExp(`^(.*@[^\\s,;]+)\\s*,?\\s+(?:${words.accountAfterRecipients})\\s+(.+)$`, "iu"));
    return named ? { to: parseEmailAddresses(named[1]), from: named[2].trim() } : { to: parseEmailAddresses(raw) };
  };

  // Dictation often comes back with commas. This form takes only recipients,
  // subject and body; the semicolon form below also allows copies without
  // confusing them with commas inside the body.
  const commaForm = rest.match(new RegExp(`^(.+?)\\s*,\\s*(?:${words.subject})\\s*:?\\s*(.+?)\\s*,\\s*(?:${words.body})\\s*:?\\s*(.+)$`, "iu"));
  if (commaForm) {
    const recipients = recipientsAndAccount(commaForm[1]);
    const subject = commaForm[2].trim();
    const body = commaForm[3].trim();
    if (recipients.to.length && subject && body) {
      return gmailEntities({ to: recipients.to, cc: [], bcc: [], subject, body, from: namedFirst ?? recipients.from });
    }
    return undefined;
  }

  const sections = rest.split(/\s*;\s*/);
  const recipients = recipientsAndAccount(sections.shift() ?? "");
  let from = namedFirst ?? recipients.from;
  let cc: string[] = [];
  let bcc: string[] = [];
  let subject = "";
  let body = "";
  const accountSection = new RegExp(`^(?:${words.accountSection})\\s*:?\\s*(.+)$`, "iu");
  const subjectSection = new RegExp(`^(?:${words.subject})\\s*:?\\s*(.+)$`, "iu");
  const bodySection = new RegExp(`^(?:${words.body})\\s*:?\\s*(.*)$`, "iu");
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
    match = section.match(accountSection);
    if (match) {
      from = match[1].trim();
      continue;
    }
    match = section.match(subjectSection);
    if (match) {
      subject = match[1].trim();
      continue;
    }
    match = section.match(bodySection);
    if (match) {
      body = [match[1], ...sections.slice(index + 1)].join("; ").trim();
      break;
    }
  }
  if (!recipients.to.length || !subject || !body) return undefined;
  return gmailEntities({ to: recipients.to, cc, bcc, subject, body, from });
}

// --- WhatsApp ----------------------------------------------------------------

export function parseWhatsAppCommand(text: string, prefix: string, bodyLabels: string): Parsed<"prepare_whatsapp_message"> | undefined {
  const match = text.match(new RegExp(`^(?:${prefix})\\s*:?[ ]*(\\+?[\\d ()-]{7,30})\\s*(?:;|,)?\\s*(?:(?:${bodyLabels})\\s*:?)?\\s*(.+)$`, "iu"));
  if (!match) return undefined;
  const to = match[1].trim();
  const body = match[2].trim();
  return to && body ? { intent: "prepare_whatsapp_message", entities: { to, body } } : undefined;
}

// --- calendar ----------------------------------------------------------------

export interface AgendaWords {
  /** How a question about the calendar begins. */
  asks: RegExp;
  /** Words that make it about the calendar. */
  calendar: RegExp;
  /** A question that is about the calendar on its own ("what do I have"). */
  ownQuestion: RegExp;
  tomorrow: RegExp;
  week: RegExp;
  today: RegExp;
}

export function parseAgendaCommand(text: string, words: AgendaWords): Parsed<"list_calendar_events"> | undefined {
  const normalized = withoutFinalPunctuation(text);
  if (!words.asks.test(normalized)) return undefined;
  if (!words.calendar.test(normalized) && !words.ownQuestion.test(normalized)) return undefined;
  if (words.tomorrow.test(normalized)) return { intent: "list_calendar_events", entities: { period: "tomorrow" } };
  if (words.week.test(normalized)) return { intent: "list_calendar_events", entities: { period: "next_7_days" } };
  if (words.today.test(normalized)) return { intent: "list_calendar_events", entities: { period: "today" } };
  return undefined;
}

// --- connectors --------------------------------------------------------------

/** Product names, said the same way in every language. */
const PRODUCT_NAMES: Record<string, ConnectorKey> = {
  gmail: "gmail",
  "google contacts": "google_contacts",
  "google calendar": "google_calendar",
  "google drive": "google_drive",
  "google drive photos": "google_drive",
  "google photos": "google_photos",
  "google photo": "google_photos",
  whatsapp: "whatsapp_business",
  "whatsapp business": "whatsapp_business",
};

export function connectorTarget(raw: string, words: Record<string, ConnectorKey | "all">, trim: RegExp[] = []): ConnectorKey | "all" | undefined {
  let normalized = raw.trim().normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/[.!?]+$/g, "")
    .replace(/[-_]+/g, " ").replace(/\s+/g, " ");
  for (const pattern of trim) normalized = normalized.replace(pattern, "");
  return words[normalized] ?? PRODUCT_NAMES[normalized];
}

// --- language ----------------------------------------------------------------

function switchTarget(rawTarget: string, fillers: Set<string>) {
  const direct = resolveVoiceLanguage(rawTarget);
  if (direct) return direct;
  const cleaned = rawTarget
    .replace(/[^\p{L}\p{N}-]+/gu, " ")
    .split(/\s+/u)
    .filter((word) => word.length > 0 && !fillers.has(word.toLocaleLowerCase("en")))
    .join(" ");
  return resolveVoiceLanguage(cleaned);
}

export function parseLanguageSwitch(text: string, phrases: LanguageSwitchPhrases): Parsed<"set_voice_language"> | undefined {
  const fillers = new Set(phrases.fillers);
  for (const pattern of phrases.patterns) {
    const match = text.match(pattern);
    const language = match ? switchTarget(match[1], fillers) : undefined;
    if (language) return { intent: "set_voice_language", entities: { language } };
  }
  return undefined;
}

/**
 * Just the name of a language ("English", "čeština", "polski"). It answers a
 * question about which language, and it is the way out of any language: whoever
 * is stuck in one they do not speak can still say the name of their own. Named
 * in full, though — a bare "it" or "pl" is a word or noise, not a request.
 */
export function parseLanguageName(text: string): Parsed<"set_voice_language"> | undefined {
  const language = resolveSpokenLanguageName(text);
  return language ? { intent: "set_voice_language", entities: { language } } : undefined;
}

// --- navigation --------------------------------------------------------------

/** "open calendar", "otevři kalendář": a verb of this language, then a page of the menu. */
export function parseNavigation(text: string, verbs: string): Parsed<"navigate"> | undefined {
  const match = text.match(new RegExp(`^(?:${verbs})\\s+(.+)$`, "iu"));
  const page = match ? resolveVoicePage(match[1]) : undefined;
  return page ? { intent: "navigate", entities: { page } } : undefined;
}
