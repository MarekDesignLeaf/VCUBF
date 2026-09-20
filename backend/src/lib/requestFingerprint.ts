import { createHash } from "node:crypto";
import { canonicalJson } from "./auditChain.js";

/** Fingerprint of a mutating request: method + path + canonical JSON body (key-order independent). Pure. */
export function requestFingerprint(req: { method: string; originalUrl: string; body?: unknown }): string {
  const h = createHash("sha256");
  h.update(req.method); h.update("\n"); h.update(req.originalUrl); h.update("\n");
  h.update(canonicalJson(req.body ?? null));
  return h.digest("hex");
}
