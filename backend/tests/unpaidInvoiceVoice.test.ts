import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import request from "supertest";
import { createServer } from "../src/server.js";
import { prisma } from "../src/db.js";
import { parseTextCommand } from "../src/lib/commandParser.js";
import { resetDb, seedCompanyAndAdmin } from "./setup.js";

const app = createServer();

describe("Unpaid invoice voice query", () => {
  let token: string;
  let workerToken: string;
  let companyId: string;
  before(async () => {
    await resetDb();
    const { company, admin, worker } = await seedCompanyAndAdmin();
    companyId = company.id;
    await prisma.user.update({ where: { id: admin.id }, data: { voiceLanguage: "cs-CZ" } });
    await prisma.user.update({ where: { id: worker.id }, data: { permissions: ["voice.execute"] } });
    token = (await request(app).post("/auth/login").send({ email: admin.email, password: "Password123!" })).body.token;
    workerToken = (await request(app).post("/auth/login").send({ email: worker.email, password: "Password123!" })).body.token;
    const client = await prisma.client.create({ data: { companyId, displayName: "Invoice voice fixture" } });
    for (const [index, status, paid] of [[1, "issued", 0], [2, "issued", 40], [3, "issued", 100], [4, "draft", 0], [5, "void", 0]] as const) {
      await prisma.invoice.create({ data: {
        companyId, clientId: client.id, invoiceNumber: `VOICE-${index}`, title: "Fixture", invoiceStatus: status,
        createdBy: admin.id, dueDate: new Date("2020-01-01T00:00:00Z"),
        items: { create: { description: "Work", quantity: 1, unitPrice: 100, sortOrder: 0 } },
        ...(paid ? { payments: { create: { amount: paid, paidAt: new Date() } } } : {}),
      } });
    }
    const other = await prisma.company.create({ data: { name: "Other tenant" } });
    const otherClient = await prisma.client.create({ data: { companyId: other.id, displayName: "Private" } });
    await prisma.invoice.create({ data: {
      companyId: other.id, clientId: otherClient.id, invoiceNumber: "PRIVATE", title: "Private", invoiceStatus: "issued",
      items: { create: { description: "Private", quantity: 1, unitPrice: 100, sortOrder: 0 } },
    } });
  });
  after(async () => { await prisma.$disconnect(); });

  it("recognises Czech and English count questions without a model", () => {
    for (const text of ["Kolik mám nezaplacených faktur?", "kolik máme neuhrazených faktur", "How many unpaid invoices do I have?", "Kdo mi nezaplatil?", "Who owes us money?"]) {
      assert.deepEqual(parseTextCommand(text), { intent: "execute_action", entities: { action: "get_unpaid_invoices", parameters: {} } });
    }
    assert.equal(parseTextCommand("zaplať všechny nezaplacené faktury").intent, "unrecognized");
  });

  it("counts unpaid issued invoices, includes partial payments, excludes drafts, paid, void and other tenants", async () => {
    const res = await request(app).post("/command/assistant").set("Authorization", `Bearer ${token}`)
      .send({ text: "Kolik mám nezaplacených faktur?", input_method: "voice_transcript" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.kind, "action");
    assert.equal(res.body.data.count, 2);
    assert.equal(res.body.data.overdueCount, 2);
    // 100 unpaid plus 100 with 40 already paid. The fully paid invoice, the
    // draft, the void one and the other tenant's invoice contribute nothing.
    assert.equal(res.body.data.outstandingTotal, 160);
    assert.equal(res.body.data.overdueTotal, 160);
    assert.deepEqual(res.body.data.debtors, [{ client: "Invoice voice fixture", balance: 160, overdueBalance: 160 }]);
    assert.equal(
      res.body.message,
      "Neuhrazené vystavené faktury: 2, celkem 160,00. Po splatnosti: 2, celkem 160,00. Nejvíc dluží: Invoice voice fixture 160,00.",
    );
    const audit = await prisma.auditLog.findFirst({ where: { companyId, result: "success", interpretedIntent: "execute_action" } });
    assert.ok(audit);
  });

  it("rejects a voice user without CRM read permission", async () => {
    const res = await request(app).post("/command/assistant").set("Authorization", `Bearer ${workerToken}`)
      .send({ text: "Kolik mám nezaplacených faktur?", input_method: "voice_transcript" });
    assert.equal(res.status, 403);
    assert.equal(res.body.data, undefined);
  });

  it("honours a disabled company capability", async () => {
    await prisma.company.update({ where: { id: companyId }, data: { emmaDisabledCapabilities: ["action.get_unpaid_invoices"] } });
    const res = await request(app).post("/command/assistant").set("Authorization", `Bearer ${token}`)
      .send({ text: "Kolik mám nezaplacených faktur?", input_method: "voice_transcript" });
    assert.equal(res.status, 403);
    assert.equal(res.body.data, undefined);
  });
});
