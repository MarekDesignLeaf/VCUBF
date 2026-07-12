import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_MONEY, moneyLinesFit, nonnegativeMoney, positiveMoney } from "../src/lib/money.js";

describe("Money input validation", () => {
  it("accepts exact currency values and rejects silent rounding or NUMERIC overflow", () => {
    for (const value of [0, 0.1, 12.34, MAX_MONEY]) assert.equal(nonnegativeMoney.safeParse(value).success, true);
    for (const value of [-0.01, 0.001, 12.345, MAX_MONEY + 0.01, Number.POSITIVE_INFINITY]) {
      assert.equal(nonnegativeMoney.safeParse(value).success, false);
    }
    assert.equal(positiveMoney.safeParse(0).success, false);
    assert.equal(positiveMoney.safeParse(0.01).success, true);
    assert.equal(moneyLinesFit([{ quantity: 3, unitAmount: 0.1 }]), true);
    assert.equal(moneyLinesFit([{ quantity: 2, unitAmount: MAX_MONEY }]), false);
    assert.equal(moneyLinesFit([{ quantity: Number.MAX_VALUE, unitAmount: MAX_MONEY }]), false);
  });
});
