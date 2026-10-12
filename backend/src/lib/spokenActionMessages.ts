// What Alfonzo says about a reviewed action, in the user's own language.
//
// A review is only a review if the person hears what will happen. The services
// return the facts (recipient, the exact text that will be sent, the resolved
// day and time, clashes); this module turns them into one spoken sentence in
// Czech, Polish or English and ends with the question the yes answers. It only
// words facts the service returned — nothing is added or guessed here. Other
// languages fall back to English. The assistant is male, so first-person
// Czech and Polish forms are masculine or neutral.

import { addDays, BUSINESS_TIME_ZONE, localDateTime } from "./spokenDate.js";
import type { ReadingTurn } from "../services/messageReadingService.js";
import type { RecordKind } from "./recordKinds.js";

type Locale = "cs" | "pl" | "en";
type Row = Record<string, any>;

function locale(language: string): Locale {
  const code = language.slice(0, 2).toLocaleLowerCase("en");
  return code === "cs" || code === "pl" ? code : "en";
}

/** Context only (the message being answered) may be shortened. */
function quote(text: unknown, max?: number) {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  return max !== undefined && value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

const CS_ON_DAY = ["v neděli", "v pondělí", "v úterý", "ve středu", "ve čtvrtek", "v pátek", "v sobotu"];
const PL_ON_DAY = ["w niedzielę", "w poniedziałek", "we wtorek", "w środę", "w czwartek", "w piątek", "w sobotę"];

/** "zítra 6. října", "v pátek 9. října", "tomorrow, 6 October", "on Friday 9 October". */
function spokenDay(date: string, timeZone: string | undefined, lang: Locale) {
  const [year, month, day] = date.split("-").map(Number);
  const value = new Date(Date.UTC(year, month - 1, day));
  const monthDay = new Intl.DateTimeFormat(lang === "cs" ? "cs-CZ" : lang === "pl" ? "pl-PL" : "en-GB", { day: "numeric", month: "long", timeZone: "UTC" }).format(value);
  let today: string | undefined;
  try { today = localDateTime(new Date(), timeZone || "UTC").date; } catch { today = undefined; }
  const relative = today === date ? { cs: "dnes", pl: "dziś", en: "today" } : today && addDays(today, 1) === date ? { cs: "zítra", pl: "jutro", en: "tomorrow" } : undefined;
  if (relative) return lang === "en" ? `${relative.en}, ${monthDay}` : `${relative[lang]} ${monthDay}`;
  const weekday = value.getUTCDay();
  if (lang === "cs") return `${CS_ON_DAY[weekday]} ${monthDay}`;
  if (lang === "pl") return `${PL_ON_DAY[weekday]} ${monthDay}`;
  return `on ${new Intl.DateTimeFormat("en-GB", { weekday: "long", timeZone: "UTC" }).format(value)} ${monthDay}`;
}

// "od čtvrtka 3. ledna do pátku 4. ledna": in a range the weekday follows od/do.
const CS_FROM_TO = ["neděle", "pondělí", "úterý", "středy", "čtvrtka", "pátku", "soboty"];
const PL_FROM_TO = ["niedzieli", "poniedziałku", "wtorku", "środy", "czwartku", "piątku", "soboty"];

function rangeDay(date: string, lang: Locale) {
  const [year, month, day] = date.split("-").map(Number);
  const value = new Date(Date.UTC(year, month - 1, day));
  const monthDay = new Intl.DateTimeFormat(lang === "cs" ? "cs-CZ" : lang === "pl" ? "pl-PL" : "en-GB", { day: "numeric", month: "long", timeZone: "UTC" }).format(value);
  if (lang === "cs") return `${CS_FROM_TO[value.getUTCDay()]} ${monthDay}`;
  if (lang === "pl") return `${PL_FROM_TO[value.getUTCDay()]} ${monthDay}`;
  return `${new Intl.DateTimeFormat("en-GB", { weekday: "long", timeZone: "UTC" }).format(value)} ${monthDay}`;
}

function spokenSlot(slot: Row | undefined, timeZone: string | undefined, lang: Locale) {
  if (!slot?.date) return "";
  const day = spokenDay(slot.date, timeZone, lang);
  if (slot.allDay) {
    if (slot.lastDate && slot.lastDate !== slot.date) {
      const first = rangeDay(slot.date, lang);
      const last = rangeDay(slot.lastDate, lang);
      return lang === "cs" ? `na celé dny od ${first} do ${last}` : lang === "pl" ? `na całe dni od ${first} do ${last}` : `all day from ${first} to ${last}`;
    }
    return lang === "cs" ? `na celý den ${day}` : lang === "pl" ? `na cały dzień ${day}` : `all day ${day}`;
  }
  // An event that ends on a later day says so; "from 22:00 to 01:00" alone would hide a day.
  if (slot.endDate && slot.endDate !== slot.date) {
    const first = rangeDay(slot.date, lang);
    const last = rangeDay(slot.endDate, lang);
    return lang === "cs" ? `od ${first} ${slot.start} do ${last} ${slot.end}` : lang === "pl" ? `od ${first} ${slot.start} do ${last} ${slot.end}` : `from ${first} at ${slot.start} to ${last} at ${slot.end}`;
  }
  return lang === "cs" ? `${day} od ${slot.start} do ${slot.end}` : lang === "pl" ? `${day} od ${slot.start} do ${slot.end}` : `${day} from ${slot.start} to ${slot.end}`;
}

function spokenLanguage(label: unknown, lang: Locale) {
  const value = String(label ?? "");
  const names: Array<[RegExp, Record<Locale, string>]> = [
    [/English/i, { cs: "anglicky", pl: "po angielsku", en: "in English" }],
    [/Czech/i, { cs: "česky", pl: "po czesku", en: "in Czech" }],
    [/Polish/i, { cs: "polsky", pl: "po polsku", en: "in Polish" }],
    [/German/i, { cs: "německy", pl: "po niemiecku", en: "in German" }],
    [/French/i, { cs: "francouzsky", pl: "po francusku", en: "in French" }],
    [/Spanish/i, { cs: "španělsky", pl: "po hiszpańsku", en: "in Spanish" }],
    [/Italian/i, { cs: "italsky", pl: "po włosku", en: "in Italian" }],
  ];
  for (const [pattern, words] of names) if (pattern.test(value)) return words[lang];
  return value ? (lang === "cs" ? `v jazyce ${value}` : lang === "pl" ? `w języku ${value}` : `in ${value}`) : "";
}

function clashSentence(clashes: unknown, lang: Locale, truncated = false) {
  if (!Array.isArray(clashes) || !clashes.length) return "";
  const titles = clashes.slice(0, 3).map((clash: Row) => `${clash.title}${clash.start?.time ? ` (${clash.start.time})` : ""}`).join(", ");
  // Only three are named; the rest are counted, so the list is never heard as
  // complete when it is not. Past the listed limit the count is "more than".
  const more = clashes.length - 3;
  const rest = more <= 0 ? ""
    : truncated ? (lang === "cs" ? ` a ještě víc než ${more}` : lang === "pl" ? ` i jeszcze ponad ${more}` : ` and over ${more} more`)
      : (lang === "cs" ? ` a ještě ${more}` : lang === "pl" ? ` i jeszcze ${more}` : ` and ${more} more`);
  return lang === "cs" ? ` Pozor, v tu dobu už je v kalendáři: ${titles}${rest}.`
    : lang === "pl" ? ` Uwaga, w tym czasie w kalendarzu jest już: ${titles}${rest}.`
      : ` Note that the calendar already has ${titles}${rest} at that time.`;
}

/** "3 minutes ago", in the words each language counts minutes with. */
function minutesAgo(minutes: number, lang: Locale) {
  if (minutes < 1) return lang === "cs" ? "před chvílí" : lang === "pl" ? "przed chwilą" : "a moment ago";
  if (lang === "cs") return minutes === 1 ? "před minutou" : `před ${minutes} minutami`;
  if (lang === "pl") {
    if (minutes === 1) return "minutę temu";
    const few = minutes % 10 >= 2 && minutes % 10 <= 4 && (minutes % 100 < 12 || minutes % 100 > 14);
    return `${minutes} ${few ? "minuty" : "minut"} temu`;
  }
  return minutes === 1 ? "a minute ago" : `${minutes} minutes ago`;
}

/**
 * Said before the question when exactly this message already went to the
 * same recipients shortly before: after a request that got no answer in time,
 * the yes must be given knowing it would send a second copy.
 */
function repeatSentence(alreadySent: unknown, lang: Locale) {
  const minutes = alreadySent && typeof alreadySent === "object" ? (alreadySent as Row).minutesAgo : undefined;
  if (typeof minutes !== "number" || !Number.isFinite(minutes)) return "";
  const ago = minutesAgo(minutes, lang);
  return lang === "cs" ? ` Pozor: přesně tohle jsem už odeslal ${ago}.`
    : lang === "pl" ? ` Uwaga: dokładnie to wysłałem już ${ago}.`
      : ` Note: I already sent exactly this ${ago}.`;
}

/** The spoken review for an action waiting for a yes, or undefined if this module does not word it. */
/** "7 messages on WhatsApp" in each language, with the right plural. */
function messagesOn(count: number, channel: unknown, lang: Locale): string {
  const where = channel === "whatsapp"
    ? { cs: "na WhatsAppu", pl: "na WhatsAppie", en: "on WhatsApp" }
    : channel === "email"
      ? { cs: "v e-mailu", pl: "w e-mailu", en: "in email" }
      : channel && channel !== "all"
        ? { cs: `v kanálu ${String(channel)}`, pl: `w kanale ${String(channel)}`, en: `on ${String(channel)}` }
        : { cs: "ve všech kanálech", pl: "we wszystkich kanałach", en: "across all channels" };
  if (lang === "cs") {
    const word = count === 1 ? "zprávu" : count >= 2 && count <= 4 ? "zprávy" : "zpráv";
    return `${count} ${word} ${where.cs}`;
  }
  if (lang === "pl") {
    const word = count === 1 ? "wiadomość" : "wiadomości";
    return `${count} ${word} ${where.pl}`;
  }
  return `${count} ${count === 1 ? "message" : "messages"} ${where.en}`;
}

function sendersList(preview: Row, lang: Locale): string {
  const senders = Array.isArray(preview.senders) ? preview.senders.map(String) : [];
  if (senders.length === 0) return "";
  const others = Number(preview.otherSenders) || 0;
  const list = senders.join(", ");
  if (lang === "cs") return ` Od: ${list}${others ? ` a dalších ${others}` : ""}.`;
  if (lang === "pl") return ` Od: ${list}${others ? ` i jeszcze ${others}` : ""}.`;
  return ` From: ${list}${others ? ` and ${others} more` : ""}.`;
}

export function spokenReview(action: string, preview: Row | undefined, language: string): string | undefined {
  if (!preview) return undefined;
  const lang = locale(language);
  switch (action) {
    case "resolve_communication_intakes": {
      const what = messagesOn(Number(preview.count) || 0, preview.channel, lang);
      const senders = sendersList(preview, lang);
      const more = preview.moreRemain
        ? (lang === "cs" ? " Další zbudou na příště." : lang === "pl" ? " Pozostałe zostaną na następny raz." : " The rest will remain for next time.")
        : "";
      if (lang === "cs") return `Označím jako vyřízené ${what}.${senders}${more} Nic se neodešle ani nesmaže. Mám to udělat?`;
      if (lang === "pl") return `Oznaczę jako załatwione ${what}.${senders}${more} Nic nie zostanie wysłane ani usunięte. Czy mam to zrobić?`;
      return `I will mark ${what} as resolved.${senders}${more} Nothing is sent or deleted. Shall I do it?`;
    }
    case "reply_whatsapp": {
      const who = preview.recipientName || preview.to;
      const how = spokenLanguage(preview.sentIn, lang);
      const again = repeatSentence(preview.alreadySent, lang);
      if (lang === "cs") return `Odpověď pro ${who} na zprávu „${quote(preview.inReplyTo?.text, 160)}“. Pošlu ${how}: „${quote(preview.body)}“.${again} Mám ji odeslat?`;
      if (lang === "pl") return `Odpowiedź dla ${who} na wiadomość „${quote(preview.inReplyTo?.text, 160)}”. Wyślę ${how}: „${quote(preview.body)}”.${again} Czy mam ją wysłać?`;
      return `Reply to ${who} about “${quote(preview.inReplyTo?.text, 160)}”. I will send ${how}: “${quote(preview.body)}”.${again} Shall I send it?`;
    }
    case "reply_email": {
      // Who it goes to, which mailbox it leaves from and which email it answers.
      // The address is said too: a display name is whatever the sender typed.
      const address = Array.isArray(preview.to) ? preview.to[0] : preview.to;
      const who = preview.recipientName && preview.recipientName !== address ? `${preview.recipientName} (${address})` : address;
      const about = quote(preview.inReplyTo?.subject || preview.inReplyTo?.text, 160);
      const how = spokenLanguage(preview.sentIn, lang);
      const from = typeof preview.fromAccount === "string" && preview.fromAccount ? preview.fromAccount : "";
      const again = repeatSentence(preview.alreadySent, lang);
      if (lang === "cs") return `Odpověď pro ${who} na e-mail „${about}“${from ? `, z účtu ${from}` : ""}. Pošlu ${how}: „${quote(preview.body)}“.${again} Mám ji odeslat?`;
      if (lang === "pl") return `Odpowiedź dla ${who} na e-mail „${about}”${from ? `, z konta ${from}` : ""}. Wyślę ${how}: „${quote(preview.body)}”.${again} Czy mam ją wysłać?`;
      return `Reply to ${who} about “${about}”${from ? `, from ${from}` : ""}. I will send ${how}: “${quote(preview.body)}”.${again} Shall I send it?`;
    }
    case "send_whatsapp": {
      const how = preview.sentIn ? ` ${spokenLanguage(preview.sentIn, lang)}` : "";
      const again = repeatSentence(preview.alreadySent, lang);
      if (lang === "cs") return `Pošlu na WhatsApp na číslo ${preview.to}${how}: „${quote(preview.body)}“.${again} Mám ji odeslat?`;
      if (lang === "pl") return `Wyślę na WhatsApp na numer ${preview.to}${how}: „${quote(preview.body)}”.${again} Czy mam ją wysłać?`;
      return `I will send a WhatsApp message to ${preview.to}${how}: “${quote(preview.body)}”.${again} Shall I send it?`;
    }
    case "send_email": {
      const recipients = (Array.isArray(preview.to) ? preview.to : [preview.to]).filter(Boolean).join(", ");
      // Copy and blind copy are said separately: one is visible to everyone, the other is not.
      const list = (value: unknown) => (Array.isArray(value) ? value : value ? [value] : []).filter(Boolean).join(", ");
      const cc = list(preview.cc);
      const bcc = list(preview.bcc);
      const how = preview.sentIn ? ` ${spokenLanguage(preview.sentIn, lang)}` : "";
      // With two mailboxes connected the owner hears which one it leaves from.
      const from = typeof preview.fromAccount === "string" && preview.fromAccount ? preview.fromAccount : "";
      const again = repeatSentence(preview.alreadySent, lang);
      if (lang === "cs") return `Pošlu${from ? ` z účtu ${from}` : ""} e-mail na ${recipients}${cc ? `, v kopii ${cc}` : ""}${bcc ? `, ve skryté kopii ${bcc}` : ""}${how}. Předmět: „${quote(preview.subject)}“. Text: „${quote(preview.body)}“.${again} Mám ho odeslat?`;
      if (lang === "pl") return `Wyślę${from ? ` z konta ${from}` : ""} e-mail do ${recipients}${cc ? `, w kopii ${cc}` : ""}${bcc ? `, w ukrytej kopii ${bcc}` : ""}${how}. Temat: „${quote(preview.subject)}”. Treść: „${quote(preview.body)}”.${again} Czy mam go wysłać?`;
      return `I will email ${recipients}${cc ? `, copying ${cc}` : ""}${bcc ? `, blind-copying ${bcc}` : ""}${from ? `, from ${from}` : ""}${how}. Subject: “${quote(preview.subject)}”. Text: “${quote(preview.body)}”.${again} Shall I send it?`;
    }
    case "update_service":
    case "update_invoice": {
      const changes = spokenChanges(preview.changes, lang);
      if (action === "update_service") {
        if (lang === "cs") return `Změním službu „${quote(preview.service)}“: ${changes}. Mám to uložit?`;
        if (lang === "pl") return `Zmienię usługę „${quote(preview.service)}”: ${changes}. Czy mam to zapisać?`;
        return `I will change the service “${quote(preview.service)}”: ${changes}. Shall I save it?`;
      }
      if (lang === "cs") return `Změním fakturu ${quote(preview.invoice)}${preview.client ? ` (${quote(preview.client)})` : ""}: ${changes}. Mám to uložit?`;
      if (lang === "pl") return `Zmienię fakturę ${quote(preview.invoice)}${preview.client ? ` (${quote(preview.client)})` : ""}: ${changes}. Czy mam to zapisać?`;
      return `I will change the invoice ${quote(preview.invoice)}${preview.client ? ` (${quote(preview.client)})` : ""}: ${changes}. Shall I save it?`;
    }
    case "send_notification_digest": {
      const count = Number(preview.itemCount) || 0;
      const urgent = Number(preview.urgentCount) || 0;
      const to = (Array.isArray(preview.to) ? preview.to : [preview.to]).filter(Boolean).join(", ");
      if (lang === "cs") return `Pošlu vám souhrn na ${to}: ${count} ${count === 1 ? "položka" : count < 5 ? "položky" : "položek"}${urgent ? `, z toho ${urgent} naléhav${urgent === 1 ? "á" : urgent < 5 ? "é" : "ých"}` : ""}. Předmět: „${quote(preview.subject)}“. Mám ho odeslat?`;
      if (lang === "pl") return `Wyślę Ci podsumowanie na ${to}: pozycji ${count}${urgent ? `, w tym pilnych ${urgent}` : ""}. Temat: „${quote(preview.subject)}”. Czy mam je wysłać?`;
      return `I will email you the summary at ${to}: ${count} item${count === 1 ? "" : "s"}${urgent ? `, ${urgent} urgent` : ""}. Subject: “${quote(preview.subject)}”. Shall I send it?`;
    }
    case "clear_voice_history": {
      const how = counted(Number(preview.conversations) || 0, lang, CONVERSATIONS);
      const email = Number(preview.pendingEmails) > 0;
      if (lang === "cs") return `Smažu všechny uložené rozhovory se mnou, celkem ${how}${email ? ", a zruším e-mail, který čeká na vaše ano" : ""}. Skončí tím i tenhle rozhovor a vrátit to nepůjde. Mám je smazat?`;
      if (lang === "pl") return `Usunę wszystkie zapisane rozmowy ze mną, razem ${how}${email ? ", i anuluję e-mail czekający na potwierdzenie" : ""}. Zakończy się też ta rozmowa i nie da się tego cofnąć. Czy mam je usunąć?`;
      return `I will delete all your saved conversations with me, ${how} in total${email ? ", and withdraw the email waiting for your yes" : ""}. This conversation will end too, and it cannot be undone. Shall I delete them?`;
    }
    case "remove_voice_alias": {
      if (lang === "cs") return `Zapomenu slovo „${quote(preview.heard)}“, které jsem bral jako „${quote(preview.means)}“. Mám ho odebrat?`;
      if (lang === "pl") return `Zapomnę słowo „${quote(preview.heard)}”, które rozumiałem jako „${quote(preview.means)}”. Czy mam je usunąć?`;
      return `I will forget “${quote(preview.heard)}”, which I have been taking as “${quote(preview.means)}”. Shall I remove it?`;
    }
    case "send_quote":
    case "send_invoice": {
      const isQuote = action === "send_quote";
      const reference = String(preview.document?.reference ?? "");
      // An invoice's reference carries its outstanding amount in English; only its number is said.
      const named = isQuote ? `„${quote(reference)}“` : reference.split(" — ")[0].split(" (")[0];
      const namedPl = isQuote ? `„${quote(reference)}”` : named;
      const namedEn = isQuote ? `“${quote(reference)}”` : named;
      const client = String(preview.document?.client?.label ?? "");
      const recipients = (Array.isArray(preview.to) ? preview.to : [preview.to]).filter(Boolean).join(", ");
      const account = String(preview.source?.accountEmail || preview.source?.displayName || "");
      const marksSent = isQuote && preview.statusChange?.to === "sent";
      if (lang === "cs") {
        return `Pošlu ${isQuote ? "nabídku" : "fakturu"} ${named} klientovi ${client} na ${recipients} jako PDF${account ? ` z účtu ${account}` : ""}. Předmět: „${quote(preview.subject)}“. Text: „${quote(preview.body)}“.${marksSent ? " Nabídka se tím označí jako odeslaná." : ""} Mám ji odeslat?`;
      }
      if (lang === "pl") {
        return `Wyślę ${isQuote ? "ofertę" : "fakturę"} ${namedPl} klientowi ${client} na ${recipients} jako PDF${account ? ` z konta ${account}` : ""}. Temat: „${quote(preview.subject)}”. Treść: „${quote(preview.body)}”.${marksSent ? " Oferta zostanie oznaczona jako wysłana." : ""} Czy mam ją wysłać?`;
      }
      return `I will email the ${isQuote ? "quote" : "invoice"} ${namedEn} to ${client} at ${recipients} as a PDF${account ? `, from ${account}` : ""}. Subject: “${quote(preview.subject)}”. Text: “${quote(preview.body)}”.${marksSent ? " The quote will be marked as sent." : ""} Shall I send it?`;
    }
    case "create_calendar_event": {
      const when = spokenSlot(preview, preview.timeZone, lang);
      const assumed = preview.durationAssumed
        ? (lang === "cs" ? " Délku jste neřekl, počítám hodinu." : lang === "pl" ? " Nie podano długości, liczę godzinę." : " No length was given, so I have allowed one hour.")
        : "";
      const clash = clashSentence(preview.clashes, lang, preview.clashesTruncated === true);
      if (lang === "cs") return `Zapíšu „${quote(preview.title)}“ ${when}.${assumed}${clash} Mám to zapsat?`;
      if (lang === "pl") return `Zapiszę „${quote(preview.title)}” ${when}.${assumed}${clash} Czy mam to zapisać?`;
      return `I will put “${quote(preview.title)}” in the calendar ${when}.${assumed}${clash} Shall I add it?`;
    }
    case "move_calendar_event": {
      const from = spokenSlot(preview.from, preview.timeZone, lang);
      const to = spokenSlot(preview.to, preview.timeZone, lang);
      const clash = clashSentence(preview.clashes, lang, preview.clashesTruncated === true);
      if (lang === "cs") return `Přesunu „${quote(preview.title)}“. Teď: ${from}. Nově: ${to}.${clash} Mám ji přesunout?`;
      if (lang === "pl") return `Przeniosę „${quote(preview.title)}”. Teraz: ${from}. Nowy termin: ${to}.${clash} Czy mam przenieść?`;
      return `I will move “${quote(preview.title)}”. Now: ${from}. New time: ${to}.${clash} Shall I move it?`;
    }
    case "cancel_calendar_event": {
      const when = preview.when ? ` ${spokenSlot(preview.when, preview.timeZone, lang)}` : "";
      const others = preview.attendeeCount
        ? (lang === "cs" ? " Ostatní účastníci upozorněni nebudou." : lang === "pl" ? " Pozostali uczestnicy nie zostaną powiadomieni." : " The other attendees will not be notified.")
        : "";
      if (lang === "cs") return `Zruším „${quote(preview.title)}“${when}.${others} Mám ji zrušit?`;
      if (lang === "pl") return `Odwołam „${quote(preview.title)}”${when}.${others} Czy mam odwołać?`;
      return `I will cancel “${quote(preview.title)}”${when}.${others} Shall I cancel it?`;
    }
    default:
      return undefined;
  }
}

/** What is said after the yes was carried out. */
export function spokenOutcome(action: string | undefined, data: Row | undefined, language: string): string | undefined {
  const lang = locale(language);
  switch (action) {
    case "resolve_communication_intakes": {
      const count = Number(data?.resolved) || 0;
      if (count === 0) {
        const where = messagesOn(0, data?.channel, lang).replace(/^0 \S+ /, "");
        return lang === "cs" ? `Žádná nevyřízená zpráva ${where} není.` : lang === "pl" ? `Brak niezałatwionych wiadomości ${where}.` : `There are no unresolved messages ${where}.`;
      }
      const what = messagesOn(count, data?.channel, lang);
      return lang === "cs" ? `Hotovo, jako vyřízené jsem označil ${what}.` : lang === "pl" ? `Gotowe, jako załatwione oznaczyłem ${what}.` : `Done: I marked ${what} as resolved.`;
    }
    case "reply_whatsapp":
    case "send_whatsapp":
      return lang === "cs" ? "Zpráva je odeslaná." : lang === "pl" ? "Wiadomość została wysłana." : "The message has been sent.";
    case "send_email":
    case "reply_email":
      return lang === "cs" ? "E-mail je odeslaný." : lang === "pl" ? "E-mail został wysłany." : "The email has been sent.";
    case "update_task": {
      // The task service answers with the task and any capacity warning beside it.
      const title = data?.task?.title ?? data?.title;
      return lang === "cs" ? `Úkol „${quote(title)}“ je upravený.` : lang === "pl" ? `Zadanie „${quote(title)}” zostało zmienione.` : `The task “${quote(title)}” has been updated.`;
    }
    case "update_service":
      return lang === "cs" ? `Služba „${quote(data?.name)}“ je upravená.` : lang === "pl" ? `Usługa „${quote(data?.name)}” została zmieniona.` : `The service “${quote(data?.name)}” has been updated.`;
    case "update_invoice":
      return lang === "cs" ? `Faktura ${quote(data?.invoiceNumber)} je upravená.` : lang === "pl" ? `Faktura ${quote(data?.invoiceNumber)} została zmieniona.` : `The invoice ${quote(data?.invoiceNumber)} has been updated.`;
    case "update_document":
      return lang === "cs" ? `Dokument „${quote(data?.title)}“ je upravený.` : lang === "pl" ? `Dokument „${quote(data?.title)}” został zmieniony.` : `The document “${quote(data?.title)}” has been updated.`;
    case "update_business_context":
      return lang === "cs" ? `Položka „${quote(data?.label)}“ je upravená.` : lang === "pl" ? `Pozycja „${quote(data?.label)}” została zmieniona.` : `“${quote(data?.label)}” has been updated.`;
    case "update_industry":
      return lang === "cs" ? `Odvětví „${quote(data?.name)}“ je upravené.` : lang === "pl" ? `Branża „${quote(data?.name)}” została zmieniona.` : `The industry “${quote(data?.name)}” has been updated.`;
    case "set_notification_digest": {
      if (!data?.enabled) return lang === "cs" ? "Denní souhrn je vypnutý." : lang === "pl" ? "Codzienne podsumowanie jest wyłączone." : "The daily summary is off.";
      // The stored UTC hour said as today's UK clock time.
      const today = new Date();
      const local = typeof data.hourUtc === "number"
        ? localDateTime(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), data.hourUtc)), BUSINESS_TIME_ZONE).time
        : "";
      return lang === "cs" ? `Denní souhrn je zapnutý${local ? `, chodí v ${local}` : ""}.` : lang === "pl" ? `Codzienne podsumowanie jest włączone${local ? `, przychodzi o ${local}` : ""}.` : `The daily summary is on${local ? `, sent at ${local}` : ""}.`;
    }
    case "send_notification_digest":
      return lang === "cs" ? "Souhrn je odeslaný." : lang === "pl" ? "Podsumowanie zostało wysłane." : "The summary has been sent.";
    case "clear_voice_history":
      if (!Number(data?.conversations) && !Number(data?.pendingEmails)) {
        return lang === "cs" ? "Žádné uložené rozhovory nemám, není co mazat." : lang === "pl" ? "Nie mam zapisanych rozmów, nie ma czego usuwać." : "There are no saved conversations to delete.";
      }
      return lang === "cs" ? "Historie rozhovorů je smazaná." : lang === "pl" ? "Historia rozmów została usunięta." : "Your conversation history has been deleted.";
    case "remove_voice_alias":
      return lang === "cs" ? `Slovo „${quote(data?.term)}“ jsem zapomněl.` : lang === "pl" ? `Zapomniałem słowo „${quote(data?.term)}”.` : `I have forgotten “${quote(data?.term)}”.`;
    case "send_quote":
      return lang === "cs" ? "Nabídka je odeslaná." : lang === "pl" ? "Oferta została wysłana." : "The quote has been sent.";
    case "send_invoice":
      return lang === "cs" ? "Faktura je odeslaná." : lang === "pl" ? "Faktura została wysłana." : "The invoice has been sent.";
    case "create_calendar_event":
      if (data?.alreadyCreated) return lang === "cs" ? "Tahle událost už v kalendáři je, druhou jsem nezapsal." : lang === "pl" ? "To wydarzenie już jest w kalendarzu, drugiego nie dodałem." : "That event is already in the calendar; I did not add a second one.";
      return lang === "cs" ? "Zapsáno do kalendáře." : lang === "pl" ? "Zapisane w kalendarzu." : "It is in the calendar.";
    case "move_calendar_event":
      return lang === "cs" ? "Událost je přesunutá." : lang === "pl" ? "Wydarzenie zostało przeniesione." : "The event has been moved.";
    case "cancel_calendar_event":
      return lang === "cs" ? "Událost je zrušená." : lang === "pl" ? "Wydarzenie zostało odwołane." : "The event has been cancelled.";
    case "set_default_email_account": {
      const account = data?.accountEmail || data?.displayName;
      if (!account) return undefined;
      return lang === "cs" ? `E-maily teď budu posílat z účtu ${account}, pokud neřeknete jiný.` : lang === "pl" ? `E-maile będę teraz wysyłać z konta ${account}, chyba że wskażesz inne.` : `Email will now go from ${account} unless you name another account.`;
    }
    default:
      return undefined;
  }
}

/** Plain-language refusals for the errors these actions return; undefined keeps the service's own text. */
export function spokenError(error: string | undefined, extra: Row | undefined, language: string): string | undefined {
  const lang = locale(language);
  const candidates = Array.isArray(extra?.candidates) ? (extra!.candidates as string[]).slice(0, 4).join(", ") : "";
  const accounts = Array.isArray(extra?.accounts) ? (extra!.accounts as string[]).slice(0, 4).join(", ") : "";
  const messages: Record<string, Record<Locale, string>> = {
    // Nothing leaves untranslated: a message promised in another language is
    // not sent as dictated. Worded for any target, English or one named.
    TRANSLATION_FAILED: {
      cs: "Zprávu se teď nepodařilo přeložit, takže jsem nic nepřipravil ani neodeslal. Zkuste to prosím znovu.",
      pl: "Nie udało się teraz przetłumaczyć wiadomości, więc niczego nie przygotowałem ani nie wysłałem. Spróbuj ponownie.",
      en: "The message could not be translated just now, so nothing was prepared or sent. Please try again.",
    },
    TRANSLATION_NOT_CONFIGURED: {
      cs: "Překlad není nastavený, takže zprávu přeložit nemůžu a nic jsem neodeslal.",
      pl: "Tłumaczenie nie jest skonfigurowane, więc nie mogę przetłumaczyć wiadomości i niczego nie wysłałem.",
      en: "Translation is not set up, so I cannot translate the message, and nothing was sent.",
    },
    WHATSAPP_REPLY_WINDOW_CLOSED: {
      cs: "Tenhle zákazník psal před víc než 24 hodinami. WhatsApp teď dovolí jen schválenou šablonu a tu zatím neposílám. Zavolejte mu nebo pošlete e-mail.",
      pl: "Ten klient pisał ponad 24 godziny temu. WhatsApp pozwala teraz tylko na zatwierdzony szablon, którego jeszcze nie wysyłam. Zadzwoń lub wyślij e-mail.",
      en: "This customer last wrote more than 24 hours ago. WhatsApp now allows only an approved template, which I do not send yet. Call or email them instead.",
    },
    EMAIL_SENDER_ADDRESS_INVALID: {
      cs: "Adresa odesílatele u tohoto e-mailu není jedna platná adresa, takže na něj odsud neodpovím. Odpovězte prosím přímo v Gmailu.",
      pl: "Adres nadawcy tego e-maila nie jest jednym poprawnym adresem, więc nie odpowiem stąd. Odpowiedz bezpośrednio w Gmailu.",
      en: "The sender's address on this email is not one valid address, so I will not reply to it from here. Please reply in Gmail.",
    },
    EMAIL_THREAD_UNAVAILABLE: {
      cs: "Původní e-mail už nejde přečíst, takže by odpověď přišla jako nový e-mail, ne jako odpověď. Odpovězte prosím přímo v Gmailu.",
      pl: "Oryginalnego e-maila nie da się już odczytać, więc odpowiedź dotarłaby jako nowy e-mail, a nie jako odpowiedź. Odpowiedz bezpośrednio w Gmailu.",
      en: "The original email can no longer be read, so the reply would arrive as a new email rather than an answer. Please reply in Gmail.",
    },
    EMAIL_MESSAGE_NOT_FOUND: {
      cs: "Takový přijatý e-mail jsem nenašel.",
      pl: "Nie znalazłem takiego odebranego e-maila.",
      en: "I could not find that received email.",
    },
    WHATSAPP_MESSAGE_NOT_FOUND: {
      cs: "Takovou přijatou WhatsApp zprávu jsem nenašel.",
      pl: "Nie znalazłem takiej odebranej wiadomości WhatsApp.",
      en: "I could not find that received WhatsApp message.",
    },
    RECORD_NOT_FOUND: {
      cs: `Nenašel jsem ${recordWord(extra?.kind, "cs") ?? "záznam"}${extra?.said ? ` „${extra.said}“` : ""}.`,
      pl: `Nie znalazłem: ${recordWord(extra?.kind, "pl") ?? "rekord"}${extra?.said ? ` „${extra.said}”` : ""}.`,
      en: `I could not find ${recordWord(extra?.kind, "en") ? `a ${recordWord(extra?.kind, "en")}` : "it"}${extra?.said ? ` called “${extra.said}”` : ""}.`,
    },
    INVOICE_NOT_EDITABLE: {
      cs: "Upravit jde jen koncept faktury. Vystavenou fakturu je potřeba stornovat a vystavit novou.",
      pl: "Edytować można tylko szkic faktury. Wystawioną fakturę trzeba anulować i wystawić nową.",
      en: "Only a draft invoice can be changed. An issued invoice has to be voided and replaced.",
    },
    DIGEST_DISABLED: {
      cs: "Denní souhrn máte vypnutý. Řekněte „zapni denní souhrn“.",
      pl: "Codzienne podsumowanie jest wyłączone. Powiedz „włącz codzienne podsumowanie”.",
      en: "Your daily summary is off. Say “turn on the daily summary” first.",
    },
    DIGEST_EMPTY: {
      cs: "Teď nic nevyžaduje pozornost, souhrn by byl prázdný.",
      pl: "Teraz nic nie wymaga uwagi, podsumowanie byłoby puste.",
      en: "Nothing needs attention right now, so the summary would be empty.",
    },
    RECIPIENT_REQUIRED: {
      cs: "Klient nemá uložený e-mail. Řekněte adresu, nebo ji doplňte u klienta.",
      pl: "Klient nie ma zapisanego adresu e-mail. Podaj adres albo uzupełnij go u klienta.",
      en: "The client has no stored email address. Say the address, or add it to the client.",
    },
    INVOICE_NOT_ISSUED: {
      cs: "Faktura je zatím koncept. Poslat jde až vystavená faktura, nejdřív ji vystavte.",
      pl: "Faktura jest jeszcze szkicem. Wysłać można tylko wystawioną fakturę, najpierw ją wystaw.",
      en: "The invoice is still a draft. Only an issued invoice can be sent; issue it first.",
    },
    GMAIL_NOT_CONFIGURED: {
      cs: "Gmail pro odesílání není připojený. Připojte ho v Konektorech.",
      pl: "Gmail do wysyłania nie jest podłączony. Podłącz go w Konektorach.",
      en: "No Gmail account is connected for sending. Connect one in Connectors.",
    },
    CONNECTOR_AUTHORIZATION_REQUIRED: {
      cs: "Gmail potřebuje znovu autorizovat. V Konektorech klikněte na Znovu autorizovat.",
      pl: "Gmail wymaga ponownej autoryzacji. W Konektorach kliknij Autoryzuj ponownie.",
      en: "Gmail needs to be authorised again. Use Reauthorise in Connectors.",
    },
    CONNECTOR_SCOPE_REQUIRED: {
      cs: "Účet Gmail nemá povolené odesílání. Povolte ho v Konektorech.",
      pl: "Konto Gmail nie ma uprawnienia do wysyłania. Włącz je w Konektorach.",
      en: "The Gmail account is not allowed to send. Enable sending in Connectors.",
    },
    CONNECTOR_NOT_ENABLED: {
      cs: "Konektor je vypnutý. Zapněte ho v Konektorech.",
      pl: "Konektor jest wyłączony. Włącz go w Konektorach.",
      en: "The connector is switched off. Switch it on in Connectors.",
    },
    AMBIGUOUS_REFERENCE: {
      cs: `Na to sedí víc možností${candidates ? `: ${candidates}` : ""}. Řekněte prosím přesněji, kterou myslíte.`,
      pl: `Pasuje kilka możliwości${candidates ? `: ${candidates}` : ""}. Powiedz dokładniej, o którą chodzi.`,
      en: `More than one matches${candidates ? `: ${candidates}` : ""}. Please say which one you mean.`,
    },
    GMAIL_ACCOUNT_NOT_FOUND: {
      cs: `Takový e-mailový účet připojený nemám.${accounts ? ` Připojené jsou: ${accounts}.` : ""} Řekněte, ze kterého mám poslat.`,
      pl: `Nie mam podłączonego takiego konta e-mail.${accounts ? ` Podłączone są: ${accounts}.` : ""} Powiedz, z którego mam wysłać.`,
      en: `No connected email account matches that.${accounts ? ` Connected: ${accounts}.` : ""} Say which one to send from.`,
    },
    AMBIGUOUS_GMAIL_SOURCE: {
      cs: `Mám připojených víc e-mailových účtů${accounts ? `: ${accounts}` : ""}. Řekněte, ze kterého mám poslat, nebo v Konektorech nastavte výchozí účet pro odesílání.`,
      pl: `Mam podłączonych kilka kont e-mail${accounts ? `: ${accounts}` : ""}. Powiedz, z którego mam wysłać, albo ustaw konto domyślne w Konektorach.`,
      en: `More than one email account is connected${accounts ? `: ${accounts}` : ""}. Say which one to send from, or choose a default sender on the Connectors page.`,
    },
    CALENDAR_WRITE_NOT_AUTHORIZED: {
      cs: "Kalendář je zatím připojený jen pro čtení. V Konektorech zvolte Povolit zápis do kalendáře a potvrďte to u Googlu.",
      pl: "Kalendarz jest na razie podłączony tylko do odczytu. W Konektorach wybierz Zezwól na zapis w kalendarzu i potwierdź to w Google.",
      en: "The calendar is connected read-only. On the Connectors page choose Allow calendar writing and approve it at Google.",
    },
    GOOGLE_CALENDAR_NOT_CONFIGURED: {
      cs: "Google kalendář není připojený a zapnutý.",
      pl: "Kalendarz Google nie jest podłączony i włączony.",
      en: "Google Calendar is not connected and enabled.",
    },
    CALENDAR_DATE_NOT_UNDERSTOOD: {
      cs: "Tomu datu jsem nerozuměl. Řekněte třeba zítra, v pátek nebo šestého října.",
      pl: "Nie zrozumiałem tej daty. Powiedz na przykład jutro, w piątek albo szóstego października.",
      en: "I did not understand that date. Say for example tomorrow, Friday or 6 October.",
    },
    CALENDAR_TIME_NOT_UNDERSTOOD: {
      cs: "Tomu času jsem nerozuměl. Řekněte ho prosím znovu, třeba v osm nebo ve čtrnáct třicet.",
      pl: "Nie zrozumiałem tej godziny. Powiedz ją jeszcze raz, na przykład o ósmej albo o czternastej trzydzieści.",
      en: "I did not understand that time. Please say it again, for example 8:00 or 14:30.",
    },
    CALENDAR_DATE_IN_PAST: {
      cs: "Ten den už je minulý, nic jsem nezapsal.",
      pl: "Ten dzień już minął, nic nie zapisałem.",
      en: "That day is in the past, so nothing was written.",
    },
    CALENDAR_EVENT_NOT_FOUND: {
      cs: "Takovou událost v kalendáři jsem nenašel.",
      pl: "Nie znalazłem takiego wydarzenia w kalendarzu.",
      en: "I could not find that event in the calendar.",
    },
    CALENDAR_RECURRING_NOT_SUPPORTED: {
      cs: "Tahle událost se opakuje. Změnil bych celou řadu, a to zatím nedělám. Upravte ji prosím přímo v Google kalendáři.",
      pl: "To wydarzenie się powtarza. Zmieniłbym całą serię, czego jeszcze nie robię. Zmień je bezpośrednio w Kalendarzu Google.",
      en: "This event repeats. Changing it would change the whole series, which I do not do yet. Please change it in Google Calendar.",
    },
    CALENDAR_EVENT_CHANGED: {
      cs: "Událost se mezitím v Google kalendáři změnila, takže jsem ji nechal být. Řekněte to prosím znovu.",
      pl: "Wydarzenie zmieniło się w międzyczasie w Kalendarzu Google, więc go nie ruszyłem. Powiedz to jeszcze raz.",
      en: "The event changed in Google Calendar after you reviewed it, so I left it alone. Please ask again.",
    },
    CALENDAR_SYNC_REQUIRED: {
      cs: "Kalendář se ještě nesynchronizoval. Zkuste to prosím za chvíli.",
      pl: "Kalendarz jeszcze się nie zsynchronizował. Spróbuj za chwilę.",
      en: "The calendar has not synchronised yet. Please try again shortly.",
    },
  };
  return error ? messages[error]?.[lang] : undefined;
}

export function spokenCancelled(language: string) {
  const lang = locale(language);
  return lang === "cs" ? "Zrušeno, nic se neprovedlo." : lang === "pl" ? "Anulowane, nic nie zostało wykonane." : "Cancelled; nothing was done.";
}

export function spokenCompleted(language: string) {
  const lang = locale(language);
  return lang === "cs" ? "Hotovo." : lang === "pl" ? "Gotowe." : "The reviewed action was completed.";
}

function ago(at: Date, now: Date, lang: Locale) {
  const minutes = Math.max(0, Math.round((now.getTime() - at.getTime()) / 60_000));
  if (minutes < 60) return lang === "cs" ? "před chvílí" : lang === "pl" ? "przed chwilą" : "just now";
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    if (lang === "cs") return hours === 1 ? "před hodinou" : `před ${hours} hodinami`;
    if (lang === "pl") return hours === 1 ? "godzinę temu" : `${hours} ${hours % 10 >= 2 && hours % 10 <= 4 && (hours < 12 || hours > 14) ? "godziny" : "godzin"} temu`;
    return hours === 1 ? "an hour ago" : `${hours} hours ago`;
  }
  const days = Math.round(hours / 24);
  if (lang === "cs") return days === 1 ? "včera" : `před ${days} dny`;
  if (lang === "pl") return days === 1 ? "wczoraj" : `${days} dni temu`;
  return days === 1 ? "yesterday" : `${days} days ago`;
}

function capitalised(text: string) {
  return text.charAt(0).toLocaleUpperCase() + text.slice(1);
}

/** Czech has three plural forms (1, 2–4, 5+); Polish keys on the last digit and 12–14. */
function counted(count: number, lang: Locale, forms: { cs: [string, string, string]; pl: [string, string, string]; en: [string, string] }) {
  if (lang === "en") return `${count} ${count === 1 ? forms.en[0] : forms.en[1]}`;
  if (count === 1) return `${count} ${forms[lang][0]}`;
  const few = lang === "cs" ? count >= 2 && count <= 4 : count % 10 >= 2 && count % 10 <= 4 && (count % 100 < 12 || count % 100 > 14);
  return `${count} ${few ? forms[lang][1] : forms[lang][2]}`;
}

// After "celkem" / "razem": the accusative ("1 rozhovor", "1 rozmowę").
const CONVERSATIONS = { cs: ["rozhovor", "rozhovory", "rozhovorů"], pl: ["rozmowę", "rozmowy", "rozmów"], en: ["conversation", "conversations"] } as { cs: [string, string, string]; pl: [string, string, string]; en: [string, string] };
const MESSAGES = { cs: ["zpráva", "zprávy", "zpráv"], pl: ["wiadomość", "wiadomości", "wiadomości"], en: ["message", "messages"] } as { cs: [string, string, string]; pl: [string, string, string]; en: [string, string] };
const OLDER = { cs: ["starší zpráva", "starší zprávy", "starších zpráv"], pl: ["starsza wiadomość", "starsze wiadomości", "starszych wiadomości"], en: ["older message", "older messages"] } as { cs: [string, string, string]; pl: [string, string, string]; en: [string, string] };
const SENDERS = { cs: ["odesílatele", "odesílatelů", "odesílatelů"], pl: ["nadawcy", "nadawców", "nadawców"], en: ["sender", "senders"] } as { cs: [string, string, string]; pl: [string, string, string]; en: [string, string] };

/** "a, b a c" / "a, b i c" / "a, b and c". */
function spokenList(items: string[], lang: Locale) {
  if (items.length <= 1) return items.join("");
  const and = lang === "cs" ? " a " : lang === "pl" ? " i " : " and ";
  return `${items.slice(0, -1).join(", ")}${and}${items[items.length - 1]}`;
}

/** How many senders the first answer names before it only counts the rest. */
const SENDERS_NAMED = 5;

/**
 * One answer of a reading of received messages: on the first, who has written
 * and how much; then one sender's newest few messages — when, what, and
 * whether they were answered — how many older ones remain, and who is next.
 * Only what the reading returned is said.
 */
export function spokenReadingTurn(turn: ReadingTurn, language: string, now = new Date()): string {
  const lang = locale(language);
  const whatsapp = turn.channel === "whatsapp";
  const parts: string[] = [];
  const overview = turn.overview;

  if (overview && !overview.senders.length) {
    return lang === "cs" ? `${whatsapp ? "Na WhatsAppu" : "V e-mailu"} nejsou žádné přijaté zprávy.`
      : lang === "pl" ? `Brak odebranych wiadomości ${whatsapp ? "na WhatsAppie" : "e-mail"}.`
        : `There are no received ${whatsapp ? "WhatsApp" : "email"} messages.`;
  }
  if (overview && overview.senders.length > 1) {
    const named = overview.senders.slice(0, SENDERS_NAMED).map((entry) => `${entry.sender} ${counted(entry.count, lang, MESSAGES)}`);
    const rest = overview.senders.length - named.length;
    if (rest > 0) {
      named.push(lang === "cs" ? (rest === 1 ? "jeden další" : rest <= 4 ? `${rest} další` : `${rest} dalších`)
        : lang === "pl" ? (rest === 1 ? "jeszcze jeden nadawca" : `jeszcze ${rest} innych nadawców`)
          : `${rest} more`);
    }
    const from = counted(overview.senders.length, lang, SENDERS);
    parts.push(lang === "cs" ? `${whatsapp ? "Na WhatsAppu" : "V e-mailu"} máte zprávy od ${from}: ${spokenList(named, lang)}.`
      : lang === "pl" ? `${whatsapp ? "Na WhatsAppie" : "W poczcie e-mail"} masz wiadomości od ${from}: ${spokenList(named, lang)}.`
        : `${whatsapp ? "WhatsApp" : "Email"} messages from ${from}: ${spokenList(named, lang)}.`);
  }
  if (overview && whatsapp && overview.unansweredToday) {
    parts.push(lang === "cs" ? `Za posledních 24 hodin zůstává bez odpovědi ${overview.unansweredToday}.`
      : lang === "pl" ? `W ciągu ostatnich 24 godzin bez odpowiedzi: ${overview.unansweredToday}.`
        : `${overview.unansweredToday} from the last 24 hours are not answered.`);
  }

  const sender = turn.sender;
  if (sender) {
    if (sender.alreadyRead > 0 && !sender.messages.length) {
      parts.push(lang === "cs" ? "Starší zprávy od tohoto odesílatele už nejsou."
        : lang === "pl" ? "Starszych wiadomości od tego nadawcy już nie ma."
          : "There are no older messages from this sender.");
    } else {
      // The count is already in the overview when it named several senders.
      const counts = sender.alreadyRead === 0 && sender.total > 1 && !(overview && overview.senders.length > 1);
      parts.push(sender.alreadyRead > 0
        ? (lang === "cs" ? `${sender.name}, starší zprávy.` : lang === "pl" ? `${sender.name}, starsze wiadomości.` : `${sender.name}, older messages.`)
        : counts ? `${sender.name}, ${counted(sender.total, lang, MESSAGES)}.` : `${sender.name}.`);
      for (const message of sender.messages) {
        const answered = message.replied === undefined ? ""
          : message.replied ? (lang === "cs" ? " Odpovězeno." : lang === "pl" ? " Odpowiedziano." : " Answered.")
            : (lang === "cs" ? " Bez odpovědi." : lang === "pl" ? " Bez odpowiedzi." : " Not answered.");
        parts.push(`${capitalised(ago(message.receivedAt, now, lang))}: „${quote(message.text, 200)}“.${answered}`);
      }
      if (sender.olderLeft > 0) {
        const older = counted(sender.olderLeft, lang, OLDER);
        parts.push(lang === "cs" ? `Ještě ${older}.` : lang === "pl" ? `Jeszcze ${older}.` : `${older} left.`);
      }
    }
  } else if (!overview) {
    parts.push(lang === "cs" ? "Další odesílatel už není." : lang === "pl" ? "Następnego nadawcy już nie ma." : "There is no next sender.");
  }

  if (turn.next) {
    parts.push(lang === "cs" ? `Další je ${turn.next.sender}.` : lang === "pl" ? `Następny nadawca: ${turn.next.sender}.` : `Next is ${turn.next.sender}.`);
  }
  if (overview && (turn.next || sender?.olderLeft)) {
    const skip = turn.next ? (lang === "cs" ? "„přeskoč“ pro dalšího odesílatele" : lang === "pl" ? "„pomiń” dla następnego nadawcy" : "“skip” for the next sender") : "";
    const older = sender?.olderLeft ? (lang === "cs" ? "„starší“ pro starší zprávy" : lang === "pl" ? "„starsze” dla starszych wiadomości" : "“older” for older messages") : "";
    const or = lang === "cs" ? ", nebo " : lang === "pl" ? " albo " : ", or ";
    parts.push(`${lang === "cs" ? "Řekněte" : lang === "pl" ? "Powiedz" : "Say"} ${[skip, older].filter(Boolean).join(or)}.`);
  }
  if (turn.done) parts.push(lang === "cs" ? "To jsou všechny zprávy." : lang === "pl" ? "To wszystkie wiadomości." : "Those are all the messages.");
  if (overview) {
    parts.push(whatsapp
      ? (lang === "cs" ? "Odpovědět můžete třeba: odpověz Honzovi, že…" : lang === "pl" ? "Możesz odpowiedzieć na przykład: odpowiedz Janowi, że…" : "You can reply, for example: reply to John that…")
      : (lang === "cs" ? "Odpovědět můžete třeba: odpověz Honzovi na e-mail, že…" : lang === "pl" ? "Możesz odpowiedzieć na przykład: odpowiedz Janowi na e-mail, że…" : "You can reply, for example: reply to John's email that…"));
  }
  return parts.join(" ");
}

/** A WhatsApp message to a number that is not a full international one, or with no text. */
export function spokenWhatsAppDetailsMissing(language: string) {
  const lang = locale(language);
  return lang === "cs" ? "Potřebuji celé mezinárodní číslo i s předvolbou, například plus čtyři čtyři, a text zprávy."
    : lang === "pl" ? "Potrzebuję pełnego numeru międzynarodowego z kierunkowym, na przykład plus czterdzieści cztery, i treści wiadomości."
      : "I need the full international number with its country code, for example plus four four, and the message text.";
}

/** "Přeskoč" with nothing being read: say so, and how to start. */
export function spokenNothingBeingRead(language: string) {
  const lang = locale(language);
  return lang === "cs" ? "Teď vám žádné zprávy nečtu. Řekněte třeba: přečti zprávy na WhatsAppu."
    : lang === "pl" ? "Teraz nie czytam żadnych wiadomości. Powiedz na przykład: przeczytaj wiadomości z WhatsAppa."
      : "I am not reading any messages right now. Say, for example: read my WhatsApp messages.";
}

/** How a record of each kind is named after "Otevírám" / "Otwieram" / "Opening", and after "Nenašel jsem". */
const RECORD_WORDS: Record<RecordKind, Record<Locale, string>> = {
  client: { cs: "klienta", pl: "klienta", en: "client" },
  contact: { cs: "kontakt", pl: "kontakt", en: "contact" },
  lead: { cs: "poptávku", pl: "zapytanie", en: "lead" },
  job: { cs: "zakázku", pl: "zlecenie", en: "job" },
  quote: { cs: "nabídku", pl: "ofertę", en: "quote" },
  invoice: { cs: "fakturu", pl: "fakturę", en: "invoice" },
  employee: { cs: "zaměstnance", pl: "pracownika", en: "employee" },
  job_opening: { cs: "inzerát", pl: "ogłoszenie", en: "job opening" },
  playbook: { cs: "playbook", pl: "playbook", en: "playbook" },
};

/**
 * "otevři klienta Nováka": which record is being opened, that none was found,
 * or which ones fit equally well, so the user can say which.
 */
export function spokenOpenRecord(
  outcome: { opened?: { kind: RecordKind; label: string }; kind: RecordKind; said: string; error?: string; candidates?: string[]; more?: number },
  language: string,
): string {
  const lang = locale(language);
  const what = RECORD_WORDS[outcome.kind][lang];
  if (outcome.opened) {
    return lang === "cs" ? `Otevírám ${what} ${outcome.opened.label}.`
      : lang === "pl" ? `Otwieram ${what} ${outcome.opened.label}.`
        : `Opening the ${what} ${outcome.opened.label}.`;
  }
  if (outcome.error === "AMBIGUOUS_REFERENCE" && outcome.candidates?.length) {
    const named = [...outcome.candidates];
    if (outcome.more) named.push(lang === "cs" ? `${outcome.more} další` : lang === "pl" ? `${outcome.more} innych` : `${outcome.more} more`);
    const list = spokenList(named, lang);
    return lang === "cs" ? `Tomu odpovídá víc záznamů: ${list}. Řekněte to přesněji.`
      : lang === "pl" ? `Pasuje kilka pozycji: ${list}. Proszę powiedzieć dokładniej.`
        : `More than one matches: ${list}. Which one do you mean?`;
  }
  if (outcome.error === "MISSING_PERMISSION") {
    return lang === "cs" ? `K otevření tohoto záznamu nemáte oprávnění.`
      : lang === "pl" ? `Nie masz uprawnień do otwarcia tego rekordu.`
        : `You do not have permission to open this record.`;
  }
  return lang === "cs" ? `Nenašel jsem ${what} „${outcome.said}“.`
    : lang === "pl" ? `Nie znalazłem: ${what} „${outcome.said}”.`
      : `I could not find a ${what} called “${outcome.said}”.`;
}

/** Other things looked up by name, said after "Nenašel jsem". */
const OTHER_WORDS: Record<string, Record<Locale, string>> = {
  task: { cs: "úkol", pl: "zadanie", en: "task" },
  service: { cs: "službu", pl: "usługę", en: "service" },
  document: { cs: "dokument", pl: "dokument", en: "document" },
  business_context: { cs: "položku", pl: "pozycję", en: "business context item" },
  industry: { cs: "odvětví", pl: "branżę", en: "industry" },
  voice_alias: { cs: "naučené slovo", pl: "nauczone słowo", en: "learned word" },
};

function recordWord(kind: unknown, lang: Locale): string | undefined {
  if (typeof kind !== "string") return undefined;
  if (kind in RECORD_WORDS) return RECORD_WORDS[kind as RecordKind][lang];
  return OTHER_WORDS[kind]?.[lang];
}

const CHANGE_LABELS: Record<string, Record<Locale, string>> = {
  name: { cs: "název", pl: "nazwa", en: "name" },
  title: { cs: "název", pl: "tytuł", en: "title" },
  description: { cs: "popis", pl: "opis", en: "description" },
  category: { cs: "kategorie", pl: "kategoria", en: "category" },
  price_min: { cs: "cena od", pl: "cena od", en: "price from" },
  price_max: { cs: "cena do", pl: "cena do", en: "price up to" },
  price_unit: { cs: "jednotka ceny", pl: "jednostka ceny", en: "price unit" },
  duration_hours: { cs: "obvyklá délka v hodinách", pl: "zwykły czas w godzinach", en: "usual length in hours" },
  invoice_number: { cs: "číslo", pl: "numer", en: "number" },
  due_date: { cs: "splatnost", pl: "termin płatności", en: "due date" },
  notes: { cs: "poznámka", pl: "uwagi", en: "notes" },
};

/** "cena od 500,00 £, splatnost 16. 10. 2026" — each change as it will be saved. */
function spokenChanges(changes: unknown, lang: Locale): string {
  if (!changes || typeof changes !== "object") return "";
  const locale = lang === "cs" ? "cs-CZ" : lang === "pl" ? "pl-PL" : "en-GB";
  const parts = Object.entries(changes as Record<string, unknown>).map(([key, value]) => {
    const label = CHANGE_LABELS[key]?.[lang] ?? key;
    let said = String(value);
    if ((key === "price_min" || key === "price_max") && typeof value === "number") {
      said = new Intl.NumberFormat(locale, { style: "currency", currency: "GBP" }).format(value);
    } else if (key === "due_date" && typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
      said = new Intl.DateTimeFormat(locale, { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`));
    } else {
      said = lang === "en" ? `“${quote(value)}”` : lang === "pl" ? `„${quote(value)}”` : `„${quote(value)}“`;
    }
    return `${label} ${said}`;
  });
  return spokenList(parts, lang);
}

type Forms = { cs: [string, string, string]; pl: [string, string, string]; en: [string, string] };
// After "Máte" / "Masz": the accusative ("Máte 1 klienta, 4 klienty, 5 klientů").
const CLIENTS: Forms = { cs: ["klienta", "klienty", "klientů"], pl: ["klienta", "klientów", "klientów"], en: ["client", "clients"] };
const CONTACTS: Forms = { cs: ["kontakt", "kontakty", "kontaktů"], pl: ["kontakt", "kontakty", "kontaktów"], en: ["contact", "contacts"] };
const JOBS: Forms = { cs: ["zakázku", "zakázky", "zakázek"], pl: ["zlecenie", "zlecenia", "zleceń"], en: ["job", "jobs"] };
const TASKS: Forms = { cs: ["otevřený úkol", "otevřené úkoly", "otevřených úkolů"], pl: ["otwarte zadanie", "otwarte zadania", "otwartych zadań"], en: ["open task", "open tasks"] };
const QUOTES: Forms = { cs: ["nabídku", "nabídky", "nabídek"], pl: ["ofertę", "oferty", "ofert"], en: ["quote", "quotes"] };
const LEADS: Forms = { cs: ["poptávku", "poptávky", "poptávek"], pl: ["zapytanie", "zapytania", "zapytań"], en: ["lead", "leads"] };
const OPENINGS: Forms = { cs: ["otevřený inzerát", "otevřené inzeráty", "otevřených inzerátů"], pl: ["otwarte ogłoszenie", "otwarte ogłoszenia", "otwartych ogłoszeń"], en: ["open job opening", "open job openings"] };

/** Newest first, by when the record was created. */
function newestFirst(rows: Row[]): Row[] {
  return [...rows].sort((left, right) => new Date(right?.createdAt ?? 0).getTime() - new Date(left?.createdAt ?? 0).getTime());
}

/** How many are said by name after the count. */
const NAMED_IN_SUMMARY = 3;

/**
 * What a list page shows, said in two short sentences when it is opened by
 * voice ("ukaž zakázky"): how many, and the newest few by name. Counted from
 * the rows the command read, nothing else. Undefined for a command that is no
 * list, so the page is only announced as before.
 */
export function spokenListSummary(intent: string, data: unknown, language: string, now = new Date()): string | undefined {
  if (!Array.isArray(data)) return undefined;
  const lang = locale(language);
  const rows = data as Row[];
  const newest = (filter: (row: Row) => boolean, name: (row: Row) => string) =>
    spokenList(newestFirst(rows.filter(filter)).slice(0, NAMED_IN_SUMMARY).map(name).filter(Boolean), lang);
  const latestSentence = (names: string) => names
    ? (lang === "cs" ? ` Nejnovější: ${names}.` : lang === "pl" ? ` Najnowsze: ${names}.` : ` Newest: ${names}.`)
    : "";
  const youHave = (what: string) => lang === "cs" ? `Máte ${what}.` : lang === "pl" ? `Masz ${what}.` : `You have ${what}.`;
  switch (intent) {
    case "list_clients":
      return youHave(counted(rows.length, lang, CLIENTS)) + latestSentence(newest(() => true, (row) => String(row.displayName ?? "")));
    case "list_contacts":
      return youHave(counted(rows.length, lang, CONTACTS));
    case "list_jobs": {
      const open = (row: Row) => row.jobStatus !== "dokonceno" && row.jobStatus !== "zruseno";
      const openCount = rows.filter(open).length;
      const inProgress = lang === "cs" ? `, rozpracovaných ${openCount}` : lang === "pl" ? `, w toku ${openCount}` : `, ${openCount} still open`;
      return youHave(counted(rows.length, lang, JOBS) + inProgress)
        + latestSentence(newest(open, (row) => `${row.jobTitle}${row.client?.displayName ? ` (${row.client.displayName})` : ""}`));
    }
    case "list_tasks": {
      const open = rows.filter((row) => row.taskStatus === "open" || row.taskStatus === "in_progress");
      const today = localDateTime(now, BUSINESS_TIME_ZONE).date;
      const due = (row: Row) => row.dueAt ? localDateTime(new Date(row.dueAt), BUSINESS_TIME_ZONE).date : undefined;
      const overdue = open.filter((row) => row.dueAt && new Date(row.dueAt).getTime() < now.getTime() && due(row) !== today).length;
      const dueToday = open.filter((row) => due(row) === today).length;
      const extra = [
        dueToday ? (lang === "cs" ? `na dnešek ${dueToday}` : lang === "pl" ? `na dziś ${dueToday}` : `${dueToday} due today`) : "",
        overdue ? (lang === "cs" ? `po termínu ${overdue}` : lang === "pl" ? `po terminie ${overdue}` : `${overdue} overdue`) : "",
      ].filter(Boolean);
      return youHave(counted(open.length, lang, TASKS) + (extra.length ? `, ${spokenList(extra, lang)}` : ""));
    }
    case "list_quotes": {
      const of = (status: string) => rows.filter((row) => row.quoteStatus === status).length;
      const parts = [
        of("draft") ? (lang === "cs" ? `rozpracovaných ${of("draft")}` : lang === "pl" ? `szkiców ${of("draft")}` : `${of("draft")} draft`) : "",
        of("sent") ? (lang === "cs" ? `odeslaných ${of("sent")}` : lang === "pl" ? `wysłanych ${of("sent")}` : `${of("sent")} sent`) : "",
        of("accepted") ? (lang === "cs" ? `přijatých ${of("accepted")}` : lang === "pl" ? `przyjętych ${of("accepted")}` : `${of("accepted")} accepted`) : "",
      ].filter(Boolean);
      return youHave(counted(rows.length, lang, QUOTES) + (parts.length ? `, ${spokenList(parts, lang)}` : ""));
    }
    case "list_leads": {
      const fresh = rows.filter((row) => row.leadStatus === "new").length;
      const extra = fresh ? (lang === "cs" ? `, nových ${fresh}` : lang === "pl" ? `, nowych ${fresh}` : `, ${fresh} new`) : "";
      return youHave(counted(rows.length, lang, LEADS) + extra) + latestSentence(newest((row) => row.leadStatus === "new", (row) => String(row.name ?? "")));
    }
    case "list_job_openings":
      return youHave(counted(rows.filter((row) => row.openingStatus === "open").length, lang, OPENINGS));
    default:
      return undefined;
  }
}

