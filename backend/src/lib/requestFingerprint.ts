import { createHash } from "node:crypto";

/** Fingerprint of a mutating request: method + path + JSON body. Pure — used by the idempotency middleware and its tests. */
export function requestFingerprint(req: { method: string; originalUrl: string; body?: unknown }): string {
  const h = createHash("sha256");
  h.update(req.method); h.update("\n"); h.update(req.originalUrl); h.update("\n");
  h.update(JSON.stringify(req.body ?? null));
  return h.digest("hex");
}
