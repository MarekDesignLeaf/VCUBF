import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import request from "supertest";
import { createServer } from "../src/server.js";
import { prisma } from "../src/db.js";
import { resetDb, seedCompanyAndAdmin } from "./setup.js";
import { resolveLearningAliases } from "../src/services/learningService.js";

const app = createServer();

async function loginAs(email: string) {
  const res = await request(app).post("/auth/login").send({ email, password: "Password123!" });
  return res.body.token as string;
}

describe("Voice aliases", () => {
  let adminToken: string;
  let workerToken: string;

  before(async () => {
    await resetDb();
    await seedCompanyAndAdmin();
    adminToken = await loginAs("admin@test.local");
    workerToken = await loginAs("worker@test.local");
  });

  after(async () => {
    await prisma.$disconnect();
  });

  it("refuses alias management without voice.execute permission (403)", async () => {
    const res = await request(app)
      .post("/command/aliases")
      .set("Authorization", `Bearer ${workerToken}`)
      .send({ heard: "Ema", means: "Emma", category: "wake_word" });
    assert.equal(res.status, 403);
  });

  it("refuses alias management without a token (401)", async () => {
    const res = await request(app).get("/command/aliases");
    assert.equal(res.status, 401);
  });

  it("needs three identical hearings before an alias becomes active", async () => {
    const learn = (heard: string) =>
      request(app)
        .post("/command/aliases/learn")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ heard, means: "Emma", category: "wake_word" });

    const first = await learn("Ema");
    assert.equal(first.status, 200);
    assert.equal(first.body.status, "learning");
    assert.equal(first.body.confirmations, 1);

    // Different spelling of the same sound: still the same phrase.
    const second = await learn("éma,");
    assert.equal(second.body.status, "learning");
    assert.equal(second.body.confirmations, 2);

    const third = await learn("EMA");
    assert.equal(third.body.status, "active");
    assert.equal(third.body.confirmations, 3);
  });

  it("restarts counting when the meaning changes", async () => {
    const send = (means: string) =>
      request(app)
        .post("/command/aliases/learn")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ heard: "Emo", means, category: "wake_word" });

    await send("Emma");
    const changed = await send("Ema Nova");
    assert.equal(changed.body.confirmations, 1);
    assert.equal(changed.body.status, "learning");
  });

  it("rejects an alias that maps a phrase onto itself", async () => {
    const res = await request(app)
      .post("/command/aliases")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ heard: "Emma", means: "emma", category: "wake_word" });
    assert.equal(res.status, 400);
  });

  it("activates a hand-written alias immediately", async () => {
    const res = await request(app)
      .post("/command/aliases")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ heard: "Ukaž zákazníky", means: "ukaž klienty", category: "voice_command" });
    assert.equal(res.status, 201);
    assert.equal(res.body.alias.status, "active");
  });

  it("applies a learned alias to spoken text despite diacritics and spacing", async () => {
    // Aliases are stored diacritics-folded, so literal matching would save this
    // rule and then never use it. This is the regression that matters.
    const admin = await prisma.user.findFirstOrThrow({ where: { email: "admin@test.local" } });
    const user = { id: admin.id, companyId: admin.companyId, role: admin.role, permissions: [] } as never;

    const resolved = await resolveLearningAliases(user, "Ukaž  ZÁKAZNÍKY prosím");
    assert.match(resolved.resolvedText, /ukaž klienty/i);
    assert.ok(resolved.resolvedText.includes("prosím"), "the rest of the sentence must survive");
    assert.equal(resolved.appliedRules.length, 1);
  });

  it("leaves text without an alias completely unchanged", async () => {
    const admin = await prisma.user.findFirstOrThrow({ where: { email: "admin@test.local" } });
    const user = { id: admin.id, companyId: admin.companyId, role: admin.role, permissions: [] } as never;

    const resolved = await resolveLearningAliases(user, "vytvoř nabídku pro Škodu");
    assert.equal(resolved.resolvedText, "vytvoř nabídku pro Škodu");
    assert.equal(resolved.appliedRules.length, 0);
  });

  it("does not match an alias inside a longer word", async () => {
    const admin = await prisma.user.findFirstOrThrow({ where: { email: "admin@test.local" } });
    const user = { id: admin.id, companyId: admin.companyId, role: admin.role, permissions: [] } as never;

    // "ema" is active from the learning test above; "emailem" must not match it.
    const resolved = await resolveLearningAliases(user, "pošli to emailem");
    assert.equal(resolved.resolvedText, "pošli to emailem");
  });

  it("lists aliases and removes one", async () => {
    const listed = await request(app)
      .get("/command/aliases")
      .set("Authorization", `Bearer ${adminToken}`);
    assert.equal(listed.status, 200);
    assert.equal(listed.body.required, 3);
    assert.ok(listed.body.aliases.length >= 3);

    const target = listed.body.aliases.find((alias: { term: string }) => alias.term === "emo");
    const removed = await request(app)
      .delete(`/command/aliases/${target.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    assert.equal(removed.status, 200);

    const after = await request(app)
      .get("/command/aliases")
      .set("Authorization", `Bearer ${adminToken}`);
    assert.ok(!after.body.aliases.some((alias: { id: string }) => alias.id === target.id));
  });

  it("returns 404 when removing an alias that does not exist", async () => {
    const res = await request(app)
      .delete("/command/aliases/00000000-0000-0000-0000-000000000000")
      .set("Authorization", `Bearer ${adminToken}`);
    assert.equal(res.status, 404);
  });
});
