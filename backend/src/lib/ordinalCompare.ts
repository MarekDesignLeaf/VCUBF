/**
 * Locale-free ordering for anything canonical: catalogues, fingerprints,
 * stable JSON. `localeCompare` without a locale follows the process's
 * default ICU locale, so the same code sorts differently on a Czech Windows
 * PC ("ch" after "h") than on an English CI runner, and every fingerprint
 * built from that order changes with the machine. This compares UTF-16 code
 * units, exactly what `Array.prototype.sort()` does by default; for the
 * ASCII names used here that is the code-point order.
 *
 * Use it for every order that is hashed, recorded or compared. User-facing
 * lists that should follow a language keep an explicit locale instead.
 */
export function ordinalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
