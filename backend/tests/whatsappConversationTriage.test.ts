import assert from "node:assert/strict";
import { test } from "node:test";
import { triageWhatsAppConversation, type WhatsAppTriageMessage } from "../src/lib/whatsappConversationTriage.js";

const at = (
  text: string,
  daysAgo = 0,
  extra: Partial<Omit<WhatsAppTriageMessage, "text" | "receivedAt">> = {},
): WhatsAppTriageMessage => ({
  text,
  receivedAt: new Date(Date.UTC(2026, 10, 10 - daysAgo, 12, 0, 0)),
  ...extra,
});

const customer = {
  reviewStatus: "approved",
  reviewClassification: "customer",
  exactPhoneMatch: true,
};

test("a human personal label overrides even convincing work keywords", () => {
  const result = triageWhatsAppConversation(
    [at("Can you give me a quote for my garden?")],
    { reviewStatus: "rejected", reviewClassification: "personal" },
  );
  assert.equal(result.decision, "ignore");
  assert.equal(result.reason, "explicit_non_customer");
  assert.equal(result.relevance, "personal");
  assert.deepEqual(result.reasons, ["manual_personal_override"]);
});

test("ordinary personal chat with a service word is not a business enquiry", () => {
  const result = triageWhatsAppConversation([at("I love gardening and my trees.")]);
  assert.equal(result.decision, "ignore");
  assert.equal(result.actionNeed, "uncertain");
});

test("an unknown new customer with an explicit request is reviewed, not auto-imported", () => {
  const result = triageWhatsAppConversation([at("Could you give me a qoute for the patio extension?")]);
  assert.equal(result.decision, "review");
  assert.equal(result.reason, "possible_new_enquiry");
  assert.equal(result.relevance, "work");
  assert.equal(result.actionNeed, "needs_action");
  assert.ok(result.reasons.includes("quote_or_price_request"));
  assert.ok(result.reasons.includes("scope_or_change_request"));
});

test("verified CRM relationships support but do not replace explicit work content", () => {
  const result = triageWhatsAppConversation(
    [at("Can you come and trim my hedge next week?")],
    {
      ...customer,
      linkedContact: true,
      linkedClient: true,
      activeJobCount: 1,
      activeQuoteCount: 1,
      openInvoiceCount: 1,
      openTaskCount: 1,
    },
  );
  assert.equal(result.decision, "actionable");
  assert.equal(result.reason, "confirmed_customer_work");
  assert.equal(result.confidence, "high");
  assert.ok(result.reasons.includes("exact_sender_phone"));
  assert.ok(result.reasons.includes("linked_crm_client"));
  assert.ok(result.reasons.includes("active_job"));
  assert.ok(result.reasons.includes("active_quote"));
  assert.ok(result.reasons.includes("open_invoice"));
  assert.ok(result.reasons.includes("open_task"));
});

test("a supplier, subcontractor or employee can have actionable work without becoming a customer lead", () => {
  for (const role of ["supplier", "subcontractor", "employee"]) {
    const result = triageWhatsAppConversation(
      [at("Can you deliver the patio slabs to site tomorrow?")],
      { reviewStatus: "rejected", reviewClassification: role, exactPhoneMatch: true },
    );
    assert.equal(result.decision, "actionable", role);
    assert.equal(result.reason, "known_business_contact_work", role);
    assert.ok(result.reasons.includes("manual_business_role"), role);
  }
});

test("a personal message from a known customer stays personal despite active records", () => {
  const result = triageWhatsAppConversation(
    [at("Happy birthday! See you at dinner 🎉")],
    { ...customer, linkedClient: true, activeJobCount: 2, openTaskCount: 1 },
  );
  assert.equal(result.decision, "ignore");
  assert.equal(result.relevance, "personal");
  assert.equal(result.actionNeed, "no_action");
});

test("an ordinary personal arrangement is not a work visit", () => {
  const result = triageWhatsAppConversation([at("Can you come Tuesday for dinner?")], customer);
  assert.equal(result.decision, "ignore");
  assert.equal(result.relevance, "personal");
});

test("one contact may have mixed personal and work topics", () => {
  const result = triageWhatsAppConversation(
    [at("After dinner, could you quote the new fence please?"), at("See you at the pub", 1)],
    customer,
  );
  assert.equal(result.decision, "actionable");
  assert.equal(result.relevance, "mixed");
  assert.ok(result.reasons.includes("mixed_topics"));
});

test("a new personal topic is not promoted by an older work request", () => {
  const result = triageWhatsAppConversation(
    [at("See you for dinner tonight"), at("Please quote for the garden", 2)],
    customer,
  );
  assert.equal(result.decision, "ignore");
  assert.equal(result.relevance, "mixed");
});

test("a short scheduling reply inherits recent work context", () => {
  const result = triageWhatsAppConversation(
    [at("Yes, tomorrow at 9?"), at("I need a quote for extending the patio.", 2)],
    customer,
  );
  assert.equal(result.decision, "actionable");
  assert.equal(result.actionNeed, "needs_action");
  assert.ok(result.reasons.includes("contextual_short_reply"));
});

test("a short thanks inherits work relevance but is not a new action", () => {
  const result = triageWhatsAppConversation(
    [at("Thanks 👍"), at("Please send a quote for the fence", 1)],
    customer,
  );
  assert.equal(result.decision, "ignore");
  assert.equal(result.reason, "no_action_needed");
  assert.equal(result.relevance, "work");
  assert.equal(result.actionNeed, "no_action");
  assert.ok(result.reasons.includes("completion_or_thanks"));
});

test("a recorded outgoing reply prevents an already answered request becoming urgent", () => {
  const result = triageWhatsAppConversation(
    [at("Can you quote for the patio?", 0, { hasOutgoingReply: true })],
    customer,
  );
  assert.equal(result.decision, "ignore");
  assert.equal(result.actionNeed, "no_action");
  assert.ok(result.reasons.includes("outgoing_reply_recorded"));
});

test("an explicitly resolved latest message is not reopened by classification", () => {
  const result = triageWhatsAppConversation(
    [at("Please repair the broken fence", 0, { resolutionNeeded: false })],
    customer,
  );
  assert.equal(result.decision, "ignore");
  assert.equal(result.actionNeed, "no_action");
  assert.ok(result.reasons.includes("marked_resolved"));
});

test("a work completion is distinct from a still-open request", () => {
  const result = triageWhatsAppConversation(
    [at("The invoice is paid, thank you"), at("Please send the invoice", 1)],
    customer,
  );
  assert.equal(result.decision, "ignore");
  assert.equal(result.reason, "no_action_needed");
  assert.equal(result.actionNeed, "no_action");
});

test("media metadata alone never invents the attachment contents", () => {
  const result = triageWhatsAppConversation([at("[WhatsApp image]", 0, { attachmentType: "image" })]);
  assert.equal(result.decision, "ignore");
  assert.equal(result.relevance, "uncertain");
  assert.ok(result.reasons.includes("attachment_without_context"));
  assert.ok(!result.reasons.includes("service_context"));
});

test("a real attachment caption can support an explicit work request", () => {
  const result = triageWhatsAppConversation([at("[WhatsApp image] Can you quote this damaged patio?", 0, { attachmentType: "image" })]);
  assert.equal(result.decision, "review");
  assert.ok(result.reasons.includes("attachment_caption_support"));
  assert.ok(result.reasons.includes("complaint_or_repair"));
});

test("a work request at the weekend remains work", () => {
  const saturday = new Date(Date.UTC(2026, 10, 7, 21, 30, 0));
  const result = triageWhatsAppConversation(
    [{ text: "Could you price a new pergola for me?", receivedAt: saturday }],
    customer,
  );
  assert.equal(result.decision, "actionable");
  assert.equal(result.relevance, "work");
});

test("a real active job can support a short scheduling follow-up but not a greeting", () => {
  const context = { ...customer, linkedClient: true, activeJobCount: 1 };
  const scheduling = triageWhatsAppConversation([at("Tomorrow at 9?")], context);
  assert.equal(scheduling.decision, "actionable");
  assert.ok(scheduling.reasons.includes("active_job"));
  assert.ok(scheduling.reasons.includes("contextual_short_reply"));

  const greeting = triageWhatsAppConversation([at("Hello, hope you are well")], context);
  assert.equal(greeting.decision, "ignore");
});

test("an exact open lead supports context but does not auto-approve the sender", () => {
  const result = triageWhatsAppConversation(
    [at("Tomorrow?")],
    { reviewStatus: "pending", exactPhoneMatch: true, exactOpenLead: true },
  );
  assert.equal(result.decision, "review");
  assert.equal(result.reason, "possible_new_enquiry");
  assert.ok(result.reasons.includes("exact_open_lead"));
});

test("old work context expires and urgent tone alone is insufficient", () => {
  const oldContext = triageWhatsAppConversation(
    [at("Tomorrow?"), at("Please quote the patio", 50)],
    customer,
  );
  assert.equal(oldContext.decision, "ignore");

  const urgentOnly = triageWhatsAppConversation([at("URGENT!!! Please call me")], customer);
  assert.equal(urgentOnly.decision, "ignore");
  assert.equal(urgentOnly.relevance, "uncertain");
});

test("emoji and friendly wording do not cancel a real work request", () => {
  const result = triageWhatsAppConversation(
    [at("Hi mate 😊 could you please estimate the drainage repair?")],
    customer,
  );
  assert.equal(result.decision, "actionable");
  assert.equal(result.actionNeed, "needs_action");
});
