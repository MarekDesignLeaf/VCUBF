// Which Gmail account a message leaves from. A company may connect more than
// one Google account (a company mailbox and a personal one, say). The account
// is chosen deterministically, never guessed:
//   1. an account the user named ("z firemního", "from designleaf",
//      "marek@designleaf.co.uk") — matched against the authorised address and
//      the source's display name, ignoring accents and Czech word endings;
//   2. otherwise the one account that can send, if there is only one;
//   3. otherwise the company's default sender.
// Anything else is ambiguous and the caller asks which account to use.

export interface GmailSendingCandidate {
  id: string;
  displayName: string;
  accountEmail: string | null;
  isDefaultSender: boolean;
}

export type GmailAccountChoice<T extends GmailSendingCandidate> =
  | { ok: true; source: T; reason: "named" | "only" | "default" }
  | { ok: false; error: "GMAIL_ACCOUNT_NOT_FOUND" | "AMBIGUOUS_GMAIL_SOURCE"; candidates: T[] };

type AccountWordsLanguage = "en" | "cs" | "pl";

// The words of the language switched on, plus English, the system's internal
// language, in which the language model may write the reference. With Czech
// on, Polish words are not read, nor Czech ones with Polish on.
const ACCOUNT_WORDS: Record<AccountWordsLanguage, { filler: string[]; business: string[]; personal: string[] }> = {
  en: {
    filler: ["from", "the", "my", "account", "mailbox", "email", "e", "mail", "address"],
    business: ["business", "company", "work", "office"],
    personal: ["personal", "private", "home"],
  },
  cs: {
    filler: ["z", "ze", "od", "s", "muj", "meho", "mym", "moje", "ucet", "uctu", "uctem", "ucty", "schranka", "schranky",
      "email", "e", "mail", "mailu", "emailu", "adresa", "adresy", "adresou"],
    business: ["firemni", "firma", "firmy", "pracovni", "kancelar"],
    personal: ["osobni", "soukromy", "soukrome", "domaci"],
  },
  pl: {
    filler: ["z", "ze", "od", "konta", "konto", "email", "e", "mail"],
    business: ["firmowy", "firmowe", "sluzbowy", "sluzbowe"],
    personal: ["prywatny", "prywatne", "osobisty", "osobiste", "domowy"],
  },
};

function accountWords(language: string) {
  const prefix = language.trim().toLowerCase().split("-", 1)[0];
  const own = ACCOUNT_WORDS[(prefix === "cs" || prefix === "pl" ? prefix : "en") as AccountWordsLanguage];
  const english = ACCOUNT_WORDS.en;
  return own === english ? english : {
    filler: [...own.filler, ...english.filler],
    business: [...own.business, ...english.business],
    personal: [...own.personal, ...english.personal],
  };
}

function plain(value: string) {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase("en");
}

function words(value: string) {
  return plain(value).split(/[^a-z0-9]+/).filter(Boolean);
}

// Czech inflects the name of the account ("firemní" → "z firemního účtu"), so
// a spoken word matches a name word when one begins with the other, or when
// they share all but the last two letters of the shorter one.
function sameWord(spoken: string, name: string) {
  if (spoken.length < 3 || name.length < 3) return spoken === name;
  if (name.startsWith(spoken) || spoken.startsWith(name)) return true;
  if (spoken.length < 5 || name.length < 5) return false;
  let common = 0;
  while (common < spoken.length && common < name.length && spoken[common] === name[common]) common++;
  return common >= Math.min(spoken.length, name.length) - 2;
}

// Owners call an account by its purpose: the "Business Gmail" source is
// "firemní" when spoken in Czech. The account's own name may be written in any
// language, so its purpose is recognised in all of them; what the user says is
// read in the language switched on.
const PURPOSES = ["business", "personal"] as const;

function meaning(word: string, languages: Array<(typeof ACCOUNT_WORDS)[AccountWordsLanguage]>) {
  if (word.length < 4) return undefined;
  const purpose = PURPOSES.find((name) => languages.some((words) => words[name].some((known) => sameWord(word, known))));
  return purpose ? `#${purpose}` : undefined;
}

// The address contributes its mailbox name and its provider ("designleaf",
// "gmail"); top-level parts such as "com" or "co.uk" name nothing.
function addressWords(address: string | null) {
  if (!address) return [];
  const [local, domain = ""] = plain(address).split("@");
  return [...words(local), ...words(domain.split(".")[0] ?? "")];
}

function nameWords(candidate: GmailSendingCandidate) {
  const named = words(candidate.displayName);
  const meanings = named.map((word) => meaning(word, Object.values(ACCOUNT_WORDS))).filter((value): value is string => Boolean(value));
  return [...named, ...addressWords(candidate.accountEmail), ...meanings];
}

function spokenMatches(word: string, names: string[], language: string) {
  const spokenMeaning = meaning(word, [accountWords(language)]);
  return names.some((name) => (name.startsWith("#") ? name === spokenMeaning : sameWord(word, name)));
}

/**
 * Accounts the spoken or typed reference points at; empty when none does.
 * `language` is the one switched on, whose words the reference is read in.
 */
export function matchGmailAccounts<T extends GmailSendingCandidate>(candidates: T[], reference: string, language: string): T[] {
  const trimmed = reference.trim();
  if (!trimmed) return [];
  if (trimmed.includes("@")) {
    const address = plain(trimmed);
    return candidates.filter((candidate) => candidate.accountEmail && plain(candidate.accountEmail) === address);
  }
  const filler = new Set(accountWords(language).filler);
  const spoken = words(trimmed).filter((word) => !filler.has(word));
  if (!spoken.length) return [];
  return candidates.filter((candidate) => {
    const names = nameWords(candidate);
    return spoken.every((word) => spokenMatches(word, names, language));
  });
}

export function chooseGmailSendingAccount<T extends GmailSendingCandidate>(candidates: T[], reference: string | undefined, language: string): GmailAccountChoice<T> {
  if (reference?.trim()) {
    const named = matchGmailAccounts(candidates, reference, language);
    if (named.length === 1) return { ok: true, source: named[0], reason: "named" };
    return named.length === 0
      ? { ok: false, error: "GMAIL_ACCOUNT_NOT_FOUND", candidates }
      : { ok: false, error: "AMBIGUOUS_GMAIL_SOURCE", candidates: named };
  }
  if (candidates.length === 1) return { ok: true, source: candidates[0], reason: "only" };
  const defaults = candidates.filter((candidate) => candidate.isDefaultSender);
  if (defaults.length === 1) return { ok: true, source: defaults[0], reason: "default" };
  return { ok: false, error: "AMBIGUOUS_GMAIL_SOURCE", candidates };
}

/** How an account is named back to the user: its address when known. */
export function gmailAccountLabel(candidate: Pick<GmailSendingCandidate, "displayName" | "accountEmail">) {
  return candidate.accountEmail ? `${candidate.displayName} (${candidate.accountEmail})` : candidate.displayName;
}
