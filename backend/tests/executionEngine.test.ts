import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { z } from "zod";
import { prisma } from "../src/db.js";
import {
  cancelReviewedAction,
  claimReviewedAction,
  hasReviewedActionPending,
  peekReviewedAction,
  prepareReviewedAction,
  type ReviewedActionDefinition,
} from "../src/lib/executionEngine.js";
import { resetDb, seedCompanyAndAdmin } from "./setup.js";

const REVIEW: ReviewedActionDefinition<{ note: string }> = {
  actionType: "engine_test_review",
  lifetimeMs: 5 * 60 * 1000,
  payloadSchema: z.object({ note: z.string().min(1) }),
};

describe("execution engine — the reviewed-action state machine", () => {
  let user: { id: string; companyId: string };

  before(async () => {
    await resetDb();
    const seeded = await seedCompanyAndAdmin();
    user = { id: seeded.admin.id, companyId: seeded.admin.companyId };
  });

  after(async () => {
    await prisma.$disconnect();
  });

  it("keeps one review per user and type: preparing again cancels the previous one", async () => {
    await prepareReviewedAction(user, REVIEW, { note: "first" });
    await prepareReviewedAction(user, REVIEW, { note: "second" });
    assert.equal(await hasReviewedActionPending(user, REVIEW.actionType), true);
    const rows = await prisma.voicePendingAction.findMany({
      where: { companyId: user.companyId, userId: user.id, actionType: REVIEW.actionType },
      orderBy: { createdAt: "asc" },
    });
    assert.equal(rows.length, 2);
    assert.equal(rows[0].status, "cancelled");
    // A resolved review drops its payload: the text does not outlive the decision.
    assert.equal(rows[0].payload, null);
    assert.equal(rows[1].status, "pending");
  });

  it("claims exactly once; the yes executes the newest review and resolves it", async () => {
    const claimed = await claimReviewedAction(user, REVIEW);
    assert.ok(claimed.ok);
    assert.equal(claimed.payload.note, "second");
    await claimed.complete(true);
    const row = await prisma.voicePendingAction.findUnique({ where: { id: claimed.id } });
    assert.equal(row?.status, "completed");
    assert.equal(row?.payload, null);
    assert.ok(row?.resolvedAt);
    // A retried yes finds nothing to claim.
    const retried = await claimReviewedAction(user, REVIEW);
    assert.equal(retried.ok, false);
    assert.equal(!retried.ok && retried.reason, "none");
  });

  it("of two simultaneous preparations exactly one review survives", async () => {
    await Promise.all([
      prepareReviewedAction(user, REVIEW, { note: "overlap a" }),
      prepareReviewedAction(user, REVIEW, { note: "overlap b" }),
    ]);
    const pending = await prisma.voicePendingAction.findMany({
      where: { companyId: user.companyId, userId: user.id, actionType: REVIEW.actionType, status: "pending" },
    });
    assert.equal(pending.length, 1, "overlapping preparations must leave exactly one pending review");
    await cancelReviewedAction(user, REVIEW.actionType);
  });

  it("claiming cancels a stale older duplicate and executes the newest review", async () => {
    await prepareReviewedAction(user, REVIEW, { note: "current" });
    // A stale duplicate from before the engine serialised preparations.
    const stale = await prisma.voicePendingAction.create({
      data: {
        companyId: user.companyId,
        userId: user.id,
        actionType: REVIEW.actionType,
        payload: { note: "stale" },
        expiresAt: new Date(Date.now() + 60_000),
        createdAt: new Date(Date.now() - 60_000),
      },
    });
    // Two simultaneous confirmations over that queue: exactly one executes,
    // and what executes is the newest review, never the stale duplicate.
    const [first, second] = await Promise.all([
      claimReviewedAction(user, REVIEW),
      claimReviewedAction(user, REVIEW),
    ]);
    const winners = [first, second].filter((outcome) => outcome.ok);
    assert.equal(winners.length, 1, "exactly one of two simultaneous confirmations must win");
    assert.ok(winners[0].ok);
    assert.equal(winners[0].payload.note, "current");
    const staleRow = await prisma.voicePendingAction.findUnique({ where: { id: stale.id } });
    assert.equal(staleRow?.status, "cancelled");
    assert.equal(staleRow?.payload, null);
    await winners[0].complete(true);
  });

  it("a timestamp tie between duplicates is ambiguous: the yes executes neither", async () => {
    await prepareReviewedAction(user, REVIEW, { note: "tied current" });
    const current = await prisma.voicePendingAction.findFirst({
      where: { companyId: user.companyId, userId: user.id, actionType: REVIEW.actionType, status: "pending" },
    });
    assert.ok(current);
    // A pre-lock duplicate sharing the millisecond createdAt: which preview
    // the yes refers to cannot be told, so neither may execute.
    const tied = await prisma.voicePendingAction.create({
      data: {
        companyId: user.companyId,
        userId: user.id,
        actionType: REVIEW.actionType,
        payload: { note: "tied duplicate" },
        expiresAt: new Date(Date.now() + 60_000),
        createdAt: current.createdAt,
      },
    });
    const older = await prisma.voicePendingAction.create({
      data: {
        companyId: user.companyId,
        userId: user.id,
        actionType: REVIEW.actionType,
        payload: { note: "stale older" },
        expiresAt: new Date(Date.now() + 60_000),
        createdAt: new Date(Date.now() - 60_000),
      },
    });
    const claimed = await claimReviewedAction(user, REVIEW);
    assert.equal(claimed.ok, false);
    assert.equal(!claimed.ok && claimed.reason, "invalid");
    for (const id of [current.id, tied.id]) {
      const row = await prisma.voicePendingAction.findUnique({ where: { id } });
      assert.equal(row?.status, "failed");
      assert.equal(row?.payload, null);
    }
    const olderRow = await prisma.voicePendingAction.findUnique({ where: { id: older.id } });
    assert.equal(olderRow?.status, "cancelled");
    // Nothing is left to claim; preparing again restores a confirmable state.
    const retried = await claimReviewedAction(user, REVIEW);
    assert.equal(!retried.ok && retried.reason, "none");
    await prepareReviewedAction(user, REVIEW, { note: "fresh" });
    const fresh = await claimReviewedAction(user, REVIEW);
    assert.ok(fresh.ok);
    assert.equal(fresh.payload.note, "fresh");
    await fresh.complete(true);
  });

  it("of two simultaneous confirmations exactly one wins", async () => {
    await prepareReviewedAction(user, REVIEW, { note: "raced" });
    const [first, second] = await Promise.all([
      claimReviewedAction(user, REVIEW),
      claimReviewedAction(user, REVIEW),
    ]);
    const winners = [first, second].filter((outcome) => outcome.ok);
    assert.equal(winners.length, 1, "exactly one claim must win");
    assert.ok(winners[0].ok);
    await winners[0].complete(false);
    const row = await prisma.voicePendingAction.findUnique({ where: { id: winners[0].id } });
    assert.equal(row?.status, "failed");
  });

  it("a confirmation that waited on the lock does not execute a review that expired meanwhile", async () => {
    // The review has about a second to live; the lock is held for longer.
    await prepareReviewedAction(user, REVIEW, { note: "dying" }, { now: new Date(Date.now() - REVIEW.lifetimeMs + 1000) });
    let lockHeld!: () => void;
    const held = new Promise<void>((resolve) => { lockHeld = resolve; });
    const holder = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${user.companyId + ":" + user.id}), hashtext(${REVIEW.actionType}))::text`;
      lockHeld();
      await new Promise((resolve) => setTimeout(resolve, 2500));
    });
    await held;
    // The claim now waits on the lock while the review expires.
    const claimed = await claimReviewedAction(user, REVIEW);
    await holder;
    assert.equal(claimed.ok, false);
    assert.equal(!claimed.ok && claimed.reason, "none");
    const row = await prisma.voicePendingAction.findFirst({
      where: { companyId: user.companyId, userId: user.id, actionType: REVIEW.actionType, status: "expired" },
      orderBy: { createdAt: "desc" },
    });
    assert.ok(row, "the review that expired during the wait must be marked expired");
    await prisma.voicePendingAction.deleteMany({
      where: { companyId: user.companyId, userId: user.id, actionType: REVIEW.actionType },
    });
  });

  it("an expired review cannot be confirmed and reports as not pending", async () => {
    await prepareReviewedAction(user, REVIEW, { note: "late" }, { now: new Date(Date.now() - REVIEW.lifetimeMs - 1000) });
    assert.equal(await hasReviewedActionPending(user, REVIEW.actionType), false);
    const claimed = await claimReviewedAction(user, REVIEW);
    assert.equal(claimed.ok, false);
    assert.equal(!claimed.ok && claimed.reason, "none");
    const expired = await prisma.voicePendingAction.findFirst({
      where: { companyId: user.companyId, userId: user.id, actionType: REVIEW.actionType, status: "expired" },
    });
    assert.ok(expired);
    assert.equal(expired.payload, null);
  });

  it("a stored payload that no longer parses fails the review instead of executing", async () => {
    await prisma.voicePendingAction.create({
      data: {
        companyId: user.companyId,
        userId: user.id,
        actionType: REVIEW.actionType,
        payload: { wrong: true },
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const claimed = await claimReviewedAction(user, REVIEW);
    assert.equal(claimed.ok, false);
    assert.equal(!claimed.ok && claimed.reason, "invalid");
    const row = await prisma.voicePendingAction.findFirst({
      where: { companyId: user.companyId, userId: user.id, actionType: REVIEW.actionType, status: "failed" },
    });
    assert.ok(row);
    assert.equal(row.payload, null);
  });

  it("cancel reports whether anything was actually waiting", async () => {
    await prepareReviewedAction(user, REVIEW, { note: "to cancel" });
    assert.equal(await cancelReviewedAction(user, REVIEW.actionType), true);
    assert.equal(await cancelReviewedAction(user, REVIEW.actionType), false);
  });

  it("uses the claimed status the action type's existing rows and tests know", async () => {
    const named: ReviewedActionDefinition<{ note: string }> = { ...REVIEW, claimedStatus: "deleting" };
    await prepareReviewedAction(user, named, { note: "status" });
    const claimed = await claimReviewedAction(user, named);
    assert.ok(claimed.ok);
    const row = await prisma.voicePendingAction.findUnique({ where: { id: claimed.id } });
    assert.equal(row?.status, "deleting");
    await claimed.complete(true);
  });

  it("uses the replaced status the action type's existing rows know", async () => {
    const named: ReviewedActionDefinition<{ note: string }> = { ...REVIEW, replacedStatus: "replaced" };
    await prepareReviewedAction(user, named, { note: "first" });
    await prepareReviewedAction(user, named, { note: "second" });
    const replaced = await prisma.voicePendingAction.findFirst({
      where: { companyId: user.companyId, userId: user.id, actionType: REVIEW.actionType, status: "replaced" },
    });
    assert.ok(replaced);
    assert.equal(replaced.payload, null);
    await cancelReviewedAction(user, REVIEW.actionType);
  });

  it("peeks at the waiting review without claiming it", async () => {
    assert.equal(await peekReviewedAction(user, REVIEW.actionType), undefined);
    await prepareReviewedAction(user, REVIEW, { note: "peeked" });
    const peeked = await peekReviewedAction(user, REVIEW.actionType);
    assert.deepEqual(peeked?.payload, { note: "peeked" });
    // Peeking changes nothing: the review is still there to be claimed.
    const claimed = await claimReviewedAction(user, REVIEW);
    assert.ok(claimed.ok);
    assert.equal(claimed.payload.note, "peeked");
    assert.equal(await peekReviewedAction(user, REVIEW.actionType), undefined);
    await claimed.complete(true);
    // An expired review is not a hint either.
    await prepareReviewedAction(user, REVIEW, { note: "stale" }, { now: new Date(Date.now() - REVIEW.lifetimeMs - 1000) });
    assert.equal(await peekReviewedAction(user, REVIEW.actionType), undefined);
  });

  it("a transforming schema re-validates on the way out and reports what it rejected", async () => {
    const strict: ReviewedActionDefinition<{ note: string; checked: true }> = {
      ...REVIEW,
      payloadSchema: z.object({ note: z.string() }).transform((value, ctx) => {
        if (value.note === "reject me") {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["note"], message: "note is no longer acceptable" });
          return z.NEVER;
        }
        return { note: value.note.trim(), checked: true as const };
      }),
    };
    await prepareReviewedAction(user, strict, { note: "  normalised  ", checked: true });
    const accepted = await claimReviewedAction(user, strict);
    assert.ok(accepted.ok);
    assert.deepEqual(accepted.payload, { note: "normalised", checked: true });
    await accepted.complete(true);

    await prepareReviewedAction(user, strict, { note: "reject me", checked: true });
    const rejected = await claimReviewedAction(user, strict);
    assert.equal(rejected.ok, false);
    assert.equal(!rejected.ok && rejected.reason, "invalid");
    const issue = !rejected.ok ? rejected.issues?.[0] : undefined;
    assert.equal(issue?.path[0], "note");
    assert.equal(issue?.message, "note is no longer acceptable");
  });

  it("never crosses user or tenant", async () => {
    await prepareReviewedAction(user, REVIEW, { note: "mine" });
    const stranger = { id: user.id, companyId: "20000000-0000-0000-0000-000000000002" };
    assert.equal(await hasReviewedActionPending(stranger, REVIEW.actionType), false);
    assert.equal(await peekReviewedAction(stranger, REVIEW.actionType), undefined);
    const claimed = await claimReviewedAction(stranger, REVIEW);
    assert.equal(claimed.ok, false);
    await cancelReviewedAction(user, REVIEW.actionType);
  });
});
