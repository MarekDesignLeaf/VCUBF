import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import request from "supertest";
import { prisma } from "../src/db.js";
import { createServer } from "../src/server.js";
import { BUSINESS_TIME_ZONE, localDateTime, resolveSpokenDate, zonedInstant } from "../src/lib/spokenDate.js";
import { resetDb, seedCompanyAndAdmin } from "./setup.js";

// Edits the pages make, said instead (Marek, 12. 10.: "doplň všechny funkce").
// The record is found by name as said; a price or an invoice is read back and
// changes only after the yes; a task's new day is resolved in UK time.

const app = createServer();

describe("Editing by voice", () => {
  let token = "";
  const say = (text: string) => request(app).post("/command/assistant").set("Authorization", `Bearer ${token}`).send({ text, input_method: "voice_transcript" });
  const api = (method: "post" | "put", path: string, body: unknown) => request(app)[method](path).set("Authorization", `Bearer ${token}`).send(body as object);

  before(async () => {
    await resetDb();
    await seedCompanyAndAdmin();
    token = (await request(app).post("/auth/login").send({ email: "admin@test.local", password: "Password123!" })).body.token;
  });

  after(async () => {
    await resetDb();
    await prisma.$disconnect();
  });

  it("moves a task to a spoken day without the model, and assigns it to someone named as said", async () => {
    const task = (await api("post", "/tasks", { title: "Objednat materiál" })).body;
    // The account speaks English here; the Czech "přesuň úkol … na pátek" is the same action (commandParser tests).
    const moved = await say("Move task Objednat materiál to Friday.");
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.equal(moved.body.message, "The task “Objednat materiál” has been updated.");
    const friday = resolveSpokenDate("Friday", localDateTime(new Date(), BUSINESS_TIME_ZONE).date)!;
    const stored = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    assert.equal(stored.dueAt?.toISOString(), zonedInstant(friday, "00:00", BUSINESS_TIME_ZONE).toISOString());

    const admin = await prisma.user.findFirstOrThrow({ where: { email: "admin@test.local" } });
    const assigned = await say(`voice action update_task {"task":"objednat materiál","assignee":"${admin.displayName}"}`);
    assert.equal(assigned.status, 200, JSON.stringify(assigned.body));
    assert.equal((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).assignedUserId, admin.id);
  });

  it("reads a price change back and saves it only after the yes", async () => {
    const service = (await api("post", "/service-catalogue", { name: "Údržba zahrady", base_price_min: 300 })).body;
    const review = await say('voice action update_service {"service":"údržbu zahrady","price_min":450}');
    assert.equal(review.status, 409, JSON.stringify(review.body));
    assert.equal(review.body.error, "CONFIRMATION_REQUIRED");
    assert.match(review.body.message, /^I will change the service “Údržba zahrady”: price from £450\.00\. Shall I save it\?$/);
    assert.equal(Number((await prisma.serviceCatalogueItem.findUniqueOrThrow({ where: { id: service.id } })).basePriceMin), 300, "nothing changes before the yes");

    const yes = await say("yes");
    assert.equal(yes.status, 200, JSON.stringify(yes.body));
    assert.equal(yes.body.message, "The service “Údržba zahrady” has been updated.");
    assert.equal(Number((await prisma.serviceCatalogueItem.findUniqueOrThrow({ where: { id: service.id } })).basePriceMin), 450);
  });

  it("changes a draft invoice's due date after the yes, and refuses an issued one", async () => {
    const client = (await api("post", "/crm/clients", { display_name: "Jan Novák" })).body;
    const draft = (await api("post", "/invoices", { client_id: client.id, invoice_number: "2026-020", title: "Zahrada", items: [{ description: "Zahrada", quantity: 1, unit_price: 100 }] })).body;
    const review = await say('voice action update_invoice {"invoice":"2026-020","due_date":"16 October"}');
    assert.equal(review.status, 409, JSON.stringify(review.body));
    assert.match(review.body.message, /^I will change the invoice 2026-020 \(Jan Novák\): due date \d{1,2} October \d{4}\. Shall I save it\?$/);
    const yes = await say("yes");
    assert.equal(yes.status, 200, JSON.stringify(yes.body));
    const dueKey = resolveSpokenDate("16 October", localDateTime(new Date(), BUSINESS_TIME_ZONE).date);
    assert.equal((await prisma.invoice.findUniqueOrThrow({ where: { id: draft.id } })).dueDate?.toISOString(), `${dueKey}T00:00:00.000Z`);

    await api("put", `/invoices/${draft.id}/status`, { invoice_status: "issued" });
    const refused = await say('voice action update_invoice {"invoice":"2026-020","title":"Jiný název"}');
    assert.equal(refused.body.error, "INVOICE_NOT_EDITABLE");
    assert.equal(refused.body.message, "Only a draft invoice can be changed. An issued invoice has to be voided and replaced.");
  });

  it("turns the user's own daily summary on at a UK hour", async () => {
    const response = await say('voice action set_notification_digest {"enabled":true,"hour":7}');
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.message, "The daily summary is on, sent at 07:00.");
    const stored = await prisma.user.findFirstOrThrow({ where: { email: "admin@test.local" } });
    assert.equal(stored.digestEnabled, true);
    assert.equal(stored.digestHourUtc, zonedInstant(localDateTime(new Date(), BUSINESS_TIME_ZONE).date, "07:00", BUSINESS_TIME_ZONE).getUTCHours());
  });

  it("names what it could not find", async () => {
    const response = await say('voice action update_task {"task":"neexistující věc","due":"zítra"}');
    assert.equal(response.body.error, "RECORD_NOT_FOUND");
    assert.equal(response.body.message, "I could not find a task called “neexistující věc”.");
  });
});
