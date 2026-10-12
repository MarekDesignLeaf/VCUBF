import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import request from "supertest";
import { prisma } from "../src/db.js";
import { createServer } from "../src/server.js";
import { findRecordToOpen } from "../src/services/recordLookupService.js";
import { resetDb, seedCompanyAndAdmin, TEST_COMPANY_ID } from "./setup.js";

// "Otevři klienta Nováka": what a click in a list does, said instead. The
// record is looked up in the user's own company only, a declined name is taken
// for the name, and two records that fit equally are named back, not guessed.

const app = createServer();

describe("Opening a record by voice", () => {
  let token = "";
  let novak = "";
  let job = "";
  let invoice = "";

  const say = (text: string, language = "cs-CZ") =>
    request(app).post("/command/assistant").set("Authorization", `Bearer ${token}`).send({ text, input_method: "voice_transcript", language });

  before(async () => {
    await resetDb();
    await seedCompanyAndAdmin();
    await prisma.user.update({ where: { email: "admin@test.local" }, data: { voiceLanguage: "cs-CZ" } });
    token = (await request(app).post("/auth/login").send({ email: "admin@test.local", password: "Password123!" })).body.token;
    novak = (await prisma.client.create({ data: { companyId: TEST_COMPANY_ID, displayName: "Jan Novák" } })).id;
    const dvorakova = (await prisma.client.create({ data: { companyId: TEST_COMPANY_ID, displayName: "Petra Dvořáková" } })).id;
    job = (await prisma.job.create({ data: { companyId: TEST_COMPANY_ID, clientId: novak, jobTitle: "Plot" } })).id;
    await prisma.job.create({ data: { companyId: TEST_COMPANY_ID, clientId: dvorakova, jobTitle: "Plot" } });
    const created = await request(app).post("/invoices").set("Authorization", `Bearer ${token}`)
      .send({ client_id: novak, invoice_number: "2026-014", title: "Zahrada", items: [{ description: "Zahrada", quantity: 1, unit_price: 100 }] });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    invoice = created.body.id;
    // Another company's client of the same name is never found.
    const other = await prisma.company.create({ data: { name: "Other Co" } });
    await prisma.client.create({ data: { companyId: other.id, displayName: "Jan Novák" } });
  });

  after(async () => {
    await resetDb();
    await prisma.$disconnect();
  });

  it("opens the client said in the accusative, without the model", async () => {
    const response = await say("Otevři klienta Nováka.");
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.intent, "open_record");
    assert.equal(response.body.message, "Otevírám klienta Jan Novák.");
    assert.deepEqual(response.body.uiAction, { kind: "navigate", path: `/clients/${novak}`, label: "Klienti" });
  });

  it("opens a job by its title and its client, and asks when two fit", async () => {
    const one = await say("ukaž zakázku Plot u Nováka");
    assert.equal(one.body.message, "Otevírám zakázku Plot (Jan Novák).");
    assert.equal(one.body.uiAction.path, `/jobs/${job}`);

    const two = await say("ukaž zakázku Plot");
    assert.equal(two.status, 409);
    assert.equal(two.body.error, "AMBIGUOUS_REFERENCE");
    assert.match(two.body.message, /^Tomu odpovídá víc záznamů: Plot \((?:Jan Novák|Petra Dvořáková)\) a Plot \((?:Jan Novák|Petra Dvořáková)\)\. Řekněte to přesněji\.$/);
    assert.match(two.body.message, /Jan Novák/);
    assert.match(two.body.message, /Petra Dvořáková/);
    assert.equal(two.body.uiAction, undefined, "nothing is opened while it is unclear which");
  });

  it("opens an invoice by its number on the invoice list, picked out", async () => {
    const response = await say("najdi fakturu číslo 2026-014");
    assert.equal(response.body.message, "Otevírám fakturu 2026-014 (Jan Novák).");
    assert.equal(response.body.uiAction.path, `/invoices?invoice=${invoice}`);
  });

  it("says when there is no such record", async () => {
    const response = await say("otevři klienta Svobodu");
    assert.equal(response.status, 404);
    assert.equal(response.body.message, "Nenašel jsem klienta „Svobodu“.");
    assert.equal(response.body.uiAction, undefined);
  });

  it("needs the permission the record's list needs", async () => {
    const user = { id: "u", companyId: TEST_COMPANY_ID, permissions: ["voice.execute"], voiceLanguage: "cs-CZ" } as never;
    const refused = await findRecordToOpen(user, "client", "Nováka");
    assert.equal(refused.ok, false);
    assert.equal(!refused.ok && refused.error, "MISSING_PERMISSION");
  });
});
