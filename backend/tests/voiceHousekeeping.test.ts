import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import request from "supertest";
import { prisma } from "../src/db.js";
import { createServer } from "../src/server.js";
import { resetDb, seedCompanyAndAdmin } from "./setup.js";

// The speaker's own voice housekeeping, said instead of clicked (Marek,
// 12. 10.: "všechno v aplikaci hlasem"): the saved conversations deleted and a
// learned spelling forgotten. Both are read back; nothing goes before the yes.

const app = createServer();

describe("Voice housekeeping by voice", () => {
  let token = "";
  const say = (text: string) => request(app).post("/command/assistant").set("Authorization", `Bearer ${token}`).send({ text, input_method: "voice_transcript" });
  const as = () => ({ Authorization: `Bearer ${token}` });

  before(async () => {
    await resetDb();
    await seedCompanyAndAdmin();
    token = (await request(app).post("/auth/login").send({ email: "admin@test.local", password: "Password123!" })).body.token;
  });

  after(async () => {
    await resetDb();
    await prisma.$disconnect();
  });

  it("says there is nothing to delete when no conversation is saved, and puts up no review", async () => {
    const response = await say("voice action clear_voice_history {}");
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.message, "There are no saved conversations to delete.");
    const pending = await prisma.voicePendingAction.count({ where: { actionType: "emma_universal_action", status: "pending" } });
    assert.equal(pending, 0);
  });

  it("reads back how many conversations go and deletes them only after the yes", async () => {
    const admin = await prisma.user.findFirstOrThrow({ where: { email: "admin@test.local" } });
    const started = await request(app).post("/command/voice-conversations").set(as()).send({ mode: "realtime" });
    await request(app).post(`/command/voice-conversations/${started.body.id}/messages`).set(as()).send({ role: "user", content: "Show my jobs.", sequence: 1 }).expect(201);

    const review = await say("voice action clear_voice_history {}");
    assert.equal(review.status, 409, JSON.stringify(review.body));
    assert.equal(review.body.message, "I will delete all your saved conversations with me, 1 conversation in total. This conversation will end too, and it cannot be undone. Shall I delete them?");
    assert.equal(await prisma.voiceConversation.count({ where: { userId: admin.id } }), 1, "nothing is deleted before the yes");

    const yes = await say("yes");
    assert.equal(yes.status, 200, JSON.stringify(yes.body));
    assert.equal(yes.body.message, "Your conversation history has been deleted.");
    assert.equal(await prisma.voiceConversation.count({ where: { userId: admin.id } }), 0);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { actionName: "clear_voice_device_history" }, orderBy: { createdAt: "desc" } });
    assert.equal(audit.confirmed, true);
    assert.deepEqual(audit.inputPayload, { via: "voice" });
    assert.deepEqual(audit.dataBefore, { conversations: 1, messages: 1, pendingEmails: 0 });
  });

  it("answers the review it read out when an email is waiting for a yes too", async () => {
    // Two reviews at once: a bare yes would be a guess. The client says which
    // review it read out (review_id), and that one is answered.
    const admin = await prisma.user.findFirstOrThrow({ where: { email: "admin@test.local" } });
    await request(app).post("/command/voice-conversations").set(as()).send({ mode: "realtime" }).expect(201);
    const email = await prisma.voicePendingAction.create({
      data: { companyId: admin.companyId, userId: admin.id, actionType: "send_gmail_message", payload: { subject: "Draft" }, expiresAt: new Date(Date.now() + 300_000) },
    });
    const review = await say("voice action clear_voice_history {}");
    assert.equal(review.status, 409, JSON.stringify(review.body));
    assert.match(review.body.message, /, and withdraw the email waiting for your yes\. /);
    const heard = review.body.pendingReview?.id;
    assert.ok(heard, "the client is told which review it read out");

    const yes = await request(app).post("/command/assistant").set(as()).send({ text: "yes", input_method: "voice_transcript", review_id: heard });
    assert.equal(yes.status, 200, JSON.stringify(yes.body));
    assert.equal(yes.body.message, "Your conversation history has been deleted.");
    assert.equal(await prisma.voiceConversation.count({ where: { userId: admin.id } }), 0);
    assert.equal((await prisma.voicePendingAction.findUniqueOrThrow({ where: { id: email.id } })).status, "cancelled", "the email that was read out as withdrawn is withdrawn");
  });

  it("withdraws the email waiting for a yes when the page clears the history, as voice does", async () => {
    const admin = await prisma.user.findFirstOrThrow({ where: { email: "admin@test.local" } });
    const email = await prisma.voicePendingAction.create({
      data: { companyId: admin.companyId, userId: admin.id, actionType: "send_gmail_message", payload: { subject: "Draft" }, expiresAt: new Date(Date.now() + 300_000) },
    });
    await request(app).delete("/command/voice-state/history").set(as()).expect(200);
    assert.equal((await prisma.voicePendingAction.findUniqueOrThrow({ where: { id: email.id } })).status, "cancelled");
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { actionName: "clear_voice_device_history" }, orderBy: { createdAt: "desc" } });
    assert.deepEqual(audit.inputPayload, { via: "page" });
    assert.equal(audit.confirmed, false, "the page asks in the browser; the server does not see that yes");
  });

  it("forgets a learned spelling of the name after the yes, though the spelling itself is rewritten before it is understood", async () => {
    // Active, so "Alfons" in the sentence is rewritten to "Alfonzo" before
    // parsing; the word actually spoken still names the alias.
    const saved = await request(app).post("/command/aliases").set(as()).send({ heard: "Alfons", means: "Alfonzo", category: "wake_word" });
    assert.equal(saved.status, 201, JSON.stringify(saved.body));

    const review = await say('voice action remove_voice_alias {"heard":"Alfons"}');
    assert.equal(review.status, 409, JSON.stringify(review.body));
    assert.equal(review.body.message, "I will forget “alfons”, which I have been taking as “Alfonzo”. Shall I remove it?");
    assert.ok(await prisma.learningRule.findUnique({ where: { id: saved.body.alias.id } }), "nothing is removed before the yes");

    const yes = await say("yes");
    assert.equal(yes.status, 200, JSON.stringify(yes.body));
    assert.equal(yes.body.message, "I have forgotten “alfons”.");
    assert.equal(await prisma.learningRule.findUnique({ where: { id: saved.body.alias.id } }), null);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { actionName: "delete_voice_alias" } });
    assert.deepEqual(audit.dataBefore, { term: "alfons", aliasFor: "Alfonzo", category: "wake_word", status: "active" });
  });

  it("says a word it has not learned was not found", async () => {
    const response = await say('voice action remove_voice_alias {"heard":"Bohumil"}');
    assert.equal(response.body.error, "RECORD_NOT_FOUND");
    assert.equal(response.body.message, "I could not find a learned word called “Bohumil”.");
  });

  it("renames the company only after reading both names back, and says when the name is already that", async () => {
    // The Company page's one field, said instead: every quote and invoice carries it.
    const admin = await prisma.user.findFirstOrThrow({ where: { email: "admin@test.local" } });
    const before = (await prisma.company.findUniqueOrThrow({ where: { id: admin.companyId } })).name;
    const review = await say("Rename the company to Northwind Gardens Ltd.");
    assert.equal(review.status, 409, JSON.stringify(review.body));
    assert.equal(review.body.message, `I will rename the company from “${before}” to “Northwind Gardens Ltd”. Quotes, invoices and outgoing messages will carry the new name. Shall I save it?`);
    assert.equal((await prisma.company.findUniqueOrThrow({ where: { id: admin.companyId } })).name, before, "nothing changes before the yes");

    const yes = await say("yes");
    assert.equal(yes.status, 200, JSON.stringify(yes.body));
    assert.equal(yes.body.message, "The company is now called “Northwind Gardens Ltd”.");
    assert.equal((await prisma.company.findUniqueOrThrow({ where: { id: admin.companyId } })).name, "Northwind Gardens Ltd");
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { actionName: "update_company_profile" }, orderBy: { createdAt: "desc" } });
    assert.deepEqual(audit.dataBefore, { name: before });
    assert.equal(audit.confirmed, true);

    const same = await say('voice action rename_company {"name":"Northwind Gardens Ltd"}');
    assert.equal(same.body.error, "COMPANY_NAME_UNCHANGED");
    assert.equal(same.body.message, "The company is already called “Northwind Gardens Ltd”; nothing was changed.");
  });

  it("removes only aliases through the alias page, never another learning rule", async () => {
    const admin = await prisma.user.findFirstOrThrow({ where: { email: "admin@test.local" } });
    const rule = await prisma.learningRule.create({ data: { companyId: admin.companyId, term: "pergola", meaning: "A garden structure we build." } });
    const refused = await request(app).delete(`/command/aliases/${rule.id}`).set(as());
    assert.equal(refused.status, 404);
    assert.ok(await prisma.learningRule.findUnique({ where: { id: rule.id } }));
  });
});
