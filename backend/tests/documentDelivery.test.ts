import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import request from "supertest";
import { createServer } from "../src/server.js";
import { prisma } from "../src/db.js";
import { buildGmailMimeMessage, GMAIL_SEND_SCOPE } from "../src/connectors/gmailAdapter.js";
import { encryptConnectorPayload } from "../src/connectors/connectorCrypto.js";
import { resetDb, seedCompanyAndAdmin, TEST_COMPANY_ID } from "./setup.js";

const app = createServer();
const originalFetch = globalThis.fetch;
const originalKey = process.env.CONNECTOR_ENCRYPTION_KEY;

function requestUrl(input: Parameters<typeof fetch>[0]) {
  return new URL(input instanceof Request ? input.url : String(input));
}

describe("Sending quote and invoice PDFs by email", () => {
  let token: string;
  let workerToken: string;
  let sourceId: string;
  let clientId: string;
  let quoteId: string;
  let invoiceId: string;
  let draftInvoiceId: string;

  before(async () => {
    process.env.CONNECTOR_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    await resetDb();
    await seedCompanyAndAdmin();
    token = (await request(app).post("/auth/login").send({ email: "admin@test.local", password: "Password123!" })).body.token;
    workerToken = (await request(app).post("/auth/login").send({ email: "worker@test.local", password: "Password123!" })).body.token;

    const source = await request(app).post("/connectors/sources").set("Authorization", `Bearer ${token}`)
      .send({ connector_key: "gmail", display_name: "Office Gmail", configured_scopes: ["send:messages"] });
    sourceId = source.body.id;
    await prisma.connectorSource.update({ where: { id: sourceId }, data: { isEnabled: true, connectionStatus: "enabled" } });
    await prisma.connectorCredential.create({
      data: {
        sourceId,
        companyId: TEST_COMPANY_ID,
        provider: "gmail",
        ...encryptConnectorPayload({ accessToken: "send-token", refreshToken: "send-refresh", scopes: [GMAIL_SEND_SCOPE], tokenType: "Bearer", expiresAt: "2099-01-01T00:00:00.000Z" }, `${TEST_COMPANY_ID}:${sourceId}:gmail`),
      },
    });

    clientId = (await request(app).post("/crm/clients").set("Authorization", `Bearer ${token}`)
      .send({ display_name: "Delivery Client", email_primary: "client@example.test" })).body.id;
    quoteId = (await request(app).post("/quotes").set("Authorization", `Bearer ${token}`)
      .send({ client_id: clientId, title: "Patio quote", items: [{ description: "Patio", unit_price: 1200, unit_cost: 700 }] })).body.id;
    invoiceId = (await request(app).post("/invoices").set("Authorization", `Bearer ${token}`)
      .send({ client_id: clientId, invoice_number: "INV-100", title: "Patio invoice", items: [{ description: "Patio", quantity: 1, unit_price: 1200 }] })).body.id;
    await request(app).put(`/invoices/${invoiceId}/status`).set("Authorization", `Bearer ${token}`).send({ invoice_status: "issued" });
    draftInvoiceId = (await request(app).post("/invoices").set("Authorization", `Bearer ${token}`)
      .send({ client_id: clientId, invoice_number: "INV-101", title: "Draft invoice", items: [{ description: "Work", quantity: 1, unit_price: 50 }] })).body.id;
  });

  afterEach(() => { globalThis.fetch = originalFetch; });

  after(async () => {
    await prisma.$disconnect();
    if (originalKey === undefined) delete process.env.CONNECTOR_ENCRYPTION_KEY; else process.env.CONNECTOR_ENCRYPTION_KEY = originalKey;
  });

  it("builds a valid multipart MIME message with a base64 PDF part", () => {
    const mime = buildGmailMimeMessage({
      to: ["a@example.test"],
      subject: "Subject",
      body: "Body text",
      attachments: [{ filename: 'we"ird/name.pdf', contentType: "application/pdf", content: Buffer.from("%PDF-1.4 test") }],
    });
    const boundary = mime.match(/boundary="([^"]+)"/)![1];
    assert.match(mime, /Content-Type: multipart\/mixed/);
    assert.equal(mime.split(`--${boundary}`).length - 1, 3, "two parts plus the closing boundary");
    assert.match(mime, /Content-Disposition: attachment; filename="we_ird_name.pdf"/, "header-unsafe characters are replaced");
    const base64Part = mime.split(`--${boundary}`)[2].split("\r\n\r\n")[1];
    assert.equal(Buffer.from(base64Part.replace(/\r\n/g, ""), "base64").toString(), "%PDF-1.4 test");
    assert.ok(mime.includes("Body text"));
  });

  it("requires crm.manage", async () => {
    const res = await request(app).post(`/quotes/${quoteId}/send-email`).set("Authorization", `Bearer ${workerToken}`).send({ confirmed: true });
    assert.equal(res.status, 403);
  });

  it("previews the quote email without contacting Gmail and changes nothing", async () => {
    let contacted = false;
    globalThis.fetch = async () => { contacted = true; return Response.json({ id: "x" }); };
    const res = await request(app).post(`/quotes/${quoteId}/send-email`).set("Authorization", `Bearer ${token}`).send({});
    assert.equal(res.status, 409);
    assert.equal(res.body.error, "CONFIRMATION_REQUIRED");
    assert.deepEqual(res.body.preview.to, ["client@example.test"], "defaults to the client's stored email");
    assert.equal(res.body.preview.attachment.contentType, "application/pdf");
    assert.ok(res.body.preview.attachment.bytes > 500, "a real PDF was rendered for the preview");
    assert.deepEqual(res.body.preview.statusChange, { from: "draft", to: "sent" });
    assert.equal(contacted, false);
    assert.equal((await prisma.quote.findUniqueOrThrow({ where: { id: quoteId } })).quoteStatus, "draft");
    assert.equal(await prisma.communicationRecord.count(), 0);
  });

  it("sends the quote with the PDF attached, marks it sent and logs the communication", async () => {
    let sentRaw = "";
    globalThis.fetch = async (input, init) => {
      const url = requestUrl(input);
      assert.equal(url.pathname, "/gmail/v1/users/me/messages/send");
      sentRaw = JSON.parse(String(init?.body)).raw;
      return Response.json({ id: "gmail-sent-1", threadId: "thread-1" });
    };
    const res = await request(app).post(`/quotes/${quoteId}/send-email`).set("Authorization", `Bearer ${token}`)
      .send({ confirmed: true, subject: "Your patio quote", body: "Please see attached.", follow_up_due_at: new Date(Date.now() + 7 * 86_400_000).toISOString() });
    assert.equal(res.status, 200);
    assert.equal(res.body.messageId, "gmail-sent-1");
    assert.deepEqual(res.body.statusChange, { from: "draft", to: "sent" });

    const mime = Buffer.from(sentRaw, "base64url").toString("utf8");
    assert.match(mime, /Subject: Your patio quote/);
    assert.match(mime, /Content-Disposition: attachment; filename="quote-/);
    assert.match(mime, /Content-Type: application\/pdf/);

    assert.equal((await prisma.quote.findUniqueOrThrow({ where: { id: quoteId } })).quoteStatus, "sent");
    const communication = await prisma.communicationRecord.findUniqueOrThrow({ where: { id: res.body.communicationRecordId } });
    assert.equal(communication.direction, "outbound");
    assert.equal(communication.channel, "email");
    assert.equal(communication.clientId, clientId);
    assert.equal(communication.followUpNeeded, true);

    const audit = await prisma.auditLog.findFirstOrThrow({ where: { actionName: "send_quote_pdf", result: "success" }, orderBy: { createdAt: "desc" } });
    assert.equal(audit.confirmed, true);
    assert.ok(!JSON.stringify(audit).includes("Please see attached."), "the audit stores lengths, not the message body");
  });

  it("does not change the quote or write a communication when the provider fails", async () => {
    const secondQuote = (await request(app).post("/quotes").set("Authorization", `Bearer ${token}`)
      .send({ client_id: clientId, title: "Second quote", items: [{ description: "Work", unit_price: 10 }] })).body.id;
    globalThis.fetch = async () => new Response("nope", { status: 503 });
    const before = await prisma.communicationRecord.count();
    const res = await request(app).post(`/quotes/${secondQuote}/send-email`).set("Authorization", `Bearer ${token}`).send({ confirmed: true });
    assert.ok(res.status >= 400);
    assert.equal((await prisma.quote.findUniqueOrThrow({ where: { id: secondQuote } })).quoteStatus, "draft");
    assert.equal(await prisma.communicationRecord.count(), before);
  });

  it("refuses to send a draft invoice and sends an issued one without changing its status", async () => {
    const draft = await request(app).post(`/invoices/${draftInvoiceId}/send-email`).set("Authorization", `Bearer ${token}`).send({ confirmed: true });
    assert.equal(draft.status, 409);
    assert.equal(draft.body.error, "INVOICE_NOT_ISSUED");

    globalThis.fetch = async () => Response.json({ id: "gmail-sent-2" });
    const res = await request(app).post(`/invoices/${invoiceId}/send-email`).set("Authorization", `Bearer ${token}`).send({ confirmed: true });
    assert.equal(res.status, 200);
    assert.equal(res.body.statusChange, null);
    assert.equal((await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).invoiceStatus, "issued");
  });

  it("asks for an explicit recipient when the client has no stored email", async () => {
    const noEmailClient = (await request(app).post("/crm/clients").set("Authorization", `Bearer ${token}`).send({ display_name: "No Email Client", phone_primary: "07700900999" })).body.id;
    const quote = (await request(app).post("/quotes").set("Authorization", `Bearer ${token}`).send({ client_id: noEmailClient, title: "No email quote", items: [{ description: "Work", unit_price: 10 }] })).body.id;
    const res = await request(app).post(`/quotes/${quote}/send-email`).set("Authorization", `Bearer ${token}`).send({ confirmed: true });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "RECIPIENT_REQUIRED");

    globalThis.fetch = async () => Response.json({ id: "gmail-sent-3" });
    const explicit = await request(app).post(`/quotes/${quote}/send-email`).set("Authorization", `Bearer ${token}`).send({ confirmed: true, to: ["typed@example.test"] });
    assert.equal(explicit.status, 200);
    assert.deepEqual(explicit.body.to, ["typed@example.test"]);
  });

  it("refuses to send when a second sendable Gmail source is ambiguous", async () => {
    const second = await request(app).post("/connectors/sources").set("Authorization", `Bearer ${token}`)
      .send({ connector_key: "gmail", display_name: "Second Gmail", configured_scopes: ["send:messages"] });
    await prisma.connectorSource.update({ where: { id: second.body.id }, data: { isEnabled: true, connectionStatus: "enabled" } });
    await prisma.connectorCredential.create({
      data: { sourceId: second.body.id, companyId: TEST_COMPANY_ID, provider: "gmail", ...encryptConnectorPayload({ accessToken: "t2", refreshToken: "r2", scopes: [GMAIL_SEND_SCOPE], tokenType: "Bearer", expiresAt: "2099-01-01T00:00:00.000Z" }, `${TEST_COMPANY_ID}:${second.body.id}:gmail`) },
    });
    const res = await request(app).post(`/invoices/${invoiceId}/send-email`).set("Authorization", `Bearer ${token}`).send({});
    assert.equal(res.status, 409);
    assert.equal(res.body.error, "AMBIGUOUS_GMAIL_SOURCE");

    // Naming the source explicitly resolves the ambiguity.
    globalThis.fetch = async () => Response.json({ id: "gmail-sent-4" });
    const explicit = await request(app).post(`/invoices/${invoiceId}/send-email`).set("Authorization", `Bearer ${token}`).send({ confirmed: true, source_id: sourceId });
    assert.equal(explicit.status, 200);
    await prisma.connectorCredential.deleteMany({ where: { sourceId: second.body.id } });
    await prisma.connectorSource.delete({ where: { id: second.body.id } });
  });

  it("cross-tenant: company B cannot send company A's quote", async () => {
    const companyB = await prisma.company.create({ data: { name: "Delivery Co B" } });
    const bcrypt = (await import("bcryptjs")).default;
    await prisma.user.create({ data: { companyId: companyB.id, email: "delivery-b@test.local", passwordHash: await bcrypt.hash("Password123!", 10), displayName: "B", role: "admin", permissions: ["crm.read", "crm.manage"] } });
    const bToken = (await request(app).post("/auth/login").send({ email: "delivery-b@test.local", password: "Password123!" })).body.token;
    const res = await request(app).post(`/quotes/${quoteId}/send-email`).set("Authorization", `Bearer ${bToken}`).send({ confirmed: true });
    assert.equal(res.status, 404);
    assert.equal(res.body.error, "QUOTE_NOT_FOUND");
  });
});
