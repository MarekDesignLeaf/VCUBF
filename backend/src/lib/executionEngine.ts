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
 *  - one review per user and action type: preparing cancels the previous one,
 *    and an advisory lock serialises overlapping preparations and claims;
 *  - a review expires on its own; an expired review cannot be confirmed;
 *  - a claim succeeds exactly once, so two simultaneous confirmations cannot
 *    both execute, and a stale duplicate (from before the lock shipped) can
 *    never be claimed — if duplicates tie on createdAt, the approved preview
 *    is ambiguous and neither executes;
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
  /**
   * The status a review gets when a newer preparation supersedes it
   * (default "cancelled"). Kept per action type for the same reason: the
   * client-creation and executable-action queues write "replaced".
   */
  replacedStatus?: string;
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
      data: { status: definition.replacedStatus ?? "cancelled", payload: Prisma.DbNull, resolvedAt: now },
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
       * invalid — the review cannot be executed as approved (its stored
       * payload no longer parses, or pre-lock duplicates tie on createdAt and
       * the approved preview is ambiguous); it was marked failed and has to
       * be prepared again.
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
  clock?: Date
): Promise<ClaimedReviewedAction<Payload>> {
  const outcome = await prisma.$transaction(async (tx) => {
    // The same lock preparation takes: selection, claim and stale-row cleanup
    // must act on one consistent picture of the queue, or a second
    // confirmation could claim a stale duplicate between a claim and its
    // cleanup. Under the lock, a preparation serialises entirely before or
    // after this claim — never between its statements.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${user.companyId + ":" + user.id}), hashtext(${definition.actionType}))::text`;
    // The clock is read after the lock is held: a confirmation that waited
    // here must not treat a review that expired during the wait as still
    // valid. An explicit clock stays as given, for deterministic tests.
    const now = clock ?? new Date();
    await tx.voicePendingAction.updateMany({
      where: { ...scope(user, definition.actionType), status: "pending", expiresAt: { lte: now } },
      data: { status: "expired", payload: Prisma.DbNull, resolvedAt: now },
    });
    const pending = await tx.voicePendingAction.findFirst({
      where: { ...scope(user, definition.actionType), status: "pending", expiresAt: { gt: now } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    if (!pending) return { ok: false, reason: "none" } as const;

    // Pre-lock duplicates can share a millisecond createdAt, and a random id
    // is no evidence of which preview the user actually saw last. An
    // ambiguous approval executes nothing (approval binding): the tied
    // reviews fail, anything older is cancelled, and the caller is asked to
    // prepare again.
    const tie = await tx.voicePendingAction.findFirst({
      where: { ...scope(user, definition.actionType), status: "pending", createdAt: pending.createdAt, id: { not: pending.id } },
      select: { id: true },
    });
    if (tie) {
      await tx.voicePendingAction.updateMany({
        where: { ...scope(user, definition.actionType), status: "pending", createdAt: pending.createdAt },
        data: { status: "failed", payload: Prisma.DbNull, resolvedAt: now },
      });
      await tx.voicePendingAction.updateMany({
        where: { ...scope(user, definition.actionType), status: "pending" },
        data: { status: "cancelled", payload: Prisma.DbNull, resolvedAt: now },
      });
      return { ok: false, reason: "invalid" } as const;
    }

    const claimed = await tx.voicePendingAction.updateMany({
      where: { id: pending.id, status: "pending", expiresAt: { gt: now } },
      data: { status: definition.claimedStatus ?? "executing" },
    });
    if (!claimed.count) return { ok: false, reason: "raced" } as const;

    // Belt to the lock's braces: any row still pending is a stale duplicate
    // (written before the lock shipped, or during a mid-deploy overlap) and
    // ranks under the claimed newest, so a later yes can never claim it. A
    // review prepared after this claim serialises after the transaction and
    // is untouched.
    await tx.voicePendingAction.updateMany({
      where: { ...scope(user, definition.actionType), status: "pending" },
      data: { status: "cancelled", payload: Prisma.DbNull, resolvedAt: now },
    });
    return { ok: true, pending } as const;
  });
  if (!outcome.ok) return outcome;
  const pending = outcome.pending;

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
