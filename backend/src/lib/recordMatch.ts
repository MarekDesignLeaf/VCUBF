// Finding a record by what was said about it. Czech and Polish decline names
// ("otevři klienta Nováka", "nabídku pro Dvořákovou"), so a said word stands
// for a word of the record when the two start alike and differ only in the
// last letters. Numbers ("fakturu číslo 2026-014") must be the same number.
// Nothing is guessed: two records that fit equally well are both named back.

import { fold } from "./commandGrammar/shared.js";

export interface RecordCandidate {
  id: string;
  /** How the record is named back ("Plot (Jan Novák)"). */
  label: string;
  /** What the record may be called by: its name, title, number, its client's name. */
  names: string[];
}

export type RecordMatch =
  | { outcome: "found"; record: RecordCandidate }
  | { outcome: "ambiguous"; records: RecordCandidate[] }
  | { outcome: "none" };

/** Words that join a name to its record and name nobody ("zakázku Plot u Nováka", "quote for Smith"). */
const JOINING_WORDS = new Set([
  "pro", "od", "u", "s", "se", "a", "na", "z", "ze", "pan", "pana", "panu", "pani", "panem", "cislo", "c",
  "the", "for", "from", "of", "and", "mr", "mrs", "ms", "number", "no",
  "dla", "o", "i", "nr", "numer", "pania",
  // The client said as a word ("nabídku klientovi Novákovi", "the quote for client Smith").
  "klient", "klienta", "klientovi", "klientce", "klientky", "zakaznik", "zakaznika", "zakaznikovi", "zakaznici",
  "client", "customer", "klientowi",
]);

function words(value: string): string[] {
  return fold(value).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function commonPrefix(left: string, right: string): number {
  let length = 0;
  while (length < left.length && length < right.length && left[length] === right[length]) length += 1;
  return length;
}

/**
 * How well a said word stands for a word of the record: 0 when it does not.
 * A declined form keeps the record word but for its last letter or two and
 * adds an ending of at most four ("Novák" → "Novákovi", "Dvořáková" →
 * "Dvořákovou", "Eva" → "Evu"); "Novinka" shares only "Nov" with Novák and is
 * someone else.
 */
function wordScore(said: string, part: string): number {
  if (/\d/.test(said) || /\d/.test(part)) return said === part ? said.length + 2 : 0;
  if (said === part) return said.length + 1;
  if (said.length < 3) return 0;
  const shared = commonPrefix(said, part);
  if (said.length - shared > 4) return 0;
  const enough = part.length <= 4 ? Math.max(2, part.length - 1) : Math.max(3, part.length - 2, Math.ceil(part.length * 0.7));
  return shared >= enough ? shared : 0;
}

function score(saidWords: string[], saidWhole: string, candidate: RecordCandidate): number {
  const parts = candidate.names.flatMap(words);
  let total = 0;
  for (const word of saidWords) {
    const best = Math.max(0, ...parts.map((part) => wordScore(word, part)));
    if (!best) return 0;
    total += best;
  }
  // Said exactly as it is written is better than any declined form.
  if (candidate.names.some((name) => fold(name).replace(/[^\p{L}\p{N}]+/gu, " ").trim() === saidWhole)) total += 100;
  return total;
}

export function matchRecord(said: string, candidates: RecordCandidate[]): RecordMatch {
  const saidWords = words(said).filter((word) => !JOINING_WORDS.has(word));
  if (!saidWords.length) return { outcome: "none" };
  const saidWhole = saidWords.join(" ");
  const scored = candidates
    .map((candidate) => ({ candidate, score: score(saidWords, saidWhole, candidate) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score);
  if (!scored.length) return { outcome: "none" };
  const best = scored.filter((entry) => entry.score === scored[0].score);
  return best.length === 1
    ? { outcome: "found", record: best[0].candidate }
    : { outcome: "ambiguous", records: best.map((entry) => entry.candidate) };
}
