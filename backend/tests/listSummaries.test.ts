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
