import assert from "node:assert/strict";
import { test } from "node:test";
import { triageWhatsAppConversation, type WhatsAppTriageMessage } from "../src/lib/whatsappConversationTriage.js";

const at = (text: string, daysAgo = 0): WhatsAppTriageMessage => ({
  text,
  receivedAt: new Date(Date.UTC(2026, 10, 10 - daysAgo, 12, 0, 0)),
});

test("personal WhatsApp chat cannot become a client lead", () => {
  const result = triageWhatsAppConversation(
    [at("Can you give me a quote for my garden?")],
    { reviewStatus: "rejected", reviewClassification: "personal" },
  );
  assert.equal(result.decision, "ignore");
  assert.equal(result.reason, "explicit_non_customer");
});

test("ordinary chat with a work-related word is not a business enquiry", () => {
  assert.equal(
    triageWhatsAppConversation([at("I love gardening and my trees."), at("See you tomorrow!")]).decision,
    "ignore",
  );
});

test("a pending sender with an explicit request is for human review, not auto-import", () => {
  assert.equal(
    triageWhatsAppConversation([at("Could you give me a quote for the patio extension?")]).decision,
    "review",
  );
});

test("an approved customer with a specific work request gets one actionable conversation", () => {
  assert.equal(
    triageWhatsAppConversation(
      [at("Can you come and trim my hedge next week?")],
      { reviewStatus: "approved", reviewClassification: "customer" },
    ).decision,
    "actionable",
  );
});

test("short scheduling follow-up inherits recent work context", () => {
  assert.equal(
    triageWhatsAppConversation(
      [at("Saturday 14th?"), at("I need a quote for extending the patio.", 2)],
      { reviewStatus: "approved", reviewClassification: "customer" },
    ).decision,
    "actionable",
  );
});

test("old work discussions do not contaminate a recent personal topic", () => {
  assert.equal(
    triageWhatsAppConversation(
      [at("See you for dinner"), at("Please send a quote for my fence", 50)],
      { reviewStatus: "approved", reviewClassification: "customer" },
    ).decision,
    "ignore",
  );
});

test("a recent business discussion does not make a new personal topic actionable", () => {
  assert.equal(
    triageWhatsAppConversation(
      [at("See you for dinner tonight"), at("Please quote for the garden", 2)],
      { reviewStatus: "approved", reviewClassification: "customer" },
    ).decision,
    "ignore",
  );
});

test("employee conversation never creates a customer sales alert", () => {
  assert.equal(
    triageWhatsAppConversation(
      [at("Can you bring the hedge trimmer tomorrow?")],
      { reviewStatus: "rejected", reviewClassification: "employee" },
    ).decision,
    "ignore",
  );
});

test("unsupported WhatsApp media is not a new sales enquiry", () => {
  assert.equal(
    triageWhatsAppConversation([at("[WhatsApp audio]"), at("[WhatsApp reaction]")]).decision,
    "ignore",
  );
});
