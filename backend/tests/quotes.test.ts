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

describe("Quote, Pricing and Profitability Module", () => {
  let adminToken: string;
  let workerToken: string;
  let clientId: string;
  let jobId: string;
  let serviceId: string;

  before(async () => {
    await resetDb();
    await seedCompanyAndAdmin();
    adminToken = await loginAs("admin@test.local");
    workerToken = await loginAs("worker@test.local");

    const clientRes = await request(app)
      .post("/crm/clients")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ display_name: "Quote Test Client" });
    clientId = clientRes.body.id;

    const jobRes = await request(app)
      .post("/crm/jobs")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ client_id: clientId, job_title: "Fence repair for Quote Test Client" });
    jobId = jobRes.body.id;

    const serviceRes = await request(app)
      .post("/service-catalogue")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Fence panel replacement", base_price_min: 90, price_unit: "per panel" });
    serviceId = serviceRes.body.id;
  });

  after(async () => {
    await prisma.$disconnect();
  });

  it("rejects quote creation without crm.manage permission (403)", async () => {
    const res = await request(app)
      .post("/quotes")
      .set("Authorization", `Bearer ${workerToken}`)
      .send({ client_id: clientId, title: "Fence works", items: [{ description: "Panel", unit_price: 90 }] });
    assert.equal(res.status, 403);
  });

  it("validates that at least one line item is required", async () => {
    const res = await request(app)
      .post("/quotes")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ client_id: clientId, title: "Fence works", items: [] });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "VALIDATION_FAILED");
  });

  it("returns CLIENT_NOT_FOUND for an unknown client id", async () => {
    const res = await request(app)
      .post("/quotes")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        client_id: "00000000-0000-0000-0000-000000000099",
        title: "Fence works",
        items: [{ description: "Panel", unit_price: 90 }],
      });
    assert.equal(res.status, 404);
    assert.equal(res.body.error, "CLIENT_NOT_FOUND");
  });

  it("creates a quote with real line items and computes subtotal/cost/margin from what was entered", async () => {
    const res = await request(app)
      .post("/quotes")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        client_id: clientId,
        job_id: jobId,
        title: "Fence repair quote",
        items: [
          { service_catalogue_item_id: serviceId, description: "Replace 3 fence panels", quantity: 3, unit_price: 90, unit_cost: 55 },
          { description: "Labour", quantity: 4, unit_price: 35, unit_cost: 20 },
        ],
      });
    assert.equal(res.status, 201);
    assert.equal(res.body.quoteStatus, "draft");
    assert.equal(res.body.items.length, 2);
    // subtotal = 3*90 + 4*35 = 270 + 140 = 410
    assert.equal(res.body.totals.subtotal, 410);
    // cost total = 3*55 + 4*20 = 165 + 80 = 245
    assert.equal(res.body.totals.costTotal, 245);
    assert.equal(res.body.totals.marginAmount, 165);
    assert.ok(Math.abs(res.body.totals.marginPct - (165 / 410) * 100) < 0.001);

    const audit = await prisma.auditLog.findFirst({ where: { actionName: "prepare_quote", result: "success" } });
    assert.ok(audit);
  });

  it("reports margin as unknown (null) when any line item has no entered cost", async () => {
    const res = await request(app)
      .post("/quotes")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        client_id: clientId,
        title: "Quote with unknown cost",
        items: [{ description: "Materials — price not yet costed", quantity: 1, unit_price: 200 }],
      });
    assert.equal(res.status, 201);
    assert.equal(res.body.totals.subtotal, 200);
    assert.equal(res.body.totals.marginAmount, null);
    assert.equal(res.body.totals.marginPct, null);
  });

  it("rejects an unknown service_catalogue_item_id on a line item", async () => {
    const res = await request(app)
      .post("/quotes")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        client_id: clientId,
        title: "Bad reference",
        items: [{ service_catalogue_item_id: "00000000-0000-0000-0000-000000000099", description: "x", unit_price: 10 }],
      });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "VALIDATION_FAILED");
  });

  it("lists quotes and can filter by client and job", async () => {
    const listRes = await request(app).get("/quotes").set("Authorization", `Bearer ${adminToken}`);
    assert.equal(listRes.status, 200);
    assert.ok(listRes.body.length >= 2);

    const byClient = await request(app).get(`/quotes?client_id=${clientId}`).set("Authorization", `Bearer ${adminToken}`);
    assert.ok(byClient.body.every((q: any) => q.clientId === clientId));

    const byJob = await request(app).get(`/quotes?job_id=${jobId}`).set("Authorization", `Bearer ${adminToken}`);
    assert.ok(byJob.body.length >= 1);
    assert.ok(byJob.body.every((q: any) => q.jobId === jobId));
  });

  it("updates a quote's line items and recomputes totals, recording before/after in the audit log", async () => {
    const quote = await prisma.quote.findFirst({ where: { title: "Fence repair quote" } });
    const res = await request(app)
      .put(`/quotes/${quote!.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        items: [{ description: "Replace 4 fence panels", quantity: 4, unit_price: 90, unit_cost: 55 }],
      });
    assert.equal(res.status, 200);
    assert.equal(res.body.items.length, 1);
    assert.equal(res.body.totals.subtotal, 360);
    assert.equal(res.body.totals.costTotal, 220);

    const audit = await prisma.auditLog.findFirst({
      where: { actionName: "update_quote", result: "success" },
      orderBy: { createdAt: "desc" },
    });
    assert.ok(audit);
    assert.ok((audit?.dataBefore as any)?.items);
    assert.ok((audit?.dataAfter as any)?.items);
  });

  it("returns QUOTE_NOT_FOUND for an update to a nonexistent id", async () => {
    const res = await request(app)
      .put("/quotes/00000000-0000-0000-0000-000000000099")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ title: "x" });
    assert.equal(res.status, 404);
    assert.equal(res.body.error, "QUOTE_NOT_FOUND");
  });

  it("changes quote status through its lifecycle", async () => {
    const quote = await prisma.quote.findFirst({ where: { title: "Fence repair quote" } });
    const sentRes = await request(app)
      .put(`/quotes/${quote!.id}/status`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ quote_status: "sent" });
    assert.equal(sentRes.status, 200);
    assert.equal(sentRes.body.quoteStatus, "sent");

    const acceptedRes = await request(app)
      .put(`/quotes/${quote!.id}/status`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ quote_status: "accepted" });
    assert.equal(acceptedRes.status, 200);
    assert.equal(acceptedRes.body.quoteStatus, "accepted");
  });

  it("rejects an invalid quote status", async () => {
    const quote = await prisma.quote.findFirst({ where: { title: "Fence repair quote" } });
    const res = await request(app)
      .put(`/quotes/${quote!.id}/status`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ quote_status: "not_a_real_status" });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "VALIDATION_FAILED");
  });

  it("returns a single quote via GET /quotes/:id including client and job", async () => {
    const quote = await prisma.quote.findFirst({ where: { title: "Fence repair quote" } });
    const res = await request(app).get(`/quotes/${quote!.id}`).set("Authorization", `Bearer ${adminToken}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.client.id, clientId);
    assert.equal(res.body.job.id, jobId);
  });

  it("exports a client-facing PDF with safe download headers and an audit record", async () => {
    const quote = await prisma.quote.findFirst({ where: { title: "Fence repair quote" } });
    const res = await request(app)
      .get(`/quotes/${quote!.id}/pdf`)
      .set("Authorization", `Bearer ${adminToken}`)
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => callback(null, Buffer.concat(chunks)));
      });

    assert.equal(res.status, 200);
    assert.match(res.headers["content-type"], /^application\/pdf/);
    assert.match(res.headers["content-disposition"], new RegExp(`quote-${quote!.id}\\.pdf`));
    assert.equal(res.headers["cache-control"], "private, no-store");
    assert.equal(res.headers["x-content-type-options"], "nosniff");
    assert.equal((res.body as Buffer).subarray(0, 5).toString(), "%PDF-");
    assert.ok((res.body as Buffer).length > 1_000);

    const audit = await prisma.auditLog.findFirst({
      where: { actionName: "export_quote_pdf", result: "success" },
      orderBy: { createdAt: "desc" },
    });
    assert.equal((audit?.inputPayload as any)?.quoteId, quote!.id);
    assert.equal(typeof (audit?.dataAfter as any)?.byteLength, "number");
  });

  it("does not expose quote PDFs without authentication and returns 404 for an unknown company-scoped id", async () => {
    const unauthenticated = await request(app).get("/quotes/00000000-0000-0000-0000-000000000099/pdf");
    assert.equal(unauthenticated.status, 401);

    const missing = await request(app)
      .get("/quotes/00000000-0000-0000-0000-000000000099/pdf")
      .set("Authorization", `Bearer ${adminToken}`);
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error, "QUOTE_NOT_FOUND");
  });
});
