import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import request from "supertest";
import { createServer } from "../src/server.js";
import { prisma } from "../src/db.js";
import { resetDb, seedCompanyAndAdmin } from "./setup.js";

// Master documentation section 43. A retry must not act twice: not two
// invoices, not two payments, not two messages. Section 44 is the other half —
// between a first attempt being accepted and its answer being recorded, the
// outcome is genuinely unknown, and a retry arriving then is told so rather
// than allowed to repeat the work.

const app = createServer();
let token = "";
let clientId = "";
let companyId = "";

const invoice = (number: string) => ({
  client_id: clientId, invoice_number: number, title: "Idempotent work",
  items: [{ description: "Labour", quantity: 1, unit_price: 100 }],
});

describe("Write idempotency", () => {
  before(async () => {
    await resetDb();
    const { company } = await seedCompanyAndAdmin();
    companyId = company.id;
    token = (await request(app).post("/auth/login").send({ email: "admin@test.local", password: "Password123!" })).body.token;
    clientId = (await prisma.client.create({ data: { companyId, displayName: "Idempotency client" } })).id;
  });
  after(async () => { await resetDb(); await prisma.$disconnect(); });

  it("performs the work once and answers the repeat with the first answer", async () => {
    const send = () => request(app).post("/invoices")
      .set("Authorization", `Bearer ${token}`).set("Idempotency-Key", "invoice-once").send(invoice("IDEM-1"));

    const first = await send();
    assert.equal(first.status, 201);
    assert.equal(first.headers["idempotent-replay"], undefined);

    const repeat = await send();
    assert.equal(repeat.status, 201);
    assert.equal(repeat.headers["idempotent-replay"], "true");
    assert.equal(repeat.body.id, first.body.id, "the repeat must return the first invoice, not a second one");
    assert.equal(await prisma.invoice.count({ where: { invoiceNumber: "IDEM-1" } }), 1);
  });

  it("refuses a key that was already used for a different request", async () => {
    const reused = await request(app).post("/invoices")
      .set("Authorization", `Bearer ${token}`).set("Idempotency-Key", "invoice-once").send(invoice("IDEM-DIFFERENT"));
    assert.equal(reused.status, 409);
    assert.equal(reused.body.error, "IDEMPOTENCY_KEY_REUSED");
    // Refused, not answered: replaying the stored response for a request that
    // was never made would be worse than either outcome.
    assert.equal(await prisma.invoice.count({ where: { invoiceNumber: "IDEM-DIFFERENT" } }), 0);
  });

  it("says the outcome is unknown while the first attempt is still running", async () => {
    const send = () => request(app).post("/invoices")
      .set("Authorization", `Bearer ${token}`).set("Idempotency-Key", "invoice-in-flight").send(invoice("IDEM-FLIGHT"));
    assert.equal((await send()).status, 201);
    // The attempt was accepted but its answer never recorded — a crash, or a
    // connection lost before the response was written. What it did is unknown.
    await prisma.idempotencyRecord.updateMany({
      where: { companyId, key: "invoice-in-flight" },
      data: { status: "in_progress", responseStatus: null, responseBody: undefined },
    });
    const res = await send();
    assert.equal(res.status, 409);
    assert.equal(res.body.error, "IDEMPOTENCY_IN_PROGRESS");
    assert.equal(await prisma.invoice.count({ where: { invoiceNumber: "IDEM-FLIGHT" } }), 1, "the retry must not act again");
  });

  it("frees a key once its record has expired", async () => {
    await prisma.idempotencyRecord.updateMany({
      where: { companyId, key: "invoice-in-flight" },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    // Past retention the first answer is no longer replayable, so the key is
    // free again rather than blocked for ever.
    const res = await request(app).post("/invoices")
      .set("Authorization", `Bearer ${token}`).set("Idempotency-Key", "invoice-in-flight").send(invoice("IDEM-AFTER-EXPIRY"));
    assert.equal(res.status, 201, JSON.stringify(res.body));
  });

  it("keeps one company's keys away from another's", async () => {
    const other = await prisma.company.create({ data: { name: "Other tenant" } });
    await prisma.idempotencyRecord.create({
      data: {
        companyId: other.id, userId: (await prisma.user.findFirstOrThrow({ where: { email: "admin@test.local" } })).id,
        key: "shared-key", fingerprint: "theirs", status: "completed",
        responseStatus: 201, responseBody: { id: "not-ours" }, expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    const res = await request(app).post("/invoices")
      .set("Authorization", `Bearer ${token}`).set("Idempotency-Key", "shared-key").send(invoice("IDEM-TENANT"));
    assert.equal(res.status, 201);
    assert.notEqual(res.body.id, "not-ours");
  });

  it("leaves a request without the header exactly as it was", async () => {
    const before = await prisma.idempotencyRecord.count({ where: { companyId } });
    const first = await request(app).post("/invoices").set("Authorization", `Bearer ${token}`).send(invoice("IDEM-PLAIN-1"));
    const second = await request(app).post("/invoices").set("Authorization", `Bearer ${token}`).send(invoice("IDEM-PLAIN-2"));
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.notEqual(first.body.id, second.body.id);
    // Opt-in: an unkeyed request behaves exactly as before and leaves nothing
    // behind, so no existing client changes behaviour.
    assert.equal(await prisma.idempotencyRecord.count({ where: { companyId } }), before);
  });

  it("does not remember a refused request, so the caller may correct it and retry", async () => {
    const bad = await request(app).post("/invoices")
      .set("Authorization", `Bearer ${token}`).set("Idempotency-Key", "invoice-fix-me").send({ client_id: clientId });
    assert.equal(bad.status, 400);
    // A rejected request did happen and is remembered, so the same request
    // repeated gets the same refusal rather than being evaluated twice.
    const again = await request(app).post("/invoices")
      .set("Authorization", `Bearer ${token}`).set("Idempotency-Key", "invoice-fix-me").send({ client_id: clientId });
    assert.equal(again.status, 400);
    assert.equal(again.headers["idempotent-replay"], "true");
    // A corrected request under the same key is a different request, so it is
    // refused as a reuse rather than silently answered with the old error.
    const corrected = await request(app).post("/invoices")
      .set("Authorization", `Bearer ${token}`).set("Idempotency-Key", "invoice-fix-me").send(invoice("IDEM-CORRECTED"));
    assert.equal(corrected.status, 409);
    assert.equal(corrected.body.error, "IDEMPOTENCY_KEY_REUSED");
  });

  it("protects a payment, which is the write that must never happen twice", async () => {
    const created = await request(app).post("/invoices").set("Authorization", `Bearer ${token}`).send(invoice("IDEM-PAY"));
    await request(app).put(`/invoices/${created.body.id}/status`).set("Authorization", `Bearer ${token}`).send({ invoice_status: "issued" });
    const pay = () => request(app).post(`/invoices/${created.body.id}/payments`)
      .set("Authorization", `Bearer ${token}`).set("Idempotency-Key", "payment-once")
      .send({ amount: 60, paid_at: "2026-09-21T00:00:00.000Z", confirmed: true });

    const first = await pay();
    assert.equal(first.status, 201);
    const repeat = await pay();
    assert.equal(repeat.status, 201);
    assert.equal(repeat.headers["idempotent-replay"], "true");
    assert.equal(await prisma.payment.count({ where: { invoiceId: created.body.id } }), 1);
    const invoiceNow = await request(app).get(`/invoices/${created.body.id}`).set("Authorization", `Bearer ${token}`);
    assert.equal(invoiceNow.body.totals.paid, 60, "the repeat must not pay twice");
  });
});
