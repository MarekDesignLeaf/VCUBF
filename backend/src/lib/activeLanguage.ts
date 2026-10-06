// {assistant} listens in the language the owner has switched on. With Czech on,
// Polish is not understood: a Polish sentence is neither matched by the command
// parser nor handed to the language model, so nothing is done on its strength.
// Polish is understood only after switching to it ("přepni na polštinu"); the
// switch itself is always heard, in any language.
//
// Recognition is deliberately narrow. A sentence reads as Polish only when it
// carries a word that exists in Polish and not in Czech or English, and has no
// letter that only Czech uses. A Polish name inside a Czech or English command
// ("vytvoř klienta Paweł Nowak", "create client Paweł Nowak") is not Polish.

// Letters Czech has and Polish does not. Polish "ż" and "ź" are different
// characters from Czech "ž"; "ó" belongs to both and is not listed.
const CZECH_ONLY_LETTERS = /[áéíúůýčďěňřšťž]/iu;

// Folded to plain ASCII (ł → l, accents removed). Function words, verbs and
// nouns used in commands; none of them is a Czech or English word.
const POLISH_WORDS = new Set([
  "czy", "sie", "nie", "mnie", "jestem", "ile", "dla", "oraz", "teraz", "gdzie", "kiedy", "ktory", "ktora", "ktore", "ktorego",
  "dzisiaj", "jutro", "wczoraj", "pojutrze", "jutrzejsze", "dzisiejsze", "dzien", "prosze", "dziekuje", "dzieki",
  "wyslij", "pokaz", "napisz", "przelacz", "zmien", "ustaw", "wlacz", "wylacz", "zrob", "usun", "otworz", "przejdz",
  "sprawdz", "przeczytaj", "odswiez", "potwierdzam", "potwierdz", "anuluj", "przerwij", "dodaj", "utworz", "skasuj",
  "wszystkie", "wszystko", "wiadomosc", "wiadomosci", "wiadomoscia", "tresc", "poczta", "poczte", "poczty",
  "kalendarz", "kalendarzu", "spotkanie", "spotkania", "wydarzenie", "wydarzenia", "zlecenie", "zlecenia",
  "zadanie", "zadania", "klientow", "powiadomienia", "powiadomienie", "jezyk", "jezyka", "polsku",
]);

function folded(text: string) {
  return text.toLocaleLowerCase("pl").replace(/ł/g, "l").normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

export function readsAsPolish(text: string): boolean {
  if (CZECH_ONLY_LETTERS.test(text)) return false;
  return folded(text).split(/[^a-z]+/).some((word) => POLISH_WORDS.has(word));
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
