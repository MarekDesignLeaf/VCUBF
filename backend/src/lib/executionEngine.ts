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

import { AsyncLocalStorage } from "node:async_hooks";
import { Prisma } from "@prisma/client";
import type { z } from "zod";
import { prisma } from "../db.js";
import { assertNotInSafeMode } from "./safeMode.js";

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
  /**
   * The stored payload's shape; what no longer parses is not executed. It may
   * transform (re-validate and normalise) the stored value on the way out.
   */
  payloadSchema: z.ZodType<Payload, z.ZodTypeDef, unknown>;
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
  /**
   * The status a successfully executed review is resolved with (default
   * "completed"). The message queues record "sent".
   */
  completedStatus?: string;
}

/**
 * Approval binding (masterplan layer E). A yes should approve the review the
 * user actually heard, not merely the newest one: with two overlapping
 * preparations the older preview can be the last one shown. The command layer
 * runs each request inside this context — carrying the id of the review the
 * client last displayed, if it sent one — and learns back which review the
 * request prepared or resolved, to hand the client for its next yes.
 */
interface ApprovalBinding {
  /**
   * The review the client displayed last. undefined: the client does not take
   * part (older clients) and the newest review is meant, as before. A string or
   * null: strict — a yes approves exactly that review and nothing else, and
   * null (nothing displayed) approves nothing.
   */
  expectedReviewId?: string | null;
  /** The review this request put up for a yes. */
  prepared?: { id: string; actionType: string; expiresAt: Date };
  /** Reviews this request claimed, failed as invalid or cancelled. */
  resolvedIds: Set<string>;
  /** A yes was refused because the waiting review is not the one heard here. */
  refusedUnheard?: boolean;
}

const approvalBinding = new AsyncLocalStorage<ApprovalBinding>();

/**
 * Run one request with approval binding. Without an expected review id the
 * engine behaves exactly as before (the newest review of the queue), so
 * clients that send none are unaffected.
 */
export async function runWithApprovalBinding<T>(
  expectedReviewId: string | null | undefined,
  work: () => Promise<T>,
): Promise<{ result: T; prepared?: ApprovalBinding["prepared"]; resolvedIds: ReadonlySet<string>; refusedUnheard: boolean }> {
  const binding: ApprovalBinding = { expectedReviewId, resolvedIds: new Set() };
  const result = await approvalBinding.run(binding, work);
  return { result, prepared: binding.prepared, resolvedIds: binding.resolvedIds, refusedUnheard: binding.refusedUnheard === true };
}

/** Whether a review is still waiting for this user's yes. */
export async function isReviewPending(user: ActingUser, id: string, now = new Date()): Promise<boolean> {
  return Boolean(
    await prisma.voicePendingAction.findFirst({
      where: { id, companyId: user.companyId, userId: user.id, status: "pending", expiresAt: { gt: now } },
      select: { id: true },
    }),
  );
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
 * What is waiting for a yes across the company, for the Control Tower: per
 * kind of action, how many reviews wait and since when. Read only, and never
 * the payload — the text of a waiting message stays with its review.
 */
export async function pendingReviewsOverview(companyId: string, now = new Date()) {
  const groups = await prisma.voicePendingAction.groupBy({
    by: ["actionType"],
    where: { companyId, status: "pending", expiresAt: { gt: now } },
    _count: { _all: true },
    _min: { createdAt: true, expiresAt: true },
  });
  return groups
    .map((group) => ({
      actionType: group.actionType,
      waiting: group._count._all,
      oldestCreatedAt: group._min.createdAt,
      nextExpiresAt: group._min.expiresAt,
    }))
    .sort((left, right) => left.actionType.localeCompare(right.actionType));
}

/**
 * The newest review of this type still waiting for its yes, read without
 * claiming it — for callers that need to know what a yes would mean (which
 * action, to word the outcome) before they ask the engine to claim it. The
 * payload is returned raw: it is a hint, never something to execute.
 */
export async function peekReviewedAction(
  user: ActingUser,
  actionType: string,
  now = new Date()
): Promise<{ payload: unknown } | undefined> {
  await expireReviewedActions(user, actionType, now);
  const pending = await prisma.voicePendingAction.findFirst({
    where: { ...scope(user, actionType), status: "pending", expiresAt: { gt: now } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { payload: true },
  });
  return pending ? { payload: pending.payload } : undefined;
}

/**
 * Review types that stand alone: an agent proposal (F2b) carries several
 * steps and waits up to ten minutes, so a bare yes beside another waiting
 * review would be ambiguous and refused. Preparing one withdraws every other
 * review the user has waiting, and preparing any other review withdraws it:
 * the yes always means the last thing read out.
 */
export const STANDALONE_REVIEW_TYPES: ReadonlySet<string> = new Set(["agent_proposal"]);

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
): Promise<{ expiresAt: Date; id: string }> {
  const now = options.now ?? new Date();
  const expiresAt = new Date(now.getTime() + definition.lifetimeMs);
  const created = await prisma.$transaction(async (tx) => {
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
    // A stand-alone review and any other one never wait side by side. Only
    // still-pending rows are touched, so a claim already under way elsewhere
    // either finished first or finds its review withdrawn ("raced").
    await tx.voicePendingAction.updateMany({
      where: {
        companyId: user.companyId,
        userId: user.id,
        status: "pending",
        actionType: STANDALONE_REVIEW_TYPES.has(definition.actionType)
          ? { not: definition.actionType }
          : { in: [...STANDALONE_REVIEW_TYPES] },
      },
      data: { status: "cancelled", payload: Prisma.DbNull, resolvedAt: now },
    });
    return tx.voicePendingAction.create({
      data: {
        ...scope(user, definition.actionType),
        payload: payload as Prisma.InputJsonValue,
        expiresAt,
        ...(options.sourceId ? { sourceId: options.sourceId } : {}),
      },
      select: { id: true },
    });
  });
  const binding = approvalBinding.getStore();
  if (binding) binding.prepared = { id: created.id, actionType: definition.actionType, expiresAt };
  return { expiresAt, id: created.id };
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
       * raced — a review was waiting when this yes arrived, but another
       * confirmation claimed it (or a cancel removed it) first;
       * invalid — the review cannot be executed as approved (its stored
       * payload no longer parses, or pre-lock duplicates tie on createdAt and
       * the approved preview is ambiguous); it was marked failed and has to
       * be prepared again.
       */
      reason: "none" | "raced" | "invalid";
      /**
       * For "raced": the review the user was shown has been replaced by a
       * newer one of the same queue, which this yes does not approve.
       */
      superseded?: true;
      /**
       * For "invalid" because the stored payload no longer parses: what the
       * schema rejected, so the owning service can keep its own wording.
       */
      issues?: z.ZodIssue[];
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
  // Emergency stop (layer H): no yes executes anything while the company is in
  // safe mode, whatever path it came by. Checked before anything is touched,
  // so the review keeps waiting and can still be cancelled or approved once
  // the stop is lifted. The error handler answers 423 SAFE_MODE_ACTIVE.
  await assertNotInSafeMode(user.companyId);

  // Whether a review was waiting when this yes arrived, read before queueing
  // on the lock. A confirmation that then finds nothing lost to another
  // confirmation (or a cancel) of that review: "raced", not "none", so callers
  // keep telling a duplicate yes from a queue that never had a review.
  const seenBeforeLock = await prisma.voicePendingAction.findFirst({
    where: { ...scope(user, definition.actionType), status: "pending", expiresAt: { gt: clock ?? new Date() } },
    select: { id: true },
  });
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
    if (!pending) {
      // The review seen before the lock was taken by another confirmation or
      // cancelled meanwhile: "raced". Had it merely run out of time, there is
      // simply nothing to confirm: "none".
      const seen = seenBeforeLock
        ? await tx.voicePendingAction.findUnique({ where: { id: seenBeforeLock.id }, select: { status: true } })
        : null;
      return { ok: false, reason: seen && seen.status !== "expired" ? "raced" : "none" } as const;
    }

    // Approval binding: when the client takes part, a yes approves exactly the
    // review it displayed and nothing else — not a newer one of this queue, not
    // the only one waiting in a queue the remembered review never belonged to,
    // and nothing at all when the client displays none (null). What the user
    // has not heard on this device is never executed by their yes; they are
    // told it is no longer waiting and can ask for it again.
    const binding = approvalBinding.getStore();
    if (binding && binding.expectedReviewId !== undefined && binding.expectedReviewId !== pending.id) {
      binding.refusedUnheard = true;
      return { ok: false, reason: "raced", superseded: true } as const;
    }

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
  // A claimed review is no longer waiting: if it was the remembered one, the
  // client's memory is spent.
  if (outcome.ok) approvalBinding.getStore()?.resolvedIds.add(outcome.pending.id);
  if (!outcome.ok) return outcome;
  const pending = outcome.pending;

  const parsed = definition.payloadSchema.safeParse(pending.payload);
  if (!parsed.success) {
    await resolveReviewedAction(pending.id, "failed");
    return { ok: false, reason: "invalid", issues: parsed.error.issues };
  }

  return {
    ok: true,
    id: pending.id,
    payload: parsed.data,
    sourceId: pending.sourceId,
    complete: (succeeded: boolean) => resolveReviewedAction(pending.id, succeeded ? definition.completedStatus ?? "completed" : "failed"),
  };
}

async function resolveReviewedAction(id: string, status: string): Promise<void> {
  await prisma.voicePendingAction.update({
    where: { id },
    data: { status, payload: Prisma.DbNull, resolvedAt: new Date() },
  });
}

/** Cancel whatever review of this type is waiting. True when one was. */
export async function cancelReviewedAction(user: ActingUser, actionType: string, now = new Date()): Promise<boolean> {
  await expireReviewedActions(user, actionType, now);
  const waiting = await prisma.voicePendingAction.findMany({
    where: { ...scope(user, actionType), status: "pending" },
    select: { id: true },
  });
  if (waiting.length === 0) return false;
  const cancelled = await prisma.voicePendingAction.updateMany({
    where: { id: { in: waiting.map((row) => row.id) }, status: "pending" },
    data: { status: "cancelled", payload: Prisma.DbNull, resolvedAt: now },
  });
  const binding = approvalBinding.getStore();
  if (binding && cancelled.count > 0) for (const row of waiting) binding.resolvedIds.add(row.id);
  return cancelled.count > 0;
}
