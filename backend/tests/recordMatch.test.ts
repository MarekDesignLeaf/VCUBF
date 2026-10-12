import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { matchRecord, type RecordCandidate } from "../src/lib/recordMatch.js";

const clients: RecordCandidate[] = [
  { id: "c1", label: "Jan Novák", names: ["Jan Novák"] },
  { id: "c2", label: "Petra Dvořáková", names: ["Petra Dvořáková"] },
  { id: "c3", label: "Novotný s.r.o.", names: ["Novotný s.r.o."] },
];

describe("finding a record by what was said", () => {
  it("takes a declined Czech or Polish name for the name", () => {
    assert.deepEqual(matchRecord("Nováka", clients), { outcome: "found", record: clients[0] });
    assert.deepEqual(matchRecord("pana Nováka", clients), { outcome: "found", record: clients[0] });
    assert.deepEqual(matchRecord("Dvořákovou", clients), { outcome: "found", record: clients[1] });
    assert.deepEqual(matchRecord("Janu Novákovi", clients), { outcome: "found", record: clients[0] });
    assert.deepEqual(matchRecord("Novotného", clients), { outcome: "found", record: clients[2] });
  });

  it("names back every record that fits equally well instead of picking one", () => {
    const twins = [...clients, { id: "c4", label: "Eva Nováková", names: ["Eva Nováková"] }, { id: "c5", label: "Jan Novák ml.", names: ["Jan Novák ml."] }];
    const result = matchRecord("Jan Novák", twins);
    // Said exactly as one of them is written: that one.
    assert.deepEqual(result, { outcome: "found", record: twins[0] });
    const vague = matchRecord("Nováka", [twins[0], twins[4]]);
    assert.equal(vague.outcome, "ambiguous");
  });

  it("finds a job, quote or invoice by its client as well as by its own title", () => {
    const jobs: RecordCandidate[] = [
      { id: "j1", label: "Plot, Jan Novák", names: ["Plot", "Jan Novák"] },
      { id: "j2", label: "Terasa, Jan Novák", names: ["Terasa", "Jan Novák"] },
      { id: "j3", label: "Plot, Petra Dvořáková", names: ["Plot", "Petra Dvořáková"] },
    ];
    assert.deepEqual(matchRecord("Plot u Nováka", jobs), { outcome: "found", record: jobs[0] });
    assert.deepEqual(matchRecord("terasu", jobs), { outcome: "found", record: jobs[1] });
    assert.equal(matchRecord("Nováka", jobs).outcome, "ambiguous", "two jobs of one client");
    assert.equal(matchRecord("Plot", jobs).outcome, "ambiguous", "two jobs of one title");
  });

  it("needs the very number for a number", () => {
    const invoices: RecordCandidate[] = [
      { id: "i1", label: "2026-014, Jan Novák", names: ["2026-014", "Zahrada", "Jan Novák"] },
      { id: "i2", label: "2026-015, Jan Novák", names: ["2026-015", "Zahrada", "Jan Novák"] },
    ];
    assert.deepEqual(matchRecord("2026-014", invoices), { outcome: "found", record: invoices[0] });
    assert.deepEqual(matchRecord("2026 015", invoices), { outcome: "found", record: invoices[1] });
    assert.deepEqual(matchRecord("2026-016", invoices), { outcome: "none" });
  });

  it("finds nothing for words that only start alike", () => {
    assert.deepEqual(matchRecord("Novinka", clients), { outcome: "none" });
    assert.deepEqual(matchRecord("pro", clients), { outcome: "none" }, "a joining word names nobody");
    assert.deepEqual(matchRecord("Ja", clients), { outcome: "none" });
  });
});
