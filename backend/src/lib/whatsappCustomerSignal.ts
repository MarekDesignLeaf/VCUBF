/**
 * A reading aid for the WhatsApp sender review — never a decision.
 *
 * It looks only at what a sender actually wrote and reports which
 * work-related terms (landscaping, gardening, quotes, visits, invoices...)
 * appear in it, so the person reviewing can sort and read the likely
 * customers first. It never looks at the sender's name, number, country or
 * language, and it never approves or rejects anyone: every sender stays in the
 * review until a person decides.
 *
 * A single matching word is deliberately not enough to call a sender a
 * candidate ("tree" or "price" turn up in personal chats too); it is reported
 * as a weak signal, which is still "review needed". Personal chats,
 * employees and subcontractors cannot be told apart from customers by
 * keywords at all, so no signal ever suggests "not a customer" either.
 *
 * Extra terms can be added per deployment with WHATSAPP_CUSTOMER_SIGNAL_TERMS
 * (comma separated), for services the default list does not cover.
 */

export type WorkSignalLevel = "work_related_candidate" | "weak_signal" | "no_work_terms" | "no_messages";

export interface WorkSignal {
  level: WorkSignalLevel;
  matchedTerms: string[];
  /** Always shown with the signal: this is an inference, not a fact. */
  basis: "inference_from_message_text";
}

// English (customer-facing) and Czech (owner) terms. Multi-word terms match
// as phrases. Kept specific to the work: generic words such as "hello",
// "tomorrow" or "thanks" are not evidence of anything.
const DEFAULT_TERMS = [
  // English
  "garden", "gardens", "gardening", "gardener", "landscaping", "landscape", "landscaper", "lawn", "lawns", "turf",
  "artificial grass", "hedge", "hedges", "hedge trimming", "tree", "trees", "tree surgery", "stump", "pruning", "prune",
  "patio", "patios", "paving", "driveway", "decking", "fence", "fencing", "fence panel", "retaining wall", "raised bed",
  "planting", "plants", "shrubs", "turfing", "mowing", "mow", "weeding", "garden clearance", "clearance", "soil",
  "topsoil", "gravel", "slabs", "sleepers", "pergola", "drainage",
  "quote", "quotation", "estimate", "price for", "how much", "invoice", "deposit", "booking", "site visit", "survey",
  "start date",
  // Czech
  "zahrada", "zahradu", "zahrady", "zahradnik", "travnik", "travniku", "seceni", "posekat", "zivy plot", "plot", "plotu",
  "strom", "stromy", "stromu", "dlazba", "dlazbu", "terasa", "terasu", "zakazka", "zakazku", "nabidka", "nabidku",
  "cenova nabidka", "faktura", "fakturu", "zaloha", "obhlidka", "obhlidku", "vysadba", "kere",
] as const;

function plain(value: string): string {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase("en").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function configuredTerms(): string[] {
  const extra = (process.env.WHATSAPP_CUSTOMER_SIGNAL_TERMS ?? "")
    .split(",")
    .map((term) => plain(term))
    .filter((term) => term.length >= 3);
  return [...new Set([...DEFAULT_TERMS.map(plain), ...extra])];
}

/**
 * Which work-related terms occur in these messages. Two or more different
 * terms make a candidate for review; one is a weak signal; none says only
 * that no work terms were found, never that the sender is not a customer.
 */
export function workSignal(messages: string[]): WorkSignal {
  if (!messages.length) return { level: "no_messages", matchedTerms: [], basis: "inference_from_message_text" };
  const text = ` ${messages.map(plain).join(" ")} `;
  const matched = configuredTerms().filter((term) => text.includes(` ${term} `));
  // A phrase and the word inside it are one piece of evidence, not two.
  const distinct = matched.filter((term) => !matched.some((other) => other !== term && other.includes(term)));
  const level: WorkSignalLevel = distinct.length >= 2 ? "work_related_candidate" : distinct.length === 1 ? "weak_signal" : "no_work_terms";
  return { level, matchedTerms: distinct.sort(), basis: "inference_from_message_text" };
}
