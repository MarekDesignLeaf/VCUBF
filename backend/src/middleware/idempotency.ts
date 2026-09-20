/**
 * Idempotency-Key middleware (Engineering Bible v6.1: CON-012, SEC-29 OAS-001, API-030).
 *
 * Applies to mutating methods on authenticated routes. Behaviour:
 *  - header absent            → proceeds (soft mode) unless IDEMPOTENCY_REQUIRED=1 → 400 IDEMPOTENCY_KEY_REQUIRED
 *  - first use                → row (company_id, key) IN_PROGRESS; JSON response captured on completion
 *  - replay, same request     → stored status/body, header Idempotency-Replayed: true
 *  - replay, different request→ 422 IDEMPOTENCY_KEY_REUSED
 *  - concurrent duplicate     → 409 IDEMPOTENCY_IN_PROGRESS (retryable: true) — only on the unique-index race (P2002)
 *  - client disconnect        → key is KEPT (the handler may still complete); never deleted on abort
 *  - handler ends without res.json (send/end/redirect) → key marked COMPLETED_UNCAPTURED; replay → 409 with retryable:false
 *  - 5xx responses are not memoised (row released) so a transient failure can be retried with the same key
 * Keys are tenant-scoped. Retention/expiry is a follow-up (not in this CP).
 */
import type { NextFunction, Request, Response } from "express";
import { Prisma } from "@prisma/client";
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
    const where = { companyId_key: { companyId, key } };

    const existing = await prisma.idempotencyKey.findUnique({ where });
    if (existing) {
      if (existing.requestHash !== requestHash) {
        return res.status(422).json({ code: "IDEMPOTENCY_KEY_REUSED", message: "Idempotency-Key was already used with a different request", retryable: false });
      }
      if (existing.state === "COMPLETED" && existing.responseStatus !== null) {
        res.setHeader("Idempotency-Replayed", "true");
        return res.status(existing.responseStatus).json(existing.responseBody);
      }
      if (existing.state === "COMPLETED_UNCAPTURED") {
        return res.status(409).json({ code: "IDEMPOTENCY_RESULT_UNAVAILABLE", message: "The original request completed but its response was not captured; inspect state before retrying", retryable: false });
      }
      return res.status(409).json({ code: "IDEMPOTENCY_IN_PROGRESS", message: "An identical request is still being processed", retryable: true });
    }
    try {
      await prisma.idempotencyKey.create({ data: { companyId, userId: req.user.id, key, requestHash, state: "IN_PROGRESS" } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return res.status(409).json({ code: "IDEMPOTENCY_IN_PROGRESS", message: "An identical request is still being processed", retryable: true });
      }
      throw error; // surfaced by requireAuth as 503 IDEMPOTENCY_STORE_UNAVAILABLE
    }

    let captured = false;
    const originalJson = res.json.bind(res);
    res.json = ((body: unknown) => {
      captured = true;
      const status = res.statusCode;
      const op = status >= 500
        ? prisma.idempotencyKey.delete({ where })          // do not memoise server failures
        : prisma.idempotencyKey.update({ where, data: { state: "COMPLETED", responseStatus: status, responseBody: body === null || body === undefined ? Prisma.JsonNull : (body as Prisma.InputJsonValue), completedAt: new Date() } });
      void op.catch(() => undefined);
      return originalJson(body);
    }) as typeof res.json;
    res.on("finish", () => {
      if (!captured) {
        // Response ended via send/end/redirect: the mutation may have happened; keep the key but mark it uncaptured.
        void prisma.idempotencyKey.update({ where, data: { state: "COMPLETED_UNCAPTURED", responseStatus: res.statusCode, completedAt: new Date() } }).catch(() => undefined);
      }
    });
    return next();
  };
}
