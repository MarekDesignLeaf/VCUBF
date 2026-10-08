import { z } from "zod";
import {
  CANCEL_VOICE_NOTIFICATION_DELETION_ACTION,
  CONFIRM_VOICE_NOTIFICATION_DELETION_ACTION,
  PREPARE_VOICE_NOTIFICATION_DELETION_ACTION,
  type ActionContract,
} from "../lib/actionContracts.js";
import { recordAudit } from "../lib/audit.js";
import {
  cancelReviewedAction,
  claimReviewedAction,
  hasReviewedActionPending,
  prepareReviewedAction,
  type ReviewedActionDefinition,
} from "../lib/executionEngine.js";
import type { AuthedUser } from "../middleware/auth.js";
import { deleteNotificationsByKeys, getAttentionFeed } from "./notificationService.js";
import { fail, ok, type ServiceResult } from "./result.js";

// The reviewed-action lifecycle (prepare → yes → claim once → execute →
// resolve) lives in the Execution Engine; this service keeps what is its own:
// the permission wording, the preview, the deletion itself and the audit.
const NOTIFICATION_DELETION_REVIEW: ReviewedActionDefinition<{
  notificationKeys: string[];
  severities: Record<string, number>;
}> = {
  actionType: "delete_all_notifications",
  lifetimeMs: 5 * 60 * 1000,
  payloadSchema: z.object({
    notificationKeys: z.array(z.string().min(1)).min(1).max(1_000),
    severities: z.record(z.number().int().nonnegative()),
  }),
  claimedStatus: "deleting",
};

function canManageNotifications(user: AuthedUser) {
  return user.permissions.includes("crm.manage");
}

async function recordFailure(
  user: AuthedUser,
  action: Pick<ActionContract, "actionName" | "riskLevel" | "confirmationRequired">,
  errorMessage: string
) {
  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: action.actionName,
    inputPayload: {},
    riskLevel: action.riskLevel,
    confirmationRequired: action.confirmationRequired,
    result: "error",
    errorMessage,
  });
}

export async function hasPendingVoiceNotificationDeletion(user: AuthedUser) {
  return hasReviewedActionPending(user, NOTIFICATION_DELETION_REVIEW.actionType);
}

export async function prepareVoiceNotificationDeletion(user: AuthedUser): Promise<ServiceResult<unknown>> {
  if (!canManageNotifications(user)) {
    await recordFailure(user, PREPARE_VOICE_NOTIFICATION_DELETION_ACTION, "MISSING_PERMISSION");
    return fail(403, "MISSING_PERMISSION", "CRM management permission is required to delete notifications.");
  }

  const feed = await getAttentionFeed(user);
  if (feed.length === 0) {
    return ok(200, {
      confirmationRequired: false,
      preview: { count: 0, severities: {} },
      message: "There are no notifications to delete.",
    });
  }

  const severities = feed.reduce<Record<string, number>>((counts, item) => {
    counts[item.severity] = (counts[item.severity] ?? 0) + 1;
    return counts;
  }, {});
  const { expiresAt } = await prepareReviewedAction(user, NOTIFICATION_DELETION_REVIEW, {
    notificationKeys: feed.map((item) => item.key),
    severities,
  });

  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: PREPARE_VOICE_NOTIFICATION_DELETION_ACTION.actionName,
    inputPayload: { notificationCount: feed.length },
    dataAfter: { expiresAt, severities },
    riskLevel: PREPARE_VOICE_NOTIFICATION_DELETION_ACTION.riskLevel,
    confirmationRequired: true,
    result: "success",
  });

  return ok(202, {
    confirmationRequired: true,
    expiresAt: expiresAt.toISOString(),
    preview: { count: feed.length, severities },
    message: `I found ${feed.length} notification${feed.length === 1 ? "" : "s"}. Confirm to delete them from the feed. Source records will not be changed.`,
  });
}

export async function confirmVoiceNotificationDeletion(user: AuthedUser): Promise<ServiceResult<unknown>> {
  if (!canManageNotifications(user)) {
    await recordFailure(user, CONFIRM_VOICE_NOTIFICATION_DELETION_ACTION, "MISSING_PERMISSION");
    return fail(403, "MISSING_PERMISSION", "CRM management permission is required to delete notifications.");
  }

  const claimed = await claimReviewedAction(user, NOTIFICATION_DELETION_REVIEW);
  if (!claimed.ok) {
    if (claimed.reason === "raced") {
      return fail(409, "NO_PENDING_NOTIFICATION_DELETION", "That notification deletion is no longer waiting for confirmation.");
    }
    if (claimed.reason === "invalid") {
      await recordFailure(user, CONFIRM_VOICE_NOTIFICATION_DELETION_ACTION, "PENDING_NOTIFICATION_DELETION_INVALID");
      return fail(409, "PENDING_NOTIFICATION_DELETION_INVALID", "The reviewed notification deletion is no longer valid. Please prepare it again.");
    }
    await recordFailure(user, CONFIRM_VOICE_NOTIFICATION_DELETION_ACTION, "NO_PENDING_NOTIFICATION_DELETION");
    return fail(409, "NO_PENDING_NOTIFICATION_DELETION", "There is no notification deletion waiting for confirmation.");
  }

  const result = await deleteNotificationsByKeys(user, claimed.payload.notificationKeys, true);
  await claimed.complete(result.ok);
  if (!result.ok) return result;

  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: CONFIRM_VOICE_NOTIFICATION_DELETION_ACTION.actionName,
    inputPayload: { notificationCount: claimed.payload.notificationKeys.length },
    dataAfter: { completedAt: new Date() },
    riskLevel: CONFIRM_VOICE_NOTIFICATION_DELETION_ACTION.riskLevel,
    confirmationRequired: true,
    confirmed: true,
    result: "success",
  });
  return result;
}

export async function cancelVoiceNotificationDeletion(user: AuthedUser): Promise<ServiceResult<unknown>> {
  if (!canManageNotifications(user)) {
    await recordFailure(user, CANCEL_VOICE_NOTIFICATION_DELETION_ACTION, "MISSING_PERMISSION");
    return fail(403, "MISSING_PERMISSION", "CRM management permission is required to cancel notification deletion.");
  }

  const cancelled = await cancelReviewedAction(user, NOTIFICATION_DELETION_REVIEW.actionType);
  if (!cancelled) {
    return fail(409, "NO_PENDING_NOTIFICATION_DELETION", "There is no notification deletion waiting to be cancelled.");
  }

  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: CANCEL_VOICE_NOTIFICATION_DELETION_ACTION.actionName,
    inputPayload: {},
    riskLevel: CANCEL_VOICE_NOTIFICATION_DELETION_ACTION.riskLevel,
    confirmationRequired: false,
    result: "success",
  });
  return ok(200, { message: "Notification deletion was cancelled. Nothing was changed." });
}
