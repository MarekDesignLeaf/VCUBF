/**
 * Explainable, read-only classification for WhatsApp attention.
 *
 * The classifier never changes CRM data, resolves an intake or sends a reply.
 * Human sender labels win over inference. Text and real company records are
 * combined conservatively: a linked customer or job supports a work reading,
 * but cannot turn "happy birthday" into a work request by itself.
 */
export type WhatsAppAttentionDecision = "actionable" | "review" | "ignore";
export type WhatsAppWorkRelevance = "work" | "personal" | "mixed" | "uncertain";
export type WhatsAppActionNeed = "needs_action" | "no_action" | "uncertain";
export type WhatsAppTriageConfidence = "high" | "medium" | "low";

export type WhatsAppTriageReasonCode =
  | "manual_personal_override"
  | "manual_business_role"
  | "manual_non_customer_override"
  | "confirmed_customer"
  | "exact_sender_phone"
  | "linked_crm_contact"
  | "linked_crm_client"
  | "exact_open_lead"
  | "active_job"
  | "active_quote"
  | "open_invoice"
  | "open_task"
  | "service_context"
  | "quote_or_price_request"
  | "scope_or_change_request"
  | "schedule_or_visit_request"
  | "site_address_or_access"
  | "materials_or_dimensions"
  | "delivery_or_order"
  | "invoice_or_payment"
  | "complaint_or_repair"
  | "contextual_short_reply"
  | "repeated_work_context"
  | "personal_topic"
  | "mixed_topics"
  | "attachment_caption_support"
  | "attachment_without_context"
  | "outgoing_reply_recorded"
  | "marked_resolved"
  | "completion_or_thanks"
  | "insufficient_context";

export interface WhatsAppTriageMessage {
  text: string;
  receivedAt: Date;
  /** False means a person has explicitly marked this intake handled. */
  resolutionNeeded?: boolean;
  /** A Secretary reply recorded in source metadata for this exact message. */
  hasOutgoingReply?: boolean;
  /** Provider metadata only; the attachment's contents are never guessed. */
  attachmentType?: string | null;
}

export interface WhatsAppSenderReview {
  reviewStatus?: string | null;
  reviewClassification?: string | null;
  /** Exact normalized phone within one WhatsApp connector source. */
  exactPhoneMatch?: boolean;
  linkedContact?: boolean;
  linkedClient?: boolean;
  exactOpenLead?: boolean;
  activeJobCount?: number;
  activeQuoteCount?: number;
  openInvoiceCount?: number;
  openTaskCount?: number;
}

export interface WhatsAppTriageResult {
  decision: WhatsAppAttentionDecision;
  reason:
    | "confirmed_customer_work"
    | "known_business_contact_work"
    | "possible_new_enquiry"
    | "explicit_non_customer"
    | "no_action_needed"
    | "insufficient_work_context";
  relevance: WhatsAppWorkRelevance;
  actionNeed: WhatsAppActionNeed;
  confidence: WhatsAppTriageConfidence;
  /** Stable, non-sensitive reason codes suitable for an explanation/audit UI. */
  reasons: WhatsAppTriageReasonCode[];
}

export const WHATSAPP_TRIAGE_MAX_CONTEXT_MESSAGES = 12;
export const WHATSAPP_TRIAGE_CONTEXT_DAYS = 21;

function normalize(value: string): string {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase("en")
    .replace(/[’']/g, "'").replace(/\s+/g, " ").trim();
}

// Service language is evidence of subject matter, never proof that action is
// needed. English and Czech variants cover the actual supported owner/client
// languages; common unambiguous misspellings are included where useful.
const SERVICE = /\b(?:garden(?:s|ing|er)?|landscap(?:e|ing|er)|lawn|turf|hedge|tree|stump|prun(?:e|ing)|mow(?:ing)?|weed(?:ing)?|plant(?:ing|s)?|shrub|soil|topsoil|patio|paving|driveway|decking|fenc(?:e|ing)|slabs?|pergola|gravel|retaining wall|raised bed|artificial grass|irrigation|drainage|shed|zahrad\w*|travnik\w*|zivy plot|strom\w*|secen\w*|posekat|pleti|vysadb\w*|ker\w*|dlazb\w*|teras\w*|pergol\w*|zavlah\w*|drenaz\w*)\b/i;
const QUOTE_PRICE = /\b(?:quote|quotation|qoute|estimate|estimat(?:e|ion)|price|pricing|cost|how much|budget|cenov\w* nabidk\w*|nabidk\w*|odh?ad|kolik|cena|rozpocet)\b/i;
const REQUEST = /\b(?:can you|could you|would you|are you able|please|i need|we need|looking for|want you to|need you to|send me|let me know|muzes|muzete|mohli byste|prosim|potrebuji|potreboval|chtel bych|posli|dejte vedet)\b/i;
const SCOPE_CHANGE = /\b(?:scope|extra work|additional work|change|variation|extend|extension|replace|remove|install|build|lay|fit|trim|cut|design|redesign|plan|drawing|specification|rozsah|viceprac\w*|zmen\w*|rozsirit|vymenit|odstranit|instal\w*|postavit|polozit|ostrihat|navrh\w*|plan\w*)\b/i;
const SCHEDULE_VISIT = /\b(?:appointment|book(?:ing)?|arrange|available|availability|when can|what time|which day|come (?:over|round|by)|visit|site visit|survey|measure(?:ment)?|tomorrow|today|next week|this week|monday|tuesday|wednesday|thursday|friday|saturday|sunday|at \d{1,2}(?::\d{2})?|schuzk\w*|termin\w*|objednat|kdy muz|prijet|navstev\w*|obhlidk\w*|zameren\w*|zit(?:ra|rek)|dnes|pristi tyden|pondel\w*|uter\w*|stred\w*|ctvrtek|patek|sobot\w*|nedel\w*|v \d{1,2}(?::\d{2})?)\b/i;
const SITE_ACCESS = /\b(?:site|property|job address|site address|postcode|post code|address|access|gate|key|parking|side entrance|on site|stavb\w*|adresa|misto|pristup|brana|branka|klic|parkovani|vjezd)\b/i;
const MATERIAL_DIMENSIONS = /\b(?:material|materials|timber|wood|stone|slab|brick|concrete|cement|sand|gravel|soil|plant(?:s)?|quantity|quantities|dimension|dimensions|measurements?|metres?|meters?|millimetres?|millimeters?|\d+(?:[.,]\d+)?\s*(?:m2|m²|sqm|mm|cm|m)\b|material\w*|drevo|kamen|dlazb\w*|beton|cement|pisek|sterk|zemin\w*|mnozstv\w*|rozmer\w*|metr\w*)\b/i;
const DELIVERY_ORDER = /\b(?:deliver(?:y|ed)?|collection|collect|order(?:ed|ing)?|supplier|stock|lead time|dispatch|dodat|dodavk\w*|vyzvedn\w*|objednavk\w*|objednat|dodavatel|skladem)\b/i;
const INVOICE_PAYMENT = /\b(?:invoice|invoicing|deposit|payment|bank transfer|paid|pay|balance|outstanding|overdue|receipt|refund|faktur\w*|zaloh\w*|platb\w*|prevod|zaplac\w*|doplatek|dluzn\w*|uctenk\w*|vracen\w*)\b/i;
const COMPLAINT_REPAIR = /\b(?:complaint|problem|issue|wrong|broken|damag(?:e|ed)|leak|flood|poor work|not working|repair|fix|remedial|come back|reklamac\w*|problem|spatn\w*|rozbit\w*|poskozen\w*|proteka|nefunguje|oprav\w*|naprav\w*)\b/i;
const PERSONAL = /\b(?:family|mum|mom|dad|brother|sister|birthday|wedding|holiday|vacation|dinner|lunch|pub|beer|party|football|cinema|concert|school|kids?|love you|miss you|happy birthday|rodin\w*|mamk\w*|tatk\w*|bratr|sestra|narozenin\w*|svatb\w*|dovolen\w*|vecer\w*|obed|hospod\w*|pivo|oslav\w*|fotbal|kino|koncert|skol\w*|deti|miluju|chybi mi)\b/i;
const COMPLETION = /\b(?:done|sorted|resolved|finished|completed|fixed|all good|no longer needed|do not need|don't need|cancel(?:led)?|received it|got it|paid it|thank you|thanks|cheers|hotovo|vyresen\w*|dokonc\w*|opraven\w*|v poradku|uz neni treba|nepotrebuji|zrus\w*|dorazilo|dostal jsem|zaplaceno|dekuji|diky)\b/i;
const SHORT_AFFIRMATION = /^(?:yes|yeah|yep|ok|okay|fine|great|sounds good|that works|agreed|confirmed|ano|jo|jasne|dobre|super|plati|souhlasim)[.!? ]*$/i;
const SHORT_THANKS = /^(?:thank you|thanks|cheers|dekuji|diky|dik)[.!? 🙂😊👍🙏❤️❤]*$/iu;
const MEDIA_PLACEHOLDER = /^\[whatsapp (?:image|video|audio|document|sticker|reaction|unknown)\](?:\s+(.*))?$/i;

interface MessageEvidence {
  reasons: WhatsAppTriageReasonCode[];
  workSubject: boolean;
  explicitAction: boolean;
  personal: boolean;
  completion: boolean;
  shortFollowUp: boolean;
  shortThanks: boolean;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function evidence(textValue: string, attachmentType?: string | null): MessageEvidence {
  const text = normalize(textValue);
  const reasons: WhatsAppTriageReasonCode[] = [];
  const media = text.match(MEDIA_PLACEHOLDER);
  const caption = media?.[1]?.trim() ?? "";
  const content = caption || text;
  const attachmentOnly = Boolean(attachmentType || media) && !caption;
  if (attachmentOnly) reasons.push("attachment_without_context");

  const service = SERVICE.test(content);
  const quote = QUOTE_PRICE.test(content);
  const request = REQUEST.test(content);
  const scope = SCOPE_CHANGE.test(content);
  const schedule = SCHEDULE_VISIT.test(content);
  const site = SITE_ACCESS.test(content);
  const materials = MATERIAL_DIMENSIONS.test(content);
  const delivery = DELIVERY_ORDER.test(content);
  const invoice = INVOICE_PAYMENT.test(content);
  const complaint = COMPLAINT_REPAIR.test(content);
  const personal = PERSONAL.test(content);
  const completion = COMPLETION.test(content);
  const businessScope = scope && (service || complaint ||
    /\b(?:scope|extra work|additional work|variation|drawing|specification|rozsah|viceprac\w*)\b/i.test(content));
  const businessSchedule = schedule && (service || businessScope || site || materials || delivery || invoice || complaint ||
    /\b(?:appointment|book(?:ing)?|arrange|site visit|survey|measure(?:ment)?|schuzk\w*|termin\w*|obhlidk\w*|zameren\w*)\b/i.test(content));

  if (service) reasons.push("service_context");
  if (quote && (request || service || /\b(?:send|need|want|for)\b/i.test(content))) reasons.push("quote_or_price_request");
  if (businessScope && (request || service || complaint)) reasons.push("scope_or_change_request");
  if (businessSchedule && (request || /\b(?:appointment|book|arrange|when|what time|which day|termin|schuzk|kdy)\b/i.test(content))) reasons.push("schedule_or_visit_request");
  if (site) reasons.push("site_address_or_access");
  if (materials) reasons.push("materials_or_dimensions");
  if (delivery) reasons.push("delivery_or_order");
  if (invoice) reasons.push("invoice_or_payment");
  if (complaint) reasons.push("complaint_or_repair");
  if (personal) reasons.push("personal_topic");
  if (media && caption && (service || quote || scope || schedule || site || materials || delivery || invoice || complaint)) {
    reasons.push("attachment_caption_support");
  }

  const workSubject = service || quote || businessScope || site || materials || delivery || invoice || complaint;
  const explicitAction =
    reasons.includes("quote_or_price_request") ||
    reasons.includes("scope_or_change_request") ||
    reasons.includes("schedule_or_visit_request") ||
    (request && service) ||
    (request && (site || materials || delivery || invoice || complaint)) ||
    (complaint && (service || request));

  return {
    reasons: unique(reasons), workSubject, explicitAction, personal, completion,
    shortFollowUp: SHORT_AFFIRMATION.test(text) || (text.length <= 45 && schedule),
    shortThanks: SHORT_THANKS.test(text),
  };
}

function businessContextReasons(sender: WhatsAppSenderReview | null): WhatsAppTriageReasonCode[] {
  if (!sender) return [];
  const reasons: WhatsAppTriageReasonCode[] = [];
  if (sender.exactPhoneMatch) reasons.push("exact_sender_phone");
  if (sender.linkedContact) reasons.push("linked_crm_contact");
  if (sender.linkedClient) reasons.push("linked_crm_client");
  if (sender.exactOpenLead) reasons.push("exact_open_lead");
  if ((sender.activeJobCount ?? 0) > 0) reasons.push("active_job");
  if ((sender.activeQuoteCount ?? 0) > 0) reasons.push("active_quote");
  if ((sender.openInvoiceCount ?? 0) > 0) reasons.push("open_invoice");
  if ((sender.openTaskCount ?? 0) > 0) reasons.push("open_task");
  return reasons;
}

function result(
  decision: WhatsAppAttentionDecision,
  reason: WhatsAppTriageResult["reason"],
  relevance: WhatsAppWorkRelevance,
  actionNeed: WhatsAppActionNeed,
  confidence: WhatsAppTriageConfidence,
  reasons: WhatsAppTriageReasonCode[],
): WhatsAppTriageResult {
  return { decision, reason, relevance, actionNeed, confidence, reasons: unique(reasons) };
}

export function triageWhatsAppConversation(
  messages: WhatsAppTriageMessage[],
  sender: WhatsAppSenderReview | null = null,
): WhatsAppTriageResult {
  const reviewStatus = sender?.reviewStatus ?? "pending";
  const classification = sender?.reviewClassification ?? null;

  // A human's explicit personal/excluded decision has precedence over every
  // inferred keyword. The review workflow can reopen/correct it later.
  if (classification === "personal") {
    return result("ignore", "explicit_non_customer", "personal", "no_action", "high", ["manual_personal_override"]);
  }
  if (reviewStatus === "deleted_from_crm" ||
      (reviewStatus === "rejected" && !["employee", "subcontractor", "supplier"].includes(classification ?? "")) ||
      (reviewStatus === "approved" && classification !== "customer")) {
    return result("ignore", "explicit_non_customer", "uncertain", "no_action", "high", ["manual_non_customer_override"]);
  }

  const newestFirst = [...messages]
    .filter((message) => Number.isFinite(message.receivedAt.getTime()))
    .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime())
    .slice(0, WHATSAPP_TRIAGE_MAX_CONTEXT_MESSAGES);
  if (!newestFirst.length) {
    return result("ignore", "insufficient_work_context", "uncertain", "uncertain", "low", ["insufficient_context"]);
  }

  const cutoff = newestFirst[0].receivedAt.getTime() - WHATSAPP_TRIAGE_CONTEXT_DAYS * 86_400_000;
  const recent = newestFirst.filter((message) => message.receivedAt.getTime() >= cutoff);
  const evidences = recent.map((message) => evidence(message.text, message.attachmentType));
  const latestMessage = recent[0];
  const latest = evidences[0];
  const prior = evidences.slice(1);
  const priorWork = prior.some((item) => item.explicitAction || item.workSubject);
  const priorPersonal = prior.some((item) => item.personal);
  const contextReasons = businessContextReasons(sender);
  const hasBusinessRecordContext = contextReasons.some((code) =>
    ["linked_crm_client", "exact_open_lead", "active_job", "active_quote", "open_invoice", "open_task"].includes(code));
  const businessRole = classification === "customer" || ["employee", "subcontractor", "supplier"].includes(classification ?? "");
  const contextualFollowUp = !latest.explicitAction && latest.shortFollowUp && (priorWork || hasBusinessRecordContext);
  const workRelevant = latest.workSubject || latest.explicitAction || contextualFollowUp;
  const personalRelevant = latest.personal;

  const reasons = [...contextReasons, ...latest.reasons];
  if (classification === "customer") reasons.push("confirmed_customer");
  else if (["employee", "subcontractor", "supplier"].includes(classification ?? "")) reasons.push("manual_business_role");
  if (contextualFollowUp) reasons.push("contextual_short_reply");
  if (prior.filter((item) => item.workSubject || item.explicitAction).length >= 2) reasons.push("repeated_work_context");
  if ((workRelevant && (personalRelevant || priorPersonal)) || (!workRelevant && personalRelevant && priorWork)) reasons.push("mixed_topics");

  const relevance: WhatsAppWorkRelevance = workRelevant
    ? (personalRelevant || priorPersonal ? "mixed" : "work")
    : personalRelevant
      ? (priorWork ? "mixed" : "personal")
      : "uncertain";

  // Latest explicit handling evidence wins over an older request. A reply or
  // resolved flag is a fact; "thanks"/completion is a conservative inference.
  const handled = latestMessage.resolutionNeeded === false || latestMessage.hasOutgoingReply === true;
  const completed = latest.completion || latest.shortThanks;
  if (latestMessage.hasOutgoingReply) reasons.push("outgoing_reply_recorded");
  if (latestMessage.resolutionNeeded === false) reasons.push("marked_resolved");
  if (completed) reasons.push("completion_or_thanks");

  const actionNeed: WhatsAppActionNeed = handled || completed
    ? "no_action"
    : latest.explicitAction || contextualFollowUp
      ? "needs_action"
      : "uncertain";

  if (actionNeed === "no_action" && (workRelevant || priorWork)) {
    return result("ignore", "no_action_needed", relevance === "uncertain" ? "work" : relevance, actionNeed, handled ? "high" : "medium", reasons);
  }

  if (workRelevant && actionNeed === "needs_action") {
    if (businessRole) {
      return result(
        "actionable",
        classification === "customer" ? "confirmed_customer_work" : "known_business_contact_work",
        relevance,
        actionNeed,
        latest.explicitAction ? "high" : "medium",
        reasons,
      );
    }
    return result("review", "possible_new_enquiry", relevance, actionNeed, latest.explicitAction ? "medium" : "low", reasons);
  }

  // An explicit personal topic starts a new topic even if older messages or
  // customer records concern work. Those records remain supporting context,
  // never a reason to promote the personal message.
  if (!workRelevant) {
    return result(
      "ignore",
      "insufficient_work_context",
      relevance,
      personalRelevant ? "no_action" : "uncertain",
      personalRelevant ? "medium" : "low",
      [...reasons, "insufficient_context"],
    );
  }

  return result("ignore", "no_action_needed", relevance, actionNeed, "low", reasons);
}
