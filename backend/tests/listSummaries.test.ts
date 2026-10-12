import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { spokenListSummary } from "../src/lib/spokenActionMessages.js";

// "ukaž zakázky" opens the page and says what it lists: how many, and the
// newest by name. Counted from the rows read, nothing else (12. 10.: Marek,
// "všechno v aplikaci hlasem").

const at = (iso: string) => new Date(iso).toISOString();

describe("what a list says when it is opened by voice", () => {
  it("counts the clients and names the newest three", () => {
    const rows = ["Jan Novák", "Petra Dvořáková", "Eva Malá", "Josef Starý"].map((displayName, index) => ({ displayName, createdAt: at(`2026-10-0${index + 1}T10:00:00Z`) }));
    assert.equal(spokenListSummary("list_clients", rows, "cs-CZ"), "Máte 4 klienty. Nejnovější: Josef Starý, Eva Malá a Petra Dvořáková.");
    assert.equal(spokenListSummary("list_clients", rows.slice(0, 1), "en-GB"), "You have 1 client. Newest: Jan Novák.");
    assert.equal(spokenListSummary("list_clients", [], "pl-PL"), "Masz 0 klientów.");
  });

  it("counts open jobs apart from finished and cancelled ones", () => {
    const rows = [
      { jobTitle: "Plot", jobStatus: "v_realizaci", client: { displayName: "Jan Novák" }, createdAt: at("2026-10-02T10:00:00Z") },
      { jobTitle: "Terasa", jobStatus: "dokonceno", client: { displayName: "Eva Malá" }, createdAt: at("2026-10-03T10:00:00Z") },
      { jobTitle: "Zeď", jobStatus: "zruseno", client: { displayName: "Eva Malá" }, createdAt: at("2026-10-04T10:00:00Z") },
    ];
    assert.equal(spokenListSummary("list_jobs", rows, "cs-CZ"), "Máte 3 zakázky, rozpracovaných 1. Nejnovější: Plot (Jan Novák).");
  });

  it("counts open tasks, those due today and those overdue, in UK time", () => {
    const now = new Date("2026-10-12T09:00:00Z");
    const rows = [
      { taskStatus: "open", dueAt: at("2026-10-12T15:00:00Z") },
      { taskStatus: "in_progress", dueAt: at("2026-10-10T08:00:00Z") },
      { taskStatus: "open", dueAt: null },
      { taskStatus: "completed", dueAt: at("2026-10-01T08:00:00Z") },
    ];
    assert.equal(spokenListSummary("list_tasks", rows, "cs-CZ", now), "Máte 3 otevřené úkoly, na dnešek 1 a po termínu 1.");
    assert.equal(spokenListSummary("list_tasks", rows, "en-GB", now), "You have 3 open tasks, 1 due today and 1 overdue.");
  });

  it("splits quotes and leads by where they stand", () => {
    const quotes = [{ quoteStatus: "draft" }, { quoteStatus: "sent" }, { quoteStatus: "sent" }, { quoteStatus: "accepted" }];
    assert.equal(spokenListSummary("list_quotes", quotes, "cs-CZ"), "Máte 4 nabídky, rozpracovaných 1, odeslaných 2 a přijatých 1.");
    const leads = [{ name: "Malá", leadStatus: "new", createdAt: at("2026-10-01T10:00:00Z") }, { name: "Starý", leadStatus: "lost", createdAt: at("2026-10-02T10:00:00Z") }];
    assert.equal(spokenListSummary("list_leads", leads, "en-GB"), "You have 2 leads, 1 new. Newest: Malá.");
  });

  it("says nothing more for a command that lists nothing", () => {
    assert.equal(spokenListSummary("navigate", undefined, "cs-CZ"), undefined);
    assert.equal(spokenListSummary("create_client", { id: "x" }, "cs-CZ"), undefined);
  });
});

describe("what the other lists say", () => {
  const now = new Date("2026-10-12T10:00:00Z");

  it("splits invoices into drafts, unpaid and overdue, and documents by expiry", () => {
    const invoices = [
      { invoiceStatus: "draft", totals: { balance: 100 } },
      { invoiceStatus: "issued", totals: { balance: 250 }, isOverdue: true },
      { invoiceStatus: "issued", totals: { balance: 80 }, isOverdue: false },
      { invoiceStatus: "paid", totals: { balance: 0 } },
    ];
    assert.equal(spokenListSummary("list_invoices", invoices, "cs-CZ", now), "Máte 4 faktury, konceptů 1, neuhrazených 2 a po splatnosti 1.");
    assert.equal(spokenListSummary("list_invoices", invoices, "en-GB", now), "You have 4 invoices, 1 draft, 2 unpaid and 1 overdue.");
    assert.equal(spokenListSummary("list_invoices", [...invoices, { invoiceStatus: "void", totals: { balance: 0 } }], "en-GB", now), "You have 4 invoices, 1 draft, 2 unpaid and 1 overdue.", "a voided invoice is not counted");
    const documents = [
      { isActive: true, expiresAt: "2026-10-20T00:00:00Z" },
      { isActive: true, expiresAt: "2026-09-01T00:00:00Z" },
      { isActive: true, expiresAt: null },
      { isActive: true, expiresAt: "2027-06-01T00:00:00Z" },
      { isActive: true, expiresAt: "2026-10-30T00:00:00Z" },
    ];
    assert.equal(spokenListSummary("list_documents", documents, "cs-CZ", now), "Máte 5 dokumentů, do 30 dnů vyprší 2 a prošlých 1.");
  });

  it("counts services and playbooks, and those switched off", () => {
    assert.equal(spokenListSummary("list_services", [{ isActive: true }, { isActive: false }], "cs-CZ"), "Máte 2 služby, vypnutých 1.");
    assert.equal(spokenListSummary("list_playbooks", [{ isActive: true }], "pl-PL"), "Masz 1 procedurę.");
  });

  it("says what needs attention by kind, the most first, and when nothing does", () => {
    const feed = [
      { type: "overdue_task", severity: "warning" }, { type: "overdue_task", severity: "warning" }, { type: "overdue_task", severity: "urgent" },
      { type: "invoice_overdue", severity: "urgent" }, { type: "invoice_overdue", severity: "urgent" },
      { type: "unresolved_enquiry", severity: "info" },
      { type: "stale_lead", severity: "info" },
    ];
    assert.equal(
      spokenListSummary("list_notifications", feed, "cs-CZ"),
      "Máte 7 upozornění, naléhavých 3. Hlavně: úkoly po termínu 3, faktury po splatnosti 2 a nevyřízené dotazy 1.",
    );
    assert.equal(spokenListSummary("list_notifications", [], "cs-CZ"), "Nic teď nevyžaduje pozornost.");
  });

  it("names who is waiting longest, and whom to follow up", () => {
    const enquiries = [
      { senderLabel: "Eva Malá", receivedAt: "2026-10-10T10:00:00Z", overdue: false },
      { senderLabel: "+447700900111", receivedAt: "2026-10-01T10:00:00Z", overdue: true },
    ];
    assert.equal(spokenListSummary("list_unresolved_enquiries", enquiries, "cs-CZ"), "Máte 2 nevyřízené dotazy, po termínu 1. Nejdéle čekají: +447700900111 a Eva Malá.");
    assert.equal(spokenListSummary("list_unresolved_enquiries", [{ senderLabel: "Unknown sender", receivedAt: "2026-10-01T10:00:00Z" }], "cs-CZ"), "Máte 1 nevyřízený dotaz.", "a sender with no name is counted, not named in English");
    const followUps = [{ client: { displayName: "Jan Novák" } }, { client: { displayName: "Jan Novák" } }, { client: { displayName: "Eva Malá" } }];
    assert.equal(spokenListSummary("list_follow_ups", followUps, "cs-CZ"), "Máte 3 připomenutí klientům: Jan Novák a Eva Malá.");
  });

  it("says the data-quality report as two counts, or that it is clean", () => {
    assert.equal(spokenListSummary("list_data_quality", { duplicateClientGroups: [{}, {}], missingContactIssues: [{}] }, "cs-CZ"), "K řešení: možné duplicity klientů 2 a klienti bez kontaktu 1.");
    assert.equal(spokenListSummary("list_data_quality", { duplicateClientGroups: [], missingContactIssues: [] }, "en-GB"), "I see no data problems right now.");
  });
});
