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
 * follows, so "9. října", "č. 5", "1.5" or an e-mail address stay in one piece.
 */

/** A first piece shorter than this ("Ano.") takes the next sentence with it: one syllable alone sounds clipped. "Hotovo." stands alone. */
export const FIRST_PIECE_MIN = 6;
/** Later sentences are grouped up to this length, so a long review is a few requests, not dozens. */
export const PIECE_MAX = 320;
/** At most this many requests for one reply; the last piece takes whatever is left. */
export const MAX_PIECES = 8;

const SENTENCE_END = /(?<=[.!?…]["”“»)\]]*)\s+(?=["„“«(]?\p{Lu})|\s*\n+\s*/u;

export function speechPieces(text: string): string[] {
  const sentences = text.trim().split(SENTENCE_END).map((sentence) => sentence.trim()).filter(Boolean);
  if (sentences.length <= 1) return sentences;

  const pieces: string[] = [];
  let index = 0;
  let first = sentences[index++];
  while (first.length < FIRST_PIECE_MIN && index < sentences.length) first = `${first} ${sentences[index++]}`;
  pieces.push(first);

  let current = "";
  for (; index < sentences.length; index += 1) {
    const sentence = sentences[index];
    if (current && current.length + 1 + sentence.length > PIECE_MAX && pieces.length < MAX_PIECES - 1) {
      pieces.push(current);
      current = sentence;
    } else {
      current = current ? `${current} ${sentence}` : sentence;
    }
  }
  if (current) pieces.push(current);
  return pieces;
}
