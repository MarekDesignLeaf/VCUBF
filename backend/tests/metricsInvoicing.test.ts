import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { summariseInvoicing } from "../src/services/metricsService.js";

const day = 86_400_000;
const to = new Date("2026-09-30T23:59:59.000Z");
const from = new Date(to.getTime() - 30 * day);
const current = { from, to };
const previous = { from: new Date(from.getTime() - 30 * day - 1), to: new Date(from.getTime() - 1) };

describe("summariseInvoicing (pure)", () => {
  it("returns zeros and unknown settle time when there are no issued invoices", () => {
    const result = summariseInvoicing([], current, previous);
    assert.equal(result.issued.count.current, 0);
    assert.equal(result.outstanding.count, 0);
    assert.equal(result.averageDaysToSettle, null);
    assert.equal(result.settledInvoiceCount, 0);
  });

  it("measures outstanding at the end of the period, ignoring payments recorded after it", () => {
    const issue = new Date(from.getTime() + 5 * day);
    const result = summariseInvoicing([
      { id: "a", issueDate: issue, dueDate: new Date(from.getTime() + 10 * day), items: [{ quantity: 1, unitPrice: 100 }], payments: [{ amount: 100, paidAt: new Date(to.getTime() + day) }] },
    ], current, previous);
    assert.equal(result.outstanding.count, 1, "the payment landed after the period end");
    assert.equal(result.outstanding.overdueCount, 1);
    assert.equal(result.paymentsReceived.count.current, 0);
    assert.equal(result.averageDaysToSettle, null);
  });

  it("uses the payment that completed the balance as the settlement date", () => {
    const issue = new Date(from.getTime() + 1 * day);
    const result = summariseInvoicing([
      { id: "a", issueDate: issue, dueDate: null, items: [{ quantity: 2, unitPrice: 50 }], payments: [
        { amount: 40, paidAt: new Date(issue.getTime() + 2 * day) },
        { amount: 60, paidAt: new Date(issue.getTime() + 8 * day) },
      ] },
    ], current, previous);
    assert.equal(result.averageDaysToSettle, 8);
    assert.equal(result.outstanding.count, 0);
    assert.equal(result.outstanding.withoutDueDateCount, 0);
  });

  it("never marks an invoice without a due date as overdue", () => {
    const result = summariseInvoicing([
      { id: "a", issueDate: new Date(from.getTime() - 100 * day), dueDate: null, items: [{ quantity: 1, unitPrice: 10 }], payments: [] },
    ], current, previous);
    assert.equal(result.outstanding.count, 1);
    assert.equal(result.outstanding.overdueCount, 0);
    assert.equal(result.outstanding.withoutDueDateCount, 1);
  });
});
