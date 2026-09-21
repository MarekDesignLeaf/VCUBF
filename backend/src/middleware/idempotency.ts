import { createHash } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { prisma } from "../db.js";

/**
 * Write idempotency — VCUBF Master Documentation section 43.
 *
 * A network retry must not cause two invoices, two payments, two purchase
 * orders, two customer messages or two bookings. The caller decides which
 * requests it may repeat by sending an Idempotency-Key header; the server then
 * guarantees that the key performs its work at most once and that every later
 * attempt receives the first attempt's answer rather than doing the work again.
 *
 * The key is scoped to the company, so two tenants can choose the same key
 * without meeting. It is bound to the request it was first used for: reusing
 * one key for a different request is refused rather than answered, because
 * replaying the wrong stored response would be worse than either outcome.
 *
 * Section 44 is the other half of this. Between a first attempt being accepted
 * and its response being recorded, its outcome is genuinely unknown, and a
 * retry arriving in that window is told so rather than being allowed to act
 * again. An unknown outcome is reconciled, never repeated.
 *
 * Deliberate limits, each for a reason:
 *   - Opt-in. A request without the header behaves exactly as before, so no
 *     existing client changes behaviour and nothing silently starts failing.
 *   - Only JSON responses can be replayed. A response the middleware could not
 *     capture leaves no record, so the caller may retry and genuinely repeat
 *     the work — which is the honest outcome, not a false promise.
 *   - A server error is not stored. A 5xx is the case where retrying is the
 *     right thing to do; remembering it would turn one transient fault into a
 *     permanent one.
 */

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const RETENTION_HOURS = 24;
const MAX_KEY_LENGTH = 200;

/** The request this key was first used for, as one comparable value. */
function fingerprint(req: Request): string {
  const body = req.body === undefined ? "" : JSON.stringify(req.body);
  return createHash("sha256").update(`${req.method} ${req.originalUrl}\n${body}`).digest("hex");
}

function replay(res: Response, record: { responseStatus: number | null; responseBody: unknown }) {
  res.set("Idempotent-Replay", "true");
  return res.status(record.responseStatus ?? 200).json(record.responseBody ?? {});
}

/**
 * Runs immediately after authentication, where the company is known.
 *
 * Returns nothing and calls next() when the request should proceed; answers the
 * request itself when this key has already been seen.
 */
export async function idempotencyGuard(req: Request, res: Response, next: NextFunction) {
  const key = req.header("Idempotency-Key")?.trim();
  if (!key || !MUTATING.has(req.method) || !req.user) return next();
  if (key.length > MAX_KEY_LENGTH) {
    return res.status(400).json({ error: "IDEMPOTENCY_KEY_TOO_LONG", message: `An Idempotency-Key may be at most ${MAX_KEY_LENGTH} characters.` });
  }

  const companyId = req.user.companyId;
  const current = fingerprint(req);
  const expiresAt = new Date(Date.now() + RETENTION_HOURS * 60 * 60 * 1000);

  let claimed = false;
  for (let attempt = 0; attempt < 2 && !claimed; attempt += 1) {
    try {
      await prisma.idempotencyRecord.create({
        data: { companyId, userId: req.user.id, key, fingerprint: current, status: "in_progress", expiresAt },
      });
      claimed = true;
    } catch {
      const existing = await prisma.idempotencyRecord.findUnique({ where: { companyId_key: { companyId, key } } });
      if (!existing) continue; // It was removed between the failed insert and this read.
      if (existing.expiresAt <= new Date()) {
        // Past its retention: the first attempt is no longer replayable, so the
        // key is free again rather than blocked for ever.
        await prisma.idempotencyRecord.delete({ where: { id: existing.id } }).catch(() => undefined);
        continue;
      }
      if (existing.fingerprint !== current) {
        return res.status(409).json({
          error: "IDEMPOTENCY_KEY_REUSED",
          message: "This Idempotency-Key was already used for a different request.",
        });
      }
      if (existing.status === "completed") return replay(res, existing);
      return res.status(409).json({
        error: "IDEMPOTENCY_IN_PROGRESS",
        message: "The first attempt with this key has not finished. Its outcome is unknown; do not repeat it.",
      });
    }
  }
  if (!claimed) return next();

  let captured: unknown;
  let capturedStatus = 0;
  const sendJson = res.json.bind(res);
  res.json = (body: unknown) => {
    captured = body;
    capturedStatus = res.statusCode;
    return sendJson(body);
  };

  res.on("finish", () => {
    const keepable = capturedStatus > 0 && capturedStatus < 500;
    const finish = keepable
      ? prisma.idempotencyRecord.updateMany({
          where: { companyId, key },
          data: { status: "completed", responseStatus: capturedStatus, responseBody: captured as never },
        })
      // Nothing to replay, or the failure is one the caller should be allowed
      // to retry. Either way the key must not stay claimed.
      : prisma.idempotencyRecord.deleteMany({ where: { companyId, key, status: "in_progress" } });
    void Promise.resolve(finish).catch(() => undefined);
  });

  return next();
}
