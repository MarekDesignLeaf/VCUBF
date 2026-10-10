// Polish commands, read only after switching to Polish ("přepni na polštinu",
// "switch to Polish"). With any other language switched on, nothing here is
// consulted, so a Polish sentence is not understood.
//
// These are the Polish forms the system already had, now read only in Polish.

import type { ParsedCommand } from "../commandParser.js";
import { resolveNavigationSection } from "../navigationCatalogue.js";
import {
  NEVER, connectorTarget, extractContact, fold, nameOnly, normalizeDictatedPhone, parseAgendaCommand, parseEmailCommand,
  parseLanguageSwitch, parseNavigation, parseWhatsAppCommand, withoutFinalPunctuation,
  type CommandGrammar, type Parsed,
} from "./shared.js";

const CONNECTORS = {
  wszystkie: "all", integracje: "all", konektory: "all",
  email: "gmail", mail: "gmail", poczta: "gmail", poczte: "gmail",
  kontakty: "google_contacts", kalendarz: "google_calendar",
} as const;

const LEAD_STATUS: Record<string, "new" | "contacted" | "qualified" | "lost"> = {
  nowy: "new", skontaktowany: "contacted", zakwalifikowany: "qualified", utracony: "lost", przegrany: "lost",
};

// "ustaw tempo 120", "normalne tempo": a number, or back to normal.
function speechRate(text: string): Parsed<"set_speech_rate"> | undefined {
  const normalized = fold(text).replace(/[.!?,]+$/g, "");
  const numeric = normalized.match(/tempo\D{0,12}(\d+(?:[.,]\d+)?)/);
  if (numeric) {
    const value = Number(numeric[1].replace(",", "."));
    if (Number.isFinite(value)) return { intent: "set_speech_rate", entities: { rate: value > 3 ? value / 100 : value } };
  }
  if (/\bnormalne\b/.test(normalized) && /\btempo\b/.test(normalized)) return { intent: "set_speech_rate", entities: { change: "normal" } };
  return undefined;
}

function menu(text: string): Parsed<"describe_menu"> | undefined {
  const normalized = withoutFinalPunctuation(text);
  if (/^(?:przeczytaj|pokaż|pokaz|wyświetl|wyswietl)\s+(?:mi\s+)?(?:(?:całe|cale|pełne|pelne|wszystkie)\s+)?(?:(?:pozycje|elementy)\s+)?(?:menu|nawigację|nawigacje)(?:\s+programu)?$/iu.test(normalized)
    || /^co\s+jest\s+w\s+(?:całym|calym|pełnym|pelnym\s+)?(?:menu|nawigacji)$/iu.test(normalized)) {
    return { intent: "describe_menu", entities: {} };
  }
  const named = normalized.match(/^(?:przeczytaj|pokaż|pokaz|wyświetl|wyswietl)\s+(?:mi\s+)?(?:menu|nawigację|nawigacje)(?:\s+sekcję|\s+sekcje)?\s+(.+)$/iu)
    ?? normalized.match(/^co\s+jest\s+w\s+(?:menu|nawigacji)\s+(.+)$/iu);
  const section = named ? resolveNavigationSection(named[1]) : undefined;
  return section ? { intent: "describe_menu", entities: { section } } : undefined;
}

function notificationDeletion(text: string): ParsedCommand | undefined {
  const normalized = withoutFinalPunctuation(text);
  if (/^(?:potwierdź|potwierdz)\s+(?:usunięcie|usuniecie|kasowanie)\s+(?:wszystkich|wszystkie)?\s*(?:powiadomień|powiadomien|powiadomienia)$/iu.test(normalized)) {
    return { intent: "confirm_delete_notifications", entities: {} };
  }
  if (/^(?:anuluj|przerwij)\s+(?:usunięcie|usuniecie|kasowanie)\s+(?:wszystkich|wszystkie)?\s*(?:powiadomień|powiadomien|powiadomienia)$/iu.test(normalized)) {
    return { intent: "cancel_delete_notifications", entities: {} };
  }
  if (/^(?:usuń|usun|skasuj|wyczyść|wyczysc)\s+(?:wszystkie)?\s*(?:powiadomienia|powiadomień|powiadomien)$/iu.test(normalized)
    || /^usuwanie\s+(?:powiadomienia|powiadomień|powiadomien)$/iu.test(normalized)) {
    return { intent: "prepare_delete_notifications", entities: {} };
  }
  return undefined;
}

function clientMutation(text: string): ParsedCommand | undefined {
  const normalized = withoutFinalPunctuation(text);
  if (/^(?:potwierdź|potwierdz)\s+(?:usunięcie|usuniecie|archiwizację|archiwizacje)\s+klienta$/iu.test(normalized)) return { intent: "confirm_archive_client", entities: {} };
  if (/^(?:anuluj|przerwij)\s+(?:usunięcie|usuniecie|archiwizację|archiwizacje)\s+klienta$/iu.test(normalized)) return { intent: "cancel_archive_client", entities: {} };
  let match = normalized.match(/^(?:usuń|usun|skasuj|zarchiwizuj)\s+klienta\s+(.+)$/iu);
  if (match) return { intent: "prepare_archive_client", entities: { client_name: match[1].trim() } };
  match = normalized.match(/^(?:zmień|zmien)\s+nazwę\s+klienta\s+(.+?)\s+na\s+(.+)$/iu);
  if (match) return { intent: "update_client", entities: { client_name: match[1].trim(), display_name: match[2].trim() } };
  match = normalized.match(/^(?:zmień|zmien)\s+(?:e-?mail|email)\s+klienta\s+(.+?)\s+na\s+(\S+@\S+)$/iu);
  if (match) return { intent: "update_client", entities: { client_name: match[1].trim(), email_primary: match[2].trim() } };
  match = normalized.match(/^(?:zmień|zmien)\s+(?:telefon|numer telefonu)\s+klienta\s+(.+?)\s+na\s+(.+)$/iu);
  if (match) return { intent: "update_client", entities: { client_name: match[1].trim(), phone_primary: match[2].trim() } };
  return undefined;
}

function contactMutation(text: string): ParsedCommand | undefined {
  const normalized = withoutFinalPunctuation(text);
  if (/^(?:potwierdź|potwierdz)\s+(?:usunięcie|usuniecie|archiwizację|archiwizacje)\s+kontaktu$/iu.test(normalized)) return { intent: "confirm_archive_contact", entities: {} };
  if (/^(?:anuluj|przerwij)\s+(?:usunięcie|usuniecie|archiwizację|archiwizacje)\s+kontaktu$/iu.test(normalized)) return { intent: "cancel_archive_contact", entities: {} };
  let match = normalized.match(/^(?:usuń|usun|skasuj|zarchiwizuj)\s+kontakt\s+(.+)$/iu);
  if (match) return { intent: "prepare_archive_contact", entities: { contact_name: match[1].trim() } };
  match = normalized.match(/^(?:zmień|zmien)\s+nazwę\s+kontaktu\s+(.+?)\s+na\s+(.+)$/iu);
  if (match) return { intent: "update_contact", entities: { contact_name: match[1].trim(), display_name: match[2].trim() } };
  match = normalized.match(/^(?:zmień|zmien)\s+(?:e-?mail|email)\s+kontaktu\s+(.+?)\s+na\s+(\S+@\S+)$/iu);
  if (match) return { intent: "update_contact", entities: { contact_name: match[1].trim(), email: match[2].trim() } };
  match = normalized.match(/^(?:zmień|zmien)\s+(?:telefon|numer telefonu)\s+kontaktu\s+(.+?)\s+na\s+(.+)$/iu);
  if (match) return { intent: "update_contact", entities: { contact_name: match[1].trim(), phone: match[2].trim() } };
  return undefined;
}

function leadMutation(text: string): Parsed<"update_lead"> | undefined {
  const normalized = withoutFinalPunctuation(text);
  let match = normalized.match(/^(?:zmień|zmien)\s+nazwę\s+leada\s+(.+?)\s+na\s+(.+)$/iu);
  if (match) return { intent: "update_lead", entities: { lead_name: match[1].trim(), name: match[2].trim() } };
  match = normalized.match(/^(?:zmień|zmien)\s+(?:e-?mail|email)\s+leada\s+(.+?)\s+na\s+(\S+@\S+)$/iu);
  if (match) return { intent: "update_lead", entities: { lead_name: match[1].trim(), email: match[2].trim() } };
  match = normalized.match(/^(?:zmień|zmien)\s+(?:telefon|numer telefonu)\s+leada\s+(.+?)\s+na\s+(.+)$/iu);
  if (match) return { intent: "update_lead", entities: { lead_name: match[1].trim(), phone: normalizeDictatedPhone(match[2].trim()) } };
  match = normalized.match(/^(?:oznacz|ustaw)\s+leada\s+(.+?)\s+(?:jako|na)\s+(.+)$/iu);
  const status = match ? LEAD_STATUS[match[2].trim().toLowerCase()] : undefined;
  if (match && status) return { intent: "update_lead", entities: { lead_name: match[1].trim(), lead_status: status } };
  return undefined;
}

function connectors(text: string): ParsedCommand | undefined {
  let match = text.match(/^(?:sprawdź|sprawdz|pokaż|pokaz)\s+(.+?)\s+status$/iu);
  let key = match ? connectorTarget(match[1], CONNECTORS) : undefined;
  if (key) return { intent: "connector_status", entities: { connector_key: key } };
  match = text.match(/^(?:skonfiguruj|połącz|polacz|uruchom)\s+(.+)$/iu);
  key = match ? connectorTarget(match[1], CONNECTORS) : undefined;
  if (key) return { intent: "setup_connectors", entities: { connector_key: key } };
  match = text.match(/^(?:zsynchronizuj|synchronizuj|odśwież|odswiez)\s+(.+)$/iu);
  key = match ? connectorTarget(match[1], CONNECTORS) : undefined;
  if (key) return { intent: "sync_connectors", entities: { connector_key: key } };
  return undefined;
}

function records(text: string): ParsedCommand | undefined {
  const m = text.match(/^(?:utwórz|utworz|dodaj)\s+kontakt\s+(.+)$/iu);
  if (!m) return undefined;
  const contact = extractContact(m[1], { email: ["e-mail", "email"], phone: ["numer telefonu", "telefon"] });
  const displayName = nameOnly(contact.rest);
  if (!displayName || (!contact.email && !contact.phone)) return { intent: "unrecognized", entities: {} };
  return { intent: "create_contact", entities: { display_name: displayName, email: contact.email, phone: contact.phone } };
}

// "przeczytaj wiadomości z WhatsAppa", "pokaż e-maile." Folded and without the
// full stop dictation adds, so reading them needs no language model.
const READ_MESSAGES = /^(?:pokaz|przeczytaj|otworz)(?:\s+mi)?\s+(?:(?:wiadomosci|ostatnie\s+wiadomosci)\s+(?:na|z|ze|w)\s+)?(whatsapp(?:a|ie|u)?|e-?maile|poczte)$/u;

function knowledge(text: string): ParsedCommand | undefined {
  let m = text.match(/^zapamiętaj\s+(?:sobie\s+)?dla\s+(?:firmy|spółki|spolki)\s*,?\s*(?:(?:że|ze)\s+)?(.+)$/iu);
  if (m) return { intent: "create_assistant_memory", entities: { content: m[1].trim(), scope: "company" } };
  m = text.match(/^zapamiętaj(?:\s+sobie)?\s*,?\s*(?:(?:że|ze)\s+)?(.+)$/iu);
  if (m) return { intent: "create_assistant_memory", entities: { content: m[1].trim(), scope: "personal" } };
  m = text.match(/^co\s+(?:pamiętasz|pamietasz)(?:\s+o\s+(.+?))?\??$/iu);
  if (m) return { intent: "recall_assistant_memory", entities: { query: m[1]?.trim() } };
  if (/^(?:pokaż|pokaz|wyświetl|wyswietl)\s+powiadomienia$/iu.test(text) || /^powiadomienia$/iu.test(text)) return { intent: "list_notifications", entities: {} };
  const read = fold(withoutFinalPunctuation(text)).match(READ_MESSAGES);
  if (read) return { intent: "list_channel_messages", entities: { channel: read[1].startsWith("w") ? "whatsapp" : "email" } };
  return undefined;
}

export const polish: CommandGrammar = {
  language: "pl",
  yes: /^(?:potwierdzam|potwierdź|potwierdz|potwierdź\s+akcję|potwierdz\s+akcje|wyślij|wyslij)$/iu,
  no: /^(?:nie|anuluj|anuluj\s+akcję|anuluj\s+akcje|nie\s+wysyłaj|nie\s+wysylaj)$/iu,
  // "pomiń go", "dalej", "następny", "czytaj dalej", "przejdź do następnego".
  readingSkip: /^(?:(?:ok|dobrze|dobra)\s+)?(?:pomin(?:\s+\S+){0,3}|dalej|nastepn[ya](?:\s+(?:nadawca|osoba))?|kolejn[ya](?:\s+(?:nadawca|osoba))?|(?:czytaj|idz|przejdz)\s+dalej|przejdz\s+do\s+(?:nastepnego|nastepnej|kolejnego|kolejnej)|kontynuuj)(?:\s+prosze)?$/u,
  // "starsze", "przeczytaj starsze wiadomości", "więcej od niego".
  readingOlder: /^(?:(?:ok|dobrze|dobra)\s+)?(?:(?:(?:przeczytaj|czytaj|pokaz)\s+)?(?:starsze|wczesniejsze)(?:\s+wiadomosci)?(?:\s+od\s+(?:niego|niej|nich))?|wiecej\s+od\s+(?:niego|niej|nich))(?:\s+prosze)?$/u,
  languageSwitch: {
    patterns: [
      /^(?:zmień|zmien|przełącz|przelacz|ustaw)\s+(?:język|jezyk)(?:\s+emmy|\s+menu)?\s*(?:(?:na|do)\s+)?(.+)$/iu,
      /^(?:tak[,\s]+)?(?:przełącz|przelacz)(?:\s+się|\s+sie)?\s+na\s+(.+)$/iu,
      /^(?:włącz|wlacz|zmień|zmien|przełącz|przelacz|ustaw|uruchom)(?:\s+mi)?\s+(.+)$/iu,
      /^(?:.+\s+)?(?:zmień|zmien|przełącz|przelacz|ustaw)(?:\s+to)?(?:\s+od\s+razu)?(?:\s+język|\s+jezyk)?\s*(?:(?:na|do)\s+)?(.+)$/iu,
      /^(?:chcę|chce|poproszę|poprosze)(?:\s+mieć|\s+miec)?\s+(.+)$/iu,
      /^(?:język|jezyk)\s+(.+)$/iu,
      /^(?:mów|mow|odpowiadaj)\s+(?:po\s+)?(.+)$/iu,
      /^(.+)\s+(?:język|jezyk)$/iu,
    ],
    fillers: ["język", "jezyk", "teraz", "proszę", "prosze", "mi", "na", "do", "to", "kurwa"],
  },
  parse(text) {
    const found = parseLanguageSwitch(text, polish.languageSwitch)
      ?? speechRate(text)
      ?? menu(text)
      ?? parseEmailCommand(text, {
        // The account only as "z konta …", so "z załącznikiem" is not taken for one.
        prefix: /^(?:wyślij|wyslij|napisz)\s+(?:e-?mail|mail)\s+(?:z\s+konta\s+(?<from>.+?)\s+)?(?:do|na)\s*:?\s*(?<rest>.+)$/iu,
        accountAfterRecipients: "ze|z",
        accountSection: NEVER.source,
        subject: "temat",
        body: "treść|tresc|wiadomość|wiadomosc",
      })
      ?? parseWhatsAppCommand(text, "(?:wyślij|wyslij|napisz)\\s+(?:wiadomość\\s+)?(?:na\\s+)?whatsapp\\s+(?:do|na)", "wiadomość|wiadomosc|treść|tresc")
      ?? parseAgendaCommand(text, {
        // "co" is Polish as much as Czech: "co mam jutro w kalendarzu".
        asks: /^(?:co|pokaż|pokaz|sprawdź|sprawdz|przeczytaj|jakie)(?:\s|$)/iu,
        calendar: /(?:kalendarz|wydarzeni|termin|program)/iu,
        ownQuestion: /^(?:jakie|co)\s+mam/iu,
        tomorrow: /jutro/iu,
        week: /(?:najbliższe\s+(?:siedem|7)\s+dni|ten\s+tydzień)/iu,
        today: /(?:dzisiaj|dziś)/iu,
      })
      ?? notificationDeletion(text)
      ?? clientMutation(text)
      ?? leadMutation(text)
      ?? contactMutation(text);
    if (found) return found;
    if (/^(?:potwierdź|potwierdz|wyślij|wyslij)\s+(?:ten\s+)?(?:e-?mail|wiadomość|wiadomosc)$/iu.test(text)) return { intent: "confirm_gmail_message", entities: {} };
    if (/^anuluj\s+(?:ten\s+)?(?:e-?mail|wiadomość|wiadomosc)$/iu.test(text)) return { intent: "cancel_gmail_message", entities: {} };
    if (/^(?:potwierdź|potwierdz|wyślij|wyslij)\s+(?:wiadomość\s+)?(?:na\s+)?whatsapp$/iu.test(text)) return { intent: "confirm_whatsapp_message", entities: {} };
    if (/^anuluj\s+(?:wiadomość\s+)?(?:na\s+)?whatsapp$/iu.test(text)) return { intent: "cancel_whatsapp_message", entities: {} };
    return connectors(text)
      ?? records(text)
      ?? knowledge(text)
      ?? parseNavigation(text, "otwórz|otworz|przejdź\\s+do|przejdz\\s+do|pokaż|pokaz");
  },
};
