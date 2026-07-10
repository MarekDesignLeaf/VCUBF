import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import request from "supertest";
import { createServer } from "../src/server.js";
import { prisma } from "../src/db.js";
import { resetDb, seedCompanyAndAdmin } from "./setup.js";

const app = createServer();

async function loginAs(email: string) {
  const res = await request(app).post("/auth/login").send({ email, password: "Password123!" });
  return res.body.token as string;
}

describe("Learning Engine", () => {
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

  it("rejects learning rule creation without voice.execute permission (403)", async () => {
    const res = await request(app)
      .post("/learning-rules")
      .set("Authorization", `Bearer ${workerToken}`)
      .send({ term: "old client", meaning: "a client who had work done in the last two years" });
    assert.equal(res.status, 403);
  });

  it("records an explicit correction as a learning rule", async () => {
    const res = await request(app)
      .post("/learning-rules")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        term: "old client",
        meaning: "a client who had work done by us in the last two years, not an elderly person",
        category: "terminology",
      });
    assert.equal(res.status, 201);
    assert.equal(res.body.status, "active");
    assert.equal(res.body.aliasFor, null);

    const audit = await prisma.auditLog.findFirst({ where: { actionName: "create_learning_rule", result: "success" } });
    assert.ok(audit);
  });

  it("validates required fields", async () => {
    const res = await request(app)
      .post("/learning-rules")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ meaning: "no term given" });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "VALIDATION_FAILED");
  });

  it("creates a client, then teaches an alias for the client's short name via a text command", async () => {
    await request(app)
      .post("/crm/clients")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ display_name: "Riverside Apartments Ltd" });

    const teachRes = await request(app)
      .post("/command/text")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ text: "when I say RAL I mean Riverside Apartments Ltd" });
    assert.equal(teachRes.status, 201);
    assert.equal(teachRes.body.intent, "create_learning_rule");
    assert.equal(teachRes.body.data.term, "RAL");
    assert.equal(teachRes.body.data.meaning, "Riverside Apartments Ltd");

    // The rule was recorded as plain meaning, not yet a substitution alias
    // (alias_for was never set) — so it should NOT change how commands are
    // interpreted until the user explicitly turns it into one. "RAL" is not
    // a substring of the real client name, so this must fail to resolve.
    const jobRes = await request(app)
      .post("/command/text")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ text: "create job Gutter clean for RAL" });
    assert.equal(jobRes.body.error, "CLIENT_NOT_FOUND");
  });

  it("applies an alias_for substitution rule before parsing a text command", async () => {
    const rule = await prisma.learningRule.findFirst({ where: { term: "RAL" } });
    const updateRes = await request(app)
      .put(`/learning-rules/${rule!.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ alias_for: "Riverside Apartments Ltd" });
    assert.equal(updateRes.status, 200);
    assert.equal(updateRes.body.aliasFor, "Riverside Apartments Ltd");

    const jobRes = await request(app)
      .post("/command/text")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ text: "create job Gutter clean for RAL" });
    assert.equal(jobRes.status, 201);
    assert.equal(jobRes.body.intent, "create_job");
    assert.deepEqual(jobRes.body.appliedAliases, [{ term: "RAL", aliasFor: "Riverside Apartments Ltd" }]);

    const audit = await prisma.auditLog.findFirst({
      where: { actionName: "execute_text_command", interpretedIntent: "create_job" },
      orderBy: { createdAt: "desc" },
    });
    assert.equal((audit?.inputPayload as any)?.resolvedText, "create job Gutter clean for Riverside Apartments Ltd");
  });

  it("archiving a rule stops it from being applied as an alias", async () => {
    const rule = await prisma.learningRule.findFirst({ where: { term: "RAL" } });
    await request(app)
      .put(`/learning-rules/${rule!.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ status: "archived" });

    const res = await request(app)
      .post("/command/text")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ text: "create job Second visit for RAL" });
    assert.equal(res.body.error, "CLIENT_NOT_FOUND");
    assert.deepEqual(res.body.appliedAliases, []);
  });

  it("returns LEARNING_RULE_NOT_FOUND for an update to a nonexistent id", async () => {
    const res = await request(app)
      .put("/learning-rules/00000000-0000-0000-0000-000000000099")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ meaning: "x" });
    assert.equal(res.status, 404);
    assert.equal(res.body.error, "LEARNING_RULE_NOT_FOUND");
  });

  it("lists learning rules and can filter by status", async () => {
    const listRes = await request(app).get("/learning-rules").set("Authorization", `Bearer ${adminToken}`);
    assert.equal(listRes.status, 200);
    assert.ok(listRes.body.length >= 2);

    const activeRes = await request(app)
      .get("/learning-rules?status=active")
      .set("Authorization", `Bearer ${adminToken}`);
    assert.ok(activeRes.body.every((r: any) => r.status === "active"));

    const archivedRes = await request(app)
      .get("/learning-rules?status=archived")
      .set("Authorization", `Bearer ${adminToken}`);
    assert.ok(archivedRes.body.some((r: any) => r.term === "RAL"));
  });

  it("lists learning rules via a text command", async () => {
    const res = await request(app)
      .post("/command/text")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ text: "list learning rules" });
    assert.equal(res.status, 200);
    assert.equal(res.body.intent, "list_learning_rules");
    assert.ok(Array.isArray(res.body.data));
    assert.ok(res.body.data.length >= 2);
  });

  it("prefers the longer of two overlapping alias terms", async () => {
    await request(app)
      .post("/crm/clients")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ display_name: "Oak House" });
    await request(app)
      .post("/crm/clients")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ display_name: "Oak House Care Home" });

    await request(app)
      .post("/learning-rules")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ term: "Oak", meaning: "shorthand for Oak House", alias_for: "Oak House" });
    await request(app)
      .post("/learning-rules")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ term: "Oak Home", meaning: "shorthand for Oak House Care Home", alias_for: "Oak House Care Home" });

    const res = await request(app)
      .post("/command/text")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ text: "create job Fire drill for Oak Home" });
    assert.equal(res.status, 201);
    assert.equal(res.body.data.jobTitle, "Fire drill");
  });
});
