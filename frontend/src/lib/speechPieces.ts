/**
 * Where a spoken reply is cut so that its first words can be heard while the
 * rest is still being synthesised.
 *
 * The whole reply used to go to text-to-speech as one request, and nothing was
 * heard until all of it had come back: measured 9. 10., 1.7–3.5 s of silence
 * after the answer was already known. The first sentence alone comes back in a
 * fraction of that, and the later pieces are synthesised side by side while it
 * plays.
 *
 * Only whole sentences are cut, so the pieces sound like the pauses between
 * sentences they already were. A full stop counts only when a capital letter
 * follows, so "9. října", "č. 5", "1.5" or an e-mail address stay in one piece,
 * and not after a title ("Ing. Novák", "Mr. Smith"). A line break is kept as a
 * line break, so a list keeps its pauses.
 *
 * No lookbehind: Safari before 16.4 cannot parse one, and this module is loaded
 * with the whole app.
 */

/** A first piece shorter than this ("Ano.") takes the next sentence with it: one syllable alone sounds clipped. "Hotovo." stands alone. */
export const FIRST_PIECE_MIN = 6;
/** Later sentences are grouped up to this length, so a long review is a few requests, not dozens. */
export const PIECE_MAX = 320;
/** At most this many requests for one reply; the last piece takes whatever is left. */
export const MAX_PIECES = 8;

/** End punctuation (with closing quotes) and the space after it, before a capital; or a line break. */
const BOUNDARY = /[.!?…]["”“»)\]]*(\s+)(?=["„“«(]?\p{Lu})|(\s*\n\s*)/gu;
/** A title abbreviation right before the full stop: the sentence goes on. */
const TITLE_BEFORE = /(?:^|[^\p{L}])(?:Ing|Mgr|Bc|Dr|MUDr|JUDr|PhDr|RNDr|Prof|Doc|Mr|Mrs|Ms|St|sv)$/u;

interface Sentence {
  text: string;
  /** What separated it from the sentence before: a space or a line break. */
  joiner: string;
}

function sentences(text: string): Sentence[] {
  const found: Sentence[] = [];
  let start = 0;
  let joiner = "";
  for (const match of text.matchAll(BOUNDARY)) {
    const afterPunctuation = match[1] !== undefined;
    const lineBreak = !afterPunctuation || match[1].includes("\n");
    // The punctuation stays with its sentence; only the space after it is the cut.
    const end = afterPunctuation ? match.index! + match[0].length - match[1].length : match.index!;
    if (afterPunctuation && !lineBreak && TITLE_BEFORE.test(text.slice(start, match.index!))) continue;
    const sentence = text.slice(start, end).trim();
    if (sentence) {
      found.push({ text: sentence, joiner });
      joiner = lineBreak ? "\n" : " ";
    } else if (lineBreak) {
      joiner = "\n";
    }
    start = match.index! + match[0].length;
  }
  const last = text.slice(start).trim();
  if (last) found.push({ text: last, joiner });
  return found;
}

export function speechPieces(text: string): string[] {
  const all = sentences(text.trim());
  if (all.length <= 1) return all.map((sentence) => sentence.text);

  const pieces: string[] = [];
  let index = 0;
  let first = all[index++].text;
  while (first.length < FIRST_PIECE_MIN && index < all.length) {
    first = `${first}${all[index].joiner}${all[index].text}`;
    index += 1;
  }
  pieces.push(first);

  let current = "";
  for (; index < all.length; index += 1) {
    const { text: sentence, joiner } = all[index];
    if (current && current.length + 1 + sentence.length > PIECE_MAX && pieces.length < MAX_PIECES - 1) {
      pieces.push(current);
      current = sentence;
    } else {
      current = current ? `${current}${joiner}${sentence}` : sentence;
    }
  }
  if (current) pieces.push(current);
  return pieces;
}
