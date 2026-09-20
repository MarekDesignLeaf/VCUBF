/**
 * Idempotency-Key middleware (Engineering Bible v6.1: CON-012, SEC-29 OAS-001, API-030).
 *
 * Applies to mutating methods on authenticated routes. Behaviour:
 *  - header absent  → request proceeds (soft mode) unless IDEMPOTENCY_REQUIRED=1, then 400 IDEMPOTENCY_KEY_REQUIRED
 *  - first use      → row (company_id, key) IN_PROGRESS; response captured and stored on finish
 *  - replay, same body   → stored status/body returned, header Idempotency-Replayed: true
 *  - replay, different body → 422 IDEMPOTENCY_KEY_REUSED
 *  - concurrent replay while IN_PROGRESS → 409 IDEMPOTENCY_IN_PROGRESS (retryable: true)
 * Keys are scoped to the tenant (company) — never global — and expire by retention job (not in this CP).
 */
import type { NextFunction, Request, Response } from "express";
import { prisma } from "../db.js";
import { requestFingerprint } from "../lib/requestFingerprint.js";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const KEY_MAX = 200;

export function idempotency() {
  return async function idempotencyMiddleware(req: Request, res: Response, next: NextFunction) {
    if (!MUTATING.has(req.method) || !req.user) return next();
    const key = req.header("Idempotency-Key");
    if (!key) {
      if (process.env.IDEMPOTENCY_REQUIRED === "1") {
        return res.status(400).json({ code: "IDEMPOTENCY_KEY_REQUIRED", message: "Idempotency-Key header is required on mutating requests", retryable: false });
      }
      return next();
    }
    if (key.length > KEY_MAX) return res.status(400).json({ code: "IDEMPOTENCY_KEY_TOO_LONG", message: `max ${KEY_MAX} chars`, retryable: false });
    const companyId = req.user.companyId;
    const requestHash = requestFingerprint(req);
    const existing = await prisma.idempotencyKey.findUnique({ where: { companyId_key: { companyId, key } } });
    if (existing) {
      if (existing.requestHash !== requestHash) {
        return res.status(422).json({ code: "IDEMPOTENCY_KEY_REUSED", message: "Idempotency-Key was already used with a different request", retryable: false });
      }
      if (existing.state !== "COMPLETED" || existing.responseStatus === null) {
        return res.status(409).json({ code: "IDEMPOTENCY_IN_PROGRESS", message: "An identical request is still being processed", retryable: true });
      }
      res.setHeader("Idempotency-Replayed", "true");
      return res.status(existing.responseStatus).json(existing.responseBody);
    }
    try {
      await prisma.idempotencyKey.create({ data: { companyId, userId: req.user.id, key, requestHash, state: "IN_PROGRESS" } });
    } catch {
      // Lost a race with a concurrent identical request.
      return res.status(409).json({ code: "IDEMPOTENCY_IN_PROGRESS", message: "An identical request is still being processed", retryable: true });
    }
    // Capture the JSON response so a replay can return it verbatim.
    const originalJson = res.json.bind(res);
    res.json = ((body: unknown) => {
      const status = res.statusCode;
      void prisma.idempotencyKey.update({
        where: { companyId_key: { companyId, key } },
        data: { state: "COMPLETED", responseStatus: status, responseBody: body as never, completedAt: new Date() },
      }).catch(() => { /* audit/observability hook: recording a replay body must never fail the request */ });
      return originalJson(body);
    }) as typeof res.json;
    res.on("close", () => {
      if (!res.writableFinished) {
        void prisma.idempotencyKey.delete({ where: { companyId_key: { companyId, key } } }).catch(() => undefined);
      }
    });
    return next();
  };
}
