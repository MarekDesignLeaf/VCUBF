import assert from "node:assert/strict";
import { test } from "node:test";
import { requestFingerprint } from "../src/lib/requestFingerprint.js";

const req = (method: string, url: string, body: unknown) => ({ method, originalUrl: url, body } as never);

test("fingerprint distinguishes method, path and body", () => {
  const a = requestFingerprint(req("POST", "/crm/clients", { name: "A" }));
  assert.equal(a, requestFingerprint(req("POST", "/crm/clients", { name: "A" })));
  assert.notEqual(a, requestFingerprint(req("POST", "/crm/clients", { name: "B" })));
  assert.notEqual(a, requestFingerprint(req("PUT", "/crm/clients", { name: "A" })));
  assert.notEqual(a, requestFingerprint(req("POST", "/crm/leads", { name: "A" })));
});
