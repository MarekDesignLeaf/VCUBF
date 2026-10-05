// Turns the date and time words a person actually says into calendar values.
//
// The language model does not know what day it is, so it passes the words as
// spoken ("zítra", "v pátek", "6. října") and the backend resolves them against
// the calendar's own time zone. The result is always shown back in the review
// before anything is written, so a wrong reading is caught by the person, but
// nothing here guesses: words it does not recognise are refused.

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

function plain(value: string) {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase("en").replace(/[,]/g, " ").replace(/\s+/g, " ").trim();
}

function validDateKey(year: number, month: number, day: number) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return undefined;
  const value = new Date(Date.UTC(year, month - 1, day));
  if (value.getUTCFullYear() !== year || value.getUTCMonth() !== month - 1 || value.getUTCDate() !== day) return undefined;
  return value.toISOString().slice(0, 10);
}

export function addDays(dateKey: string, days: number) {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

export function weekdayOf(dateKey: string) {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

const RELATIVE: Array<[RegExp, number]> = [
  [/^(?:the )?day after tomorrow$|^pozitri$|^pojutrze$/, 2],
  [/^today$|^dnes(?:ka)?$|^dzis(?:iaj)?$/, 0],
  [/^tomorrow$|^zitra$|^jutro$/, 1],
];

// Sunday = 0, as Date.getUTCDay.
const WEEKDAYS: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
  nedele: 0, nedeli: 0, pondeli: 1, utery: 2, streda: 3, stredu: 3, ctvrtek: 4, patek: 5, sobota: 6, sobotu: 6,
  niedziela: 0, niedziele: 0, poniedzialek: 1, wtorek: 2, sroda: 3, srode: 3, czwartek: 4, piatek: 5, sobote: 6,
};

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  leden: 1, ledna: 1, unor: 2, unora: 2, brezen: 3, brezna: 3, duben: 4, dubna: 4, kveten: 5, kvetna: 5, cerven: 6, cervna: 6,
  cervenec: 7, cervence: 7, srpen: 8, srpna: 8, zari: 9, rijen: 10, rijna: 10, listopad: 11, listopadu: 11, prosinec: 12, prosince: 12,
  styczen: 1, stycznia: 1, luty: 2, lutego: 2, marzec: 3, marca: 3, kwiecien: 4, kwietnia: 4, maj: 5, maja: 5, czerwiec: 6, czerwca: 6,
  lipiec: 7, lipca: 7, sierpien: 8, sierpnia: 8, wrzesien: 9, wrzesnia: 9, pazdziernik: 10, pazdziernika: 10, grudzien: 12, grudnia: 12,
};

/** A date the year was not said for is this year's, or next year's if it has already passed. */
function withYear(month: number, day: number, year: number | undefined, todayKey: string) {
  if (year !== undefined) return validDateKey(year < 100 ? 2000 + year : year, month, day);
  const thisYear = Number(todayKey.slice(0, 4));
  const candidate = validDateKey(thisYear, month, day);
  if (!candidate) return undefined;
  return candidate >= todayKey ? candidate : validDateKey(thisYear + 1, month, day);
}

/**
 * Resolves a spoken date to YYYY-MM-DD against today's date in the calendar's
 * time zone. Weekdays mean the next such day after today. Returns undefined
 * for anything not recognised.
 */
export function resolveSpokenDate(raw: string, todayKey: string): string | undefined {
  if (!DATE_KEY.test(todayKey)) return undefined;
  const text = plain(raw).replace(/^(?:on|v|ve|na|w|we|dne|dnia)\s+/, "").replace(/^(?:this|tento|tuto|ten|ta|tu|ten)\s+/, "").trim();
  if (!text) return undefined;
  if (DATE_KEY.test(text)) {
    const [year, month, day] = text.split("-").map(Number);
    return validDateKey(year, month, day);
  }
  for (const [pattern, offset] of RELATIVE) if (pattern.test(text)) return addDays(todayKey, offset);

  // "next Friday" is read the same as "Friday": the next one after today.
  // The review states the date, so the person sees which Friday it is.
  const weekdayWord = text.replace(/^(?:next|pristi|przyszl[aey]|przyszly)\s+/, "");
  if (Object.prototype.hasOwnProperty.call(WEEKDAYS, weekdayWord)) {
    const ahead = ((WEEKDAYS[weekdayWord] - weekdayOf(todayKey) + 7) % 7) || 7;
    return addDays(todayKey, ahead);
  }

  // 6.10. / 6. 10. 2026 / 6/10/2026 (day before month, as written in the UK and CZ)
  const numeric = text.match(/^(\d{1,2})\s*[./]\s*(\d{1,2})\s*[./]?\s*(\d{2,4})?\.?$/);
  if (numeric) return withYear(Number(numeric[2]), Number(numeric[1]), numeric[3] ? Number(numeric[3]) : undefined, todayKey);

  // 6 October / 6. října / 6 pazdziernika [2026]
  const dayFirst = text.match(/^(\d{1,2})\.?\s*(?:of\s+)?([a-z]+)\.?(?:\s+(\d{4}))?$/);
  if (dayFirst && MONTHS[dayFirst[2]]) return withYear(MONTHS[dayFirst[2]], Number(dayFirst[1]), dayFirst[3] ? Number(dayFirst[3]) : undefined, todayKey);
  // October 6 [2026]
  const monthFirst = text.match(/^([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s+(\d{4}))?$/);
  if (monthFirst && MONTHS[monthFirst[1]]) return withYear(MONTHS[monthFirst[1]], Number(monthFirst[2]), monthFirst[3] ? Number(monthFirst[3]) : undefined, todayKey);
  return undefined;
}

/** 24-hour "8", "8:30", "08.30", "8h" — only unambiguous forms; returns HH:MM. */
export function resolveSpokenTime(raw: string): string | undefined {
  const text = plain(raw).replace(/^(?:at|v|ve|o|w|we)\s+/, "").replace(/\s*(?:h|hod(?:in)?|hodin|godz(?:ina)?)\.?$/, "").trim();
  const match = text.match(/^(\d{1,2})(?:[:.](\d{2}))?$/);
  if (!match) return undefined;
  const hours = Number(match[1]);
  const minutes = match[2] === undefined ? 0 : Number(match[2]);
  if (hours > 23 || minutes > 59) return undefined;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/** Adds minutes to a wall-clock date and time without touching time zones. */
export function addMinutesToLocal(dateKey: string, time: string, minutes: number) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const [hours, mins] = time.split(":").map(Number);
  const value = new Date(Date.UTC(year, month - 1, day, hours, mins) + minutes * 60_000);
  return { date: value.toISOString().slice(0, 10), time: value.toISOString().slice(11, 16) };
}

function zoneOffsetMs(instant: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((item) => item.type === type)?.value);
  return Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second")) - instant.getTime();
}

/** The instant a wall-clock date and time in a time zone refers to. */
export function zonedInstant(dateKey: string, time: string, timeZone: string) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const [hours, minutes] = time.split(":").map(Number);
  const wall = Date.UTC(year, month - 1, day, hours, minutes);
  const first = wall - zoneOffsetMs(new Date(wall), timeZone);
  return new Date(wall - zoneOffsetMs(new Date(first), timeZone));
}

/** Wall-clock date and time of an instant in a time zone. */
export function localDateTime(instant: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
  return { date: `${part("year")}-${part("month")}-${part("day")}`, time: `${part("hour")}:${part("minute")}` };
}
