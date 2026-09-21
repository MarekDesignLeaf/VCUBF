import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { createServer } from "../src/server.js";
import { prisma } from "../src/db.js";
import { resetDb, seedCompanyAndAdmin } from "./setup.js";

// Multi tenant isolation (master documentation section 52). One company must
// never be able to reach another company's data. That guarantee is only as
// strong as the weakest table: a row that names no company can be filtered only
// by joining whatever parent does name one, so isolation stops being a property
// of the data and becomes a habit of whoever writes the next query.
//
// Four child tables were in exactly that position — invoice and quote lines,
// payments, job resource requirements — and this suite is what keeps them, and
// any table added later, from slipping back into it.

const app = createServer();
let token = "";
let clientId = "";
let companyId = "";

describe("Tenant keys", () => {
  before(async () => {
    await resetDb();
    const { company } = await seedCompanyAndAdmin();
    companyId = company.id;
    token = (await request(app).post("/auth/login").send({ email: "admin@test.local", password: "Password123!" })).body.token;
    clientId = (await prisma.client.create({ data: { companyId, displayName: "Tenant key client" } })).id;
  });
  after(async () => { await resetDb(); await prisma.$disconnect(); });

  it("declares a company on every model except the company itself", () => {
    const schema = readFileSync(fileURLToPath(new URL("../prisma/schema.prisma", import.meta.url)), "utf8");
    const models = [...schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)];
    assert.ok(models.length > 40, "the schema should have been parsed into models");
    const withoutTenant = models.filter(([, , body]) => !/^\s*companyId\s/m.test(body)).map(([, name]) => name);
    // Company is the tenant; it cannot hold a key to itself. Anything else
    // appearing here is a table that can only be filtered through a join.
    assert.deepEqual(withoutTenant, ["Company"]);
  });

  it("writes the company on invoice lines and on the payment", async () => {
    const created = await request(app).post("/invoices").set("Authorization", `Bearer ${token}`)
      .send({ client_id: clientId, invoice_number: "TENANT-1", title: "Tenant key work", items: [{ description: "Labour", quantity: 2, unit_price: 100 }] });
    assert.equal(created.status, 201);
    const items = await prisma.invoiceItem.findMany({ where: { invoiceId: created.body.id } });
    assert.equal(items.length, 1);
    assert.deepEqual(items.map((line) => line.companyId), [companyId]);

    // Replacing the lines of a draft goes through a different write than
    // creating them, and it was the one most likely to forget the key.
    const edited = await request(app).put(`/invoices/${created.body.id}`).set("Authorization", `Bearer ${token}`)
      .send({ items: [{ description: "Labour", quantity: 1, unit_price: 60 }, { description: "Materials", quantity: 1, unit_price: 40 }] });
    assert.equal(edited.status, 200);
    const replaced = await prisma.invoiceItem.findMany({ where: { invoiceId: created.body.id } });
    assert.deepEqual(replaced.map((line) => line.companyId), [companyId, companyId]);

    await request(app).put(`/invoices/${created.body.id}/status`).set("Authorization", `Bearer ${token}`).send({ invoice_status: "issued" });
    const paid = await request(app).post(`/invoices/${created.body.id}/payments`).set("Authorization", `Bearer ${token}`)
      .send({ amount: 100, paid_at: "2026-09-21T00:00:00.000Z", confirmed: true });
    assert.equal(paid.status, 201);
    const payments = await prisma.payment.findMany({ where: { invoiceId: created.body.id } });
    assert.deepEqual(payments.map((payment) => payment.companyId), [companyId]);
  });

  it("writes the company on quote lines, both when the quote is created and when its lines are replaced", async () => {
    const created = await request(app).post("/quotes").set("Authorization", `Bearer ${token}`)
      .send({ client_id: clientId, title: "Tenant key quote", items: [{ description: "Design", quantity: 1, unit_price: 250 }] });
    assert.equal(created.status, 201);
    const lines = await prisma.quoteItem.findMany({ where: { quoteId: created.body.id } });
    assert.deepEqual(lines.map((line) => line.companyId), [companyId]);

    const edited = await request(app).put(`/quotes/${created.body.id}`).set("Authorization", `Bearer ${token}`)
      .send({ items: [{ description: "Design", quantity: 1, unit_price: 250 }, { description: "Planting", quantity: 1, unit_price: 500 }] });
    assert.equal(edited.status, 200);
    const replaced = await prisma.quoteItem.findMany({ where: { quoteId: created.body.id } });
    assert.deepEqual(replaced.map((line) => line.companyId), [companyId, companyId]);
  });

  it("writes the company on a job resource requirement", async () => {
    const job = await prisma.job.create({ data: { companyId, clientId, jobTitle: "Tenant key job" } });
    const added = await request(app).post(`/crm/jobs/${job.id}/resources`).set("Authorization", `Bearer ${token}`)
      .send({ resource_type: "material", name: "Topsoil", quantity: 3, unit: "bags" });
    assert.equal(added.status, 201, JSON.stringify(added.body));
    const requirements = await prisma.jobResourceRequirement.findMany({ where: { jobId: job.id } });
    assert.deepEqual(requirements.map((row) => row.companyId), [companyId]);
  });
});
