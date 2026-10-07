import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { REPEAT_WINDOW_MS, recentReply, repeatNote, sendFingerprint } from "../src/lib/repeatedSend.js";

// Recognising "the same message again" after a request that got no answer in
// time. The fingerprint is what the audit keeps instead of the words.

describe("Recognising a repeated send", () => {
  it("treats the same recipients and words as one message, however written", () => {
    const base = sendFingerprint({ recipients: ["Jan@Example.com", "eva@example.com"], subject: "Plot", body: "We will come on Monday." });
    assert.equal(sendFingerprint({ recipients: ["eva@example.com", " jan@example.com"], subject: "Plot ", body: "We will  come on\nMonday." }), base);
    assert.notEqual(sendFingerprint({ recipients: ["jan@example.com", "eva@example.com"], subject: "Plot", body: "We will come on Tuesday." }), base);
    assert.notEqual(sendFingerprint({ recipients: ["jan@example.com"], subject: "Plot", body: "We will come on Monday." }), base);
    assert.notEqual(sendFingerprint({ recipients: ["jan@example.com", "eva@example.com"], subject: "Fence", body: "We will come on Monday." }), base);
    assert.match(base, /^[0-9a-f]{64}$/);
  });

  it("depends on the server's key, so a guessed message cannot be matched against the audit", () => {
    const original = process.env.JWT_SECRET;
    try {
      process.env.JWT_SECRET = "first-key";
      const first = sendFingerprint({ recipients: ["jan@example.com"], body: "Thank you." });
      process.env.JWT_SECRET = "second-key";
      assert.notEqual(sendFingerprint({ recipients: ["jan@example.com"], body: "Thank you." }), first);
    } finally {
      if (original === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = original;
    }
  });

  it("finds an identical reply sent within the window, and says how long ago", () => {
    const now = Date.parse("2026-10-07T21:30:00.000Z");
    const metadata = {
      replies: [
        { body: "Thank you.", sentAt: "2026-10-07T21:27:10.000Z" },
        { body: "Thank  you.", sentAt: "2026-10-07T21:20:00.000Z" },
        { body: "Something else.", sentAt: "2026-10-07T21:29:00.000Z" },
      ],
    };
    assert.deepEqual(recentReply(metadata, "Thank you.", now), { sentAt: "2026-10-07T21:27:10.000Z", minutesAgo: 2 }, "the latest identical one");
    assert.equal(recentReply(metadata, "Thanks.", now), null);
    const old = { replies: [{ body: "Thank you.", sentAt: new Date(now - REPEAT_WINDOW_MS - 1000).toISOString() }] };
    assert.equal(recentReply(old, "Thank you.", now), null, "older than the window is not 'just sent'");
    assert.equal(recentReply(null, "Thank you.", now), null);
    assert.equal(recentReply({ replies: [{ body: "Thank you." }] }, "Thank you.", now), null, "a reply with no time is not counted");
  });

  it("adds the note to a review only when there is something to say", () => {
    assert.deepEqual(repeatNote(null), {});
    assert.deepEqual(repeatNote({ sentAt: "2026-10-07T21:27:10.000Z", minutesAgo: 2 }), { alreadySent: { sentAt: "2026-10-07T21:27:10.000Z", minutesAgo: 2 } });
  });
});
