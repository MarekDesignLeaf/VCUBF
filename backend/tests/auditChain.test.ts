import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalJson, computeEntryHash, GENESIS_HASH, verifyChain } from "../src/lib/auditChain.js";

const base = (n: number, prevHash: string) => {
  const fields = {
    companyId: "c1", userId: "u1", actionName: `a${n}`, interpretedIntent: null,
    inputPayload: { b: 2, a: 1 }, dataBefore: undefined, dataAfter: { x: [1, 2] },
    riskLevel: 2, confirmationRequired: false, confirmed: false, result: "success",
    errorMessage: null, createdAt: new Date("2026-09-20T10:00:00Z"), sequenceNo: BigInt(n),
  };
  return { ...fields, prevHash, entryHash: computeEntryHash(prevHash, fields) };
};

test("canonicalJson sorts keys and drops undefined", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: undefined, c: 2 } }), '{"a":{"c":2},"b":1}');
  assert.equal(canonicalJson([3n, new Date(0)]), '["3","1970-01-01T00:00:00.000Z"]');
});

test("valid chain verifies", () => {
  const e1 = base(1, GENESIS_HASH); const e2 = base(2, e1.entryHash); const e3 = base(3, e2.entryHash);
  assert.deepEqual(verifyChain([e1, e2, e3]), { ok: true, checked: 3 });
});

test("tampered payload breaks the chain at that entry", () => {
  const e1 = base(1, GENESIS_HASH); const e2 = base(2, e1.entryHash);
  const tampered = { ...e2, inputPayload: { b: 2, a: 999 } };
  const r = verifyChain([e1, tampered]);
  assert.equal(r.ok, false); assert.equal(r.firstBrokenSequenceNo, "2"); assert.equal(r.reason, "ENTRY_HASH_MISMATCH");
});

test("deleted entry breaks the chain at the next entry", () => {
  const e1 = base(1, GENESIS_HASH); const e2 = base(2, e1.entryHash); const e3 = base(3, e2.entryHash);
  const r = verifyChain([e1, e3]);
  assert.equal(r.ok, false); assert.equal(r.firstBrokenSequenceNo, "3"); assert.equal(r.reason, "PREV_HASH_MISMATCH");
});

test("hash is stable across key order and undefined fields", () => {
  const a = base(1, GENESIS_HASH);
  const b = { ...a, inputPayload: { a: 1, b: 2 }, dataBefore: null };
  assert.equal(computeEntryHash(GENESIS_HASH, b), a.entryHash);
});
