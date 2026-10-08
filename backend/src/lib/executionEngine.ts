/**
 * The Execution Engine, step one: the reviewed-action state machine.
 *
 * Third step of the agent plan (docs/AGENT_MASTERPLAN_2026-10-08.md, F0.3,
 * layer A). Seven services each kept their own copy of the same lifecycle —
 * prepare a review, wait for a yes, claim it exactly once, execute, resolve —
 * over the shared VoicePendingAction table, so a rule like "warn when exactly
 * this was already sent" had to be wired into four places. This module owns
 * that lifecycle once; the services keep what is genuinely theirs: the
 * permission wording, the preview, the execution itself and the audit entries
 * with their contracts. They migrate here one at a time, each under its own
 * existing tests. The fuller engine of the masterplan — one pipeline of
 * validation, policy, risk, audit and verification — grows on this state
 * machine when agent proposals arrive (F1/F2); it is deliberately not written
 * speculatively now.
 *
 * Guarantees the lifecycle makes, identical to the copies it replaces:
 *  - one review per user and action type: preparing cancels the previous one;
 *  - a review expires on its own; an expired review cannot be confirmed;
 *  - a claim succeeds exactly once, so two simultaneous confirmations cannot
 *    both execute (the loser sees "raced");
 *  - a stored payload that no longer parses fails the review instead of
 *    executing something half-read;
 *  - resolved reviews drop their payload: message text does not outlive the
 *    decision it was shown for.
 */

import { Prisma } from "@prisma/client";
import type { z } from "zod";
import { prisma } from "../db.js";

/** The engine needs no more identity than tenant and user. */
export interface ActingUser {
  id: string;
  companyId: string;
}

export interface ReviewedActionDefinition<Payload> {
  /** VoicePendingAction.actionType — the queue this review waits in. */
  actionType: string;
  /** How long the review waits for its yes. */
  lifetimeMs: number;
  /** The stored payload's shape; what no longer parses is not executed. */
  payloadSchema: z.ZodType<Payload>;
  /**
   * The status a claimed review carries while it executes. Kept per action
   * type because existing rows and tests know the current words.
   */
  claimedStatus?: string;
}

function scope(user: ActingUser, actionType: string) {
  return { companyId: user.companyId, userId: user.id, actionType };
}

/** Reviews whose time ran out are marked expired and lose their payload. */
export async function expireReviewedActions(user: ActingUser, actionType: string, now = new Date()): Promise<void> {
  await prisma.voicePendingAction.updateMany({
    where: { ...scope(user, actionType), status: "pending", expiresAt: { lte: now } },
    data: { status: "expired", payload: Prisma.DbNull, resolvedAt: now },
  });
}

/** Whether a review of this type is still waiting for its yes. */
export async function hasReviewedActionPending(user: ActingUser, actionType: string, now = new Date()): Promise<boolean> {
  await expireReviewedActions(user, actionType, now);
  return Boolean(
    await prisma.voicePendingAction.findFirst({
      where: { ...scope(user, actionType), status: "pending", expiresAt: { gt: now } },
      select: { id: true },
    })
  );
}

/**
 * Put a review up for its yes. The previous review of the same type is
 * cancelled in the same transaction: there is only ever one thing a yes can
 * mean per user and action type (approval binding, masterplan layer E).
 */
export async function prepareReviewedAction<Payload>(
  user: ActingUser,
  definition: ReviewedActionDefinition<Payload>,
  payload: Payload,
  options: { sourceId?: string; now?: Date } = {}
): Promise<{ expiresAt: Date }> {
  const now = options.now ?? new Date();
  const expiresAt = new Date(now.getTime() + definition.lifetimeMs);
  await prisma.$transaction(async (tx) => {
    // Two overlapping preparations must not both leave a pending review: under
    // READ COMMITTED both cancel-sweeps can run before either insert is
    // visible. A transaction-scoped advisory lock on (user, action type)
    // serialises them; the lock releases itself with the transaction. A hash
    // collision between queues only serialises two unrelated preparations.
    // (The ::text cast is for Prisma, which cannot deserialise a void column.)
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${user.companyId + ":" + user.id}), hashtext(${definition.actionType}))::text`;
    await tx.voicePendingAction.updateMany({
      where: { ...scope(user, definition.actionType), status: "pending" },
      data: { status: "cancelled", payload: Prisma.DbNull, resolvedAt: now },
    });
    await tx.voicePendingAction.create({
      data: {
        ...scope(user, definition.actionType),
        payload: payload as Prisma.InputJsonValue,
        expiresAt,
        ...(options.sourceId ? { sourceId: options.sourceId } : {}),
      },
    });
  });
  return { expiresAt };
}

export type ClaimedReviewedAction<Payload> =
  | {
      ok: true;
      id: string;
      payload: Payload;
      sourceId: string | null;
      /** Resolve the claim. Exactly one of these must be called. */
      complete: (succeeded: boolean) => Promise<void>;
    }
  | {
      ok: false;
      /**
       * none — nothing is waiting (or it expired);
       * raced — another confirmation claimed it first;
       * invalid — the stored payload no longer parses, and the review was
       * marked failed, so it has to be prepared again.
       */
      reason: "none" | "raced" | "invalid";
    };

/**
 * Claim the newest waiting review of this type for execution. The claim is a
 * conditional update, so of two simultaneous confirmations exactly one
 * executes; a retried yes after completion finds nothing to claim.
 */
export async function claimReviewedAction<Payload>(
  user: ActingUser,
  definition: ReviewedActionDefinition<Payload>,
  now = new Date()
): Promise<ClaimedReviewedAction<Payload>> {
  await expireReviewedActions(user, definition.actionType, now);
  const pending = await prisma.voicePendingAction.findFirst({
    where: { ...scope(user, definition.actionType), status: "pending", expiresAt: { gt: now } },
    orderBy: { createdAt: "desc" },
  });
  if (!pending) return { ok: false, reason: "none" };

  const claimed = await prisma.voicePendingAction.updateMany({
    where: { id: pending.id, status: "pending", expiresAt: { gt: now } },
    data: { status: definition.claimedStatus ?? "executing" },
  });
  if (!claimed.count) return { ok: false, reason: "raced" };

  // Belt to the advisory lock's braces: should an older duplicate pending row
  // exist (rows written before the lock shipped, mid-deploy overlap), it is
  // cancelled now, so a later yes can never claim a stale review.
  await prisma.voicePendingAction.updateMany({
    where: { ...scope(user, definition.actionType), status: "pending", id: { not: pending.id } },
    data: { status: "cancelled", payload: Prisma.DbNull, resolvedAt: now },
  });

  const parsed = definition.payloadSchema.safeParse(pending.payload);
  if (!parsed.success) {
    await resolveReviewedAction(pending.id, "failed");
    return { ok: false, reason: "invalid" };
  }

  return {
    ok: true,
    id: pending.id,
    payload: parsed.data,
    sourceId: pending.sourceId,
    complete: (succeeded: boolean) => resolveReviewedAction(pending.id, succeeded ? "completed" : "failed"),
  };
}

async function resolveReviewedAction(id: string, status: "completed" | "failed"): Promise<void> {
  await prisma.voicePendingAction.update({
    where: { id },
    data: { status, payload: Prisma.DbNull, resolvedAt: new Date() },
  });
}

/** Cancel whatever review of this type is waiting. True when one was. */
export async function cancelReviewedAction(user: ActingUser, actionType: string, now = new Date()): Promise<boolean> {
  await expireReviewedActions(user, actionType, now);
  const cancelled = await prisma.voicePendingAction.updateMany({
    where: { ...scope(user, actionType), status: "pending" },
    data: { status: "cancelled", payload: Prisma.DbNull, resolvedAt: now },
  });
  return cancelled.count > 0;
}
