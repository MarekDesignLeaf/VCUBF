// What Alfonzo says about a reviewed action, in the user's own language.
//
// A review is only a review if the person hears what will happen. The services
// return the facts (recipient, the exact text that will be sent, the resolved
// day and time, clashes); this module turns them into one spoken sentence in
// Czech, Polish or English and ends with the question the yes answers. It only
// words facts the service returned — nothing is added or guessed here. Other
// languages fall back to English. The assistant is male, so first-person
// Czech and Polish forms are masculine or neutral.

import { addDays, localDateTime } from "./spokenDate.js";

type Locale = "cs" | "pl" | "en";
type Row = Record<string, any>;

function locale(language: string): Locale {
  const code = language.slice(0, 2).toLocaleLowerCase("en");
  return code === "cs" || code === "pl" ? code : "en";
}

function quote(text: unknown, max = 400) {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
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

function spokenSlot(slot: Row | undefined, timeZone: string | undefined, lang: Locale) {
  if (!slot?.date) return "";
  const day = spokenDay(slot.date, timeZone, lang);
  if (slot.allDay) return lang === "cs" ? `na celý den ${day}` : lang === "pl" ? `na cały dzień ${day}` : `all day ${day}`;
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

function clashSentence(clashes: unknown, lang: Locale) {
  if (!Array.isArray(clashes) || !clashes.length) return "";
  const titles = clashes.slice(0, 3).map((clash: Row) => `${clash.title}${clash.start?.time ? ` (${clash.start.time})` : ""}`).join(", ");
  return lang === "cs" ? ` Pozor, v tu dobu už je v kalendáři: ${titles}.`
    : lang === "pl" ? ` Uwaga, w tym czasie w kalendarzu jest już: ${titles}.`
      : ` Note that the calendar already has ${titles} at that time.`;
}

/** The spoken review for an action waiting for a yes, or undefined if this module does not word it. */
export function spokenReview(action: string, preview: Row | undefined, language: string): string | undefined {
  if (!preview) return undefined;
  const lang = locale(language);
  switch (action) {
    case "reply_whatsapp": {
      const who = preview.recipientName || preview.to;
      const how = spokenLanguage(preview.sentIn, lang);
      if (lang === "cs") return `Odpověď pro ${who} na zprávu „${quote(preview.inReplyTo?.text, 160)}“. Pošlu ${how}: „${quote(preview.body)}“. Mám ji odeslat?`;
      if (lang === "pl") return `Odpowiedź dla ${who} na wiadomość „${quote(preview.inReplyTo?.text, 160)}”. Wyślę ${how}: „${quote(preview.body)}”. Czy mam ją wysłać?`;
      return `Reply to ${who} about “${quote(preview.inReplyTo?.text, 160)}”. I will send ${how}: “${quote(preview.body)}”. Shall I send it?`;
    }
    case "send_whatsapp": {
      const how = preview.sentIn ? ` ${spokenLanguage(preview.sentIn, lang)}` : "";
      if (lang === "cs") return `Pošlu na WhatsApp na číslo ${preview.to}${how}: „${quote(preview.body)}“. Mám ji odeslat?`;
      if (lang === "pl") return `Wyślę na WhatsApp na numer ${preview.to}${how}: „${quote(preview.body)}”. Czy mam ją wysłać?`;
      return `I will send a WhatsApp message to ${preview.to}${how}: “${quote(preview.body)}”. Shall I send it?`;
    }
    case "create_calendar_event": {
      const when = spokenSlot(preview, preview.timeZone, lang);
      const assumed = preview.durationAssumed
        ? (lang === "cs" ? " Délku jste neřekl, počítám hodinu." : lang === "pl" ? " Nie podano długości, liczę godzinę." : " No length was given, so I have allowed one hour.")
        : "";
      const clash = clashSentence(preview.clashes, lang);
      if (lang === "cs") return `Zapíšu „${quote(preview.title, 160)}“ ${when}.${assumed}${clash} Mám to zapsat?`;
      if (lang === "pl") return `Zapiszę „${quote(preview.title, 160)}” ${when}.${assumed}${clash} Czy mam to zapisać?`;
      return `I will put “${quote(preview.title, 160)}” in the calendar ${when}.${assumed}${clash} Shall I add it?`;
    }
    case "move_calendar_event": {
      const from = spokenSlot(preview.from, preview.timeZone, lang);
      const to = spokenSlot(preview.to, preview.timeZone, lang);
      const clash = clashSentence(preview.clashes, lang);
      if (lang === "cs") return `Přesunu „${quote(preview.title, 160)}“. Teď: ${from}. Nově: ${to}.${clash} Mám ji přesunout?`;
      if (lang === "pl") return `Przeniosę „${quote(preview.title, 160)}”. Teraz: ${from}. Nowy termin: ${to}.${clash} Czy mam przenieść?`;
      return `I will move “${quote(preview.title, 160)}”. Now: ${from}. New time: ${to}.${clash} Shall I move it?`;
    }
    case "cancel_calendar_event": {
      const when = preview.when ? ` ${spokenSlot(preview.when, preview.timeZone, lang)}` : "";
      const others = preview.attendeeCount
        ? (lang === "cs" ? " Ostatní účastníci upozorněni nebudou." : lang === "pl" ? " Pozostali uczestnicy nie zostaną powiadomieni." : " The other attendees will not be notified.")
        : "";
      if (lang === "cs") return `Zruším „${quote(preview.title, 160)}“${when}.${others} Mám ji zrušit?`;
      if (lang === "pl") return `Odwołam „${quote(preview.title, 160)}”${when}.${others} Czy mam odwołać?`;
      return `I will cancel “${quote(preview.title, 160)}”${when}.${others} Shall I cancel it?`;
    }
    default:
      return undefined;
  }
}

/** What is said after the yes was carried out. */
export function spokenOutcome(action: string | undefined, data: Row | undefined, language: string): string | undefined {
  const lang = locale(language);
  switch (action) {
    case "reply_whatsapp":
    case "send_whatsapp":
      return lang === "cs" ? "Zpráva je odeslaná." : lang === "pl" ? "Wiadomość została wysłana." : "The message has been sent.";
    case "create_calendar_event":
      if (data?.alreadyCreated) return lang === "cs" ? "Tahle událost už v kalendáři je, druhou jsem nezapsal." : lang === "pl" ? "To wydarzenie już jest w kalendarzu, drugiego nie dodałem." : "That event is already in the calendar; I did not add a second one.";
      return lang === "cs" ? "Zapsáno do kalendáře." : lang === "pl" ? "Zapisane w kalendarzu." : "It is in the calendar.";
    case "move_calendar_event":
      return lang === "cs" ? "Událost je přesunutá." : lang === "pl" ? "Wydarzenie zostało przeniesione." : "The event has been moved.";
    case "cancel_calendar_event":
      return lang === "cs" ? "Událost je zrušená." : lang === "pl" ? "Wydarzenie zostało odwołane." : "The event has been cancelled.";
    default:
      return undefined;
  }
}

/** Plain-language refusals for the errors these actions return; undefined keeps the service's own text. */
export function spokenError(error: string | undefined, extra: Row | undefined, language: string): string | undefined {
  const lang = locale(language);
  const candidates = Array.isArray(extra?.candidates) ? (extra!.candidates as string[]).slice(0, 4).join(", ") : "";
  const messages: Record<string, Record<Locale, string>> = {
    WHATSAPP_REPLY_WINDOW_CLOSED: {
      cs: "Tenhle zákazník psal před víc než 24 hodinami. WhatsApp teď dovolí jen schválenou šablonu a tu zatím neposílám. Zavolejte mu nebo pošlete e-mail.",
      pl: "Ten klient pisał ponad 24 godziny temu. WhatsApp pozwala teraz tylko na zatwierdzony szablon, którego jeszcze nie wysyłam. Zadzwoń lub wyślij e-mail.",
      en: "This customer last wrote more than 24 hours ago. WhatsApp now allows only an approved template, which I do not send yet. Call or email them instead.",
    },
    WHATSAPP_MESSAGE_NOT_FOUND: {
      cs: "Takovou přijatou WhatsApp zprávu jsem nenašel.",
      pl: "Nie znalazłem takiej odebranej wiadomości WhatsApp.",
      en: "I could not find that received WhatsApp message.",
    },
    AMBIGUOUS_REFERENCE: {
      cs: `Na to sedí víc možností${candidates ? `: ${candidates}` : ""}. Řekněte prosím přesněji, kterou myslíte.`,
      pl: `Pasuje kilka możliwości${candidates ? `: ${candidates}` : ""}. Powiedz dokładniej, o którą chodzi.`,
      en: `More than one matches${candidates ? `: ${candidates}` : ""}. Please say which one you mean.`,
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
