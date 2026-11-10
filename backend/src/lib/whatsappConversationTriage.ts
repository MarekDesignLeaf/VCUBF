/**
 * Conservative, read-only classification for WhatsApp *attention*.
 *
 * This is NOT a customer-import decision and it never sends a reply. A pending
 * sender with a clear request is sent for human review; a sender explicitly
 * rejected in WhatsApp review is never turned into a sales enquiry.
 *
 * Keep the raw CommunicationIntake rows untouched. This helper only decides
 * which conversations merit an attention item. It deliberately uses recent
 * conversation context rather than historical keyword counts.
 */
export type WhatsAppAttentionDecision = "actionable" | "review" | "ignore";

export interface WhatsAppTriageMessage {
  text: string;
  receivedAt: Date;
}

export interface WhatsAppSenderReview {
  reviewStatus?: string | null;
  reviewClassification?: string | null;
}

export interface WhatsAppTriageResult {
  decision: WhatsAppAttentionDecision;
  reason: "confirmed_customer_work" | "possible_new_enquiry" | "explicit_non_customer" | "insufficient_work_context";
}

const MAX_CONTEXT_MESSAGES = 12;
const CONTEXT_DAYS = 21;

function normalize(value: string): string {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase("en").replace(/\s+/g, " ").trim();
}

// Service names are supporting context, NOT independent proof of a job.
const SERVICE = /\b(?:garden(?:s|ing|er)?|landscap(?:e|ing|er)|lawn|turf|hedge|tree|stump|prun(?:e|ing)|patio|paving|driveway|decking|fenc(?:e|ing)|slabs?|pergola|gravel|plumb(?:ing|er)|drainage|shed|zahrad\w*|travnik\w*|plot\w*|dlazb\w*|teras\w*|ogrod\w*|trawnik\w*)\b/i;
const REQUEST = /\b(?:can you|could you|would you|are you able|please (?:come|do|send|quote|check|visit)|i need|we need|looking for|how much|how soon|quote|quotation|estimate|pricing|cost|price for|available to|when can you|book(?:ing)?|arrange(?: a)? visit|site visit|cenov\w* nabidk\w*|kolik|potrebuji|potreboval|muzes|mohli byste|wycena|ile kosztuje|potrzebuje)\b/i;
const TRANSACTION = /\b(?:invoice|invoicing|deposit|payment|bank transfer|paid the invoice|faktura|fakturu|zaloha|platba|fakture|zaliczka)\b/i;
const SCHEDULE = /\b(?:tomorrow|saturday|sunday|monday|tuesday|wednesday|thursday|friday|next week|this week|what time|which day|at \d{1,2}(?::\d{2})?|\d{1,2}(?:st|nd|rd|th)? (?:november|december|january|february|march|april|may|june|july|august|september|october)|zit(?:ra|rek)|sobot\w*|pondel\w*|wtorek|jutro)\b/i;

function isExplicitWorkRequest(text: string): boolean {
  // "How much to trim the hedge?" and "Please quote for the patio" qualify;
  // "I love gardening" and "a personal invoice" do not.
  return (SERVICE.test(text) && REQUEST.test(text)) ||
    (TRANSACTION.test(text) && /\b(?:my|our|the|your|send|paid|pay|received|overdue|outstanding|price|amount|payment|invoice|faktura|platba)\b/i.test(text));
}

export function triageWhatsAppConversation(
  messages: WhatsAppTriageMessage[],
  sender: WhatsAppSenderReview | null = null,
): WhatsAppTriageResult {
  const reviewStatus = sender?.reviewStatus ?? "pending";
  if (reviewStatus === "rejected" || reviewStatus === "deleted_from_crm" ||
      (reviewStatus === "approved" && sender?.reviewClassification !== "customer")) {
    return { decision: "ignore", reason: "explicit_non_customer" };
  }

  const newestFirst = [...messages].filter((message) => Number.isFinite(message.receivedAt.getTime()))
    .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime())
    .slice(0, MAX_CONTEXT_MESSAGES);
  if (!newestFirst.length) return { decision: "ignore", reason: "insufficient_work_context" };

  const cutoff = newestFirst[0].receivedAt.getTime() - CONTEXT_DAYS * 86_400_000;
  const recent = newestFirst.filter((message) => message.receivedAt.getTime() >= cutoff).map((message) => normalize(message.text));
  const explicitRequest = recent.some(isExplicitWorkRequest);
  const serviceContext = recent.some((message) => SERVICE.test(message));
  // An earlier clear work request can make a subsequent "Saturday 14th?"
  // meaningful, without treating a standalone "tomorrow" as an enquiry.
  const contextualScheduling = explicitRequest && serviceContext && recent.slice(0, 3).some((message) => SCHEDULE.test(message));

  if (!explicitRequest && !contextualScheduling) {
    return { decision: "ignore", reason: "insufficient_work_context" };
  }
  if (reviewStatus === "approved" && sender?.reviewClassification === "customer") {
    return { decision: "actionable", reason: "confirmed_customer_work" };
  }
  return { decision: "review", reason: "possible_new_enquiry" };
}
