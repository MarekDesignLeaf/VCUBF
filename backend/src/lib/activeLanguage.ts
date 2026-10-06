// {assistant} listens in the language the owner has switched on. With Czech on,
// Polish is not understood: a Polish sentence is neither matched by the command
// parser nor handed to the language model, so nothing is done on its strength.
// Polish is understood only after switching to it ("přepni na polštinu"); the
// switch itself is always heard, in any language.
//
// The language is read from the command, not from the names inside it. A
// sentence reads as Polish when its command words are Polish: the first word
// (among the first six) that is either a Polish command word or carries a
// letter only Czech uses decides. Capitalised words after the first are names
// and are skipped, so "zmień email kontaktu Dvořák" is Polish, while
// "vytvoř klienta Paweł Nowak" and "change email for contact Alice Nie" are not.

// Letters Czech has and Polish does not. Polish "ż" and "ź" are different
// characters from Czech "ž"; "ó" belongs to both and is not listed.
const CZECH_ONLY_LETTERS = /[áéíúůýčďěňřšťž]/iu;

// Folded to plain ASCII (ł → l, accents removed). Every Polish command word
// the deterministic parser accepts, plus Polish question and function words a
// spoken request starts with. None of them is a Czech or English word (Czech
// "chce", "nastav", "obnov", "synchronizuj", "tak" and "mam" are left out).
const POLISH_WORDS = new Set([
  // verbs the parser accepts
  "pokaz", "pokazac", "wyswietl", "przeczytaj", "sprawdz", "otworz", "przejdz", "wyslij", "napisz", "usun", "skasuj",
  "wyczysc", "zarchiwizuj", "zmien", "przelacz", "ustaw", "wlacz", "wylacz", "uruchom", "polacz", "skonfiguruj",
  "nakonfiguruj", "zsynchronizuj", "odswiez", "potwierdzam", "potwierdz", "anuluj", "przerwij", "utworz", "dodaj",
  "zapamietaj", "pamietasz", "poprosze", "prosze", "usuwanie", "zrob", "zadzwon", "zaplanuj", "przenies", "odwolaj",
  // question and function words
  "jakie", "jaki", "ktore", "ktory", "ktora", "czy", "ile", "gdzie", "kiedy", "kto", "teraz", "mnie", "sie",
  "nie", "jest", "jestem", "dla", "oraz", "dziekuje",
  // days and things a request is about
  "dzisiaj", "dzis", "jutro", "wczoraj", "pojutrze", "jutrzejsze", "dzisiejsze", "najblizsze", "wszystkie",
  "wszystkich", "wiadomosc", "wiadomosci", "powiadomienia", "powiadomien", "poczta", "poczte", "kalendarz",
  "kalendarzu", "spotkanie", "spotkania", "wydarzenie", "wydarzenia", "zlecenie", "zlecenia", "zadanie", "zadania",
  "klientow", "jezyk", "jezyka", "polsku",
]);

const COMMAND_WORDS_CHECKED = 6;

function folded(text: string) {
  return text.toLocaleLowerCase("pl").replace(/ł/g, "l").normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

export function readsAsPolish(text: string): boolean {
  const words = text.trim().split(/[\s,.;:!?„“”"'()]+/u).filter(Boolean).slice(0, COMMAND_WORDS_CHECKED);
  for (const [index, word] of words.entries()) {
    if (index > 0 && /^\p{Lu}/u.test(word)) continue;
    if (CZECH_ONLY_LETTERS.test(word)) return false;
    if (POLISH_WORDS.has(folded(word))) return true;
  }
  return false;
}

/** True when the sentence is Polish and Polish is not the language switched on. */
export function isPolishWhileOtherLanguageActive(text: string, activeLanguage: string): boolean {
  return !activeLanguage.toLowerCase().startsWith("pl") && readsAsPolish(text);
}

/** What {assistant} says instead of acting on it, in the language that is on. */
export function polishNotActiveMessage(activeLanguage: string): string {
  return activeLanguage.toLowerCase().startsWith("cs")
    ? "Teď mluvím česky a polsky nerozumím. Jestli chcete polštinu, řekněte: přepni na polštinu."
    : "I am working in English and do not take commands in Polish. To use Polish, say: switch to Polish.";
}
