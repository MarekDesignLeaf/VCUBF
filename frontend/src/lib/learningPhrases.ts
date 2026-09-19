/**
 * The phrases that drive teaching a new command, and the things the assistant
 * says while doing it.
 *
 * Several spellings per phrase: speech recognition returns what it heard, and
 * "nauč příkaz" and "naučit příkaz" are the same request.
 */

export interface LearningPhrases {
  /** Begins recording. */
  start: string[];
  /** Ends recording. */
  finish: string[];
  /** Agrees to save. */
  save: string[];
  /** Abandons the recording. */
  cancel: string[];
}

export interface LearningSpeech {
  unknown: (phrase: string) => string;
  started: string;
  stopped: (steps: number) => string;
  nothingRecorded: string;
  askNames: string;
  repeatNames: (names: string[]) => string;
  alreadyKnown: (existing: string[], added: string[]) => string;
  nameTaken: (name: string, usedBy: string) => string;
  saved: (names: string[]) => string;
  cancelled: string;
  saveFailed: string;
  running: (name: string) => string;
  runFailed: (label: string) => string;
  replayed: string;
  reviewReplay: string;
}

const CZECH_PHRASES: LearningPhrases = {
  start: ["naucit prikaz", "nauc prikaz", "nauc se prikaz", "naucim te prikaz"],
  finish: ["konec uceni", "ukoncit uceni", "konec nahravani", "hotovo uceni"],
  save: ["uloz", "uloz to", "ano uloz", "potvrzuji", "ano"],
  cancel: ["zrus uceni", "nechci", "zahodit", "ne"],
};

const ENGLISH_PHRASES: LearningPhrases = {
  start: ["teach command", "learn command", "teach a command", "learn a command"],
  finish: ["end learning", "stop learning", "stop recording", "finish learning"],
  save: ["save", "save it", "yes save", "confirm", "yes"],
  cancel: ["cancel learning", "discard", "no"],
};

export function learningPhrases(language: string): LearningPhrases {
  return language.slice(0, 2).toLowerCase() === "cs" ? CZECH_PHRASES : ENGLISH_PHRASES;
}

const CZECH_SPEECH: LearningSpeech = {
  unknown: (phrase) =>
    `Tento příkaz neznám: ${phrase}. Pokud mě ho chcete naučit, řekněte „Naučit příkaz“.`,
  started: "Začínám nahrávat. Proveďte, co potřebujete, a potom řekněte „Konec učení“.",
  stopped: (steps) => `Nahrávání ukončeno, mám ${steps} kroků. Jak se má tento příkaz jmenovat?`,
  nothingRecorded: "Nic jsem nezaznamenala, takže není co uložit.",
  askNames: "Řekněte jeden nebo dva názvy tohoto příkazu.",
  repeatNames: (names) =>
    `Rozumím: ${names.join(" a ")}. Mám to takto uložit? Řekněte „Ulož“.`,
  alreadyKnown: (existing, added) =>
    `Tento postup už znám pod názvem ${existing.join(" a ")}.`
    + (added.length ? ` Přidala jsem k němu ${added.join(" a ")}.` : ""),
  nameTaken: (name, usedBy) =>
    `Název ${name} už patří příkazu ${usedBy}, ten jsem nechala být.`,
  saved: (names) => `Uloženo. Příště řekněte ${names.join(" nebo ")}.`,
  cancelled: "Učení zrušeno, nic jsem neuložila.",
  saveFailed: "Uložení se nepodařilo.",
  running: (name) => `Provádím ${name}.`,
  replayed: "Kroky byly přehrány. Ověřte výsledek na stránce; změna dat zatím není potvrzená.",
  reviewReplay: "Přehrát tyto uložené kroky a hodnoty? Mohou změnit data nebo odeslat formulář.",
  runFailed: (label) => `Zastavila jsem se u kroku ${label}. Stránka se pravděpodobně změnila.`,
};

const ENGLISH_SPEECH: LearningSpeech = {
  unknown: (phrase) =>
    `I do not know that command: ${phrase}. To teach me, say “teach command”.`,
  started: "Recording. Do what you need, then say “end learning”.",
  stopped: (steps) => `Recording finished, ${steps} steps. What should this command be called?`,
  nothingRecorded: "I recorded nothing, so there is nothing to save.",
  askNames: "Say one or two names for this command.",
  repeatNames: (names) => `I have: ${names.join(" and ")}. Save it like that? Say “save”.`,
  alreadyKnown: (existing, added) =>
    `I already know this one as ${existing.join(" and ")}.`
    + (added.length ? ` I have added ${added.join(" and ")} to it.` : ""),
  nameTaken: (name, usedBy) => `The name ${name} already belongs to ${usedBy}, so I left it there.`,
  saved: (names) => `Saved. Next time say ${names.join(" or ")}.`,
  cancelled: "Learning cancelled, nothing was saved.",
  saveFailed: "Saving failed.",
  running: (name) => `Running ${name}.`,
  replayed: "The steps were replayed. Check the result on the page; data changes are not yet verified.",
  reviewReplay: "Replay these saved steps and values? They may change data or submit a form.",
  runFailed: (label) => `I stopped at the step ${label}. The page has probably changed.`,
};

export function learningSpeech(language: string): LearningSpeech {
  return language.slice(0, 2).toLowerCase() === "cs" ? CZECH_SPEECH : ENGLISH_SPEECH;
}

/** Diacritics- and punctuation-insensitive comparison of what was heard. */
export function foldPhrase(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function matchesAny(spoken: string, candidates: string[]): boolean {
  const text = foldPhrase(spoken);
  return candidates.some((candidate) => text === candidate || text.includes(candidate));
}

/**
 * Splits "nová zakázka a založ zakázku" into the two names it contains.
 *
 * People list alternatives with "a", "nebo", "or" and commas; treating the whole
 * utterance as one name would store a phrase nobody will ever say again.
 */
export function splitNames(spoken: string): string[] {
  return spoken
    .split(/\s+(?:a|nebo|and|or)\s+|[,;]/i)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2)
    .slice(0, 4);
}
