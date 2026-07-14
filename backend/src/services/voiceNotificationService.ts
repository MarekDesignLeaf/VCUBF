import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../db.js";
import {
  CANCEL_VOICE_NOTIFICATION_DELETION_ACTION,
  CONFIRM_VOICE_NOTIFICATION_DELETION_ACTION,
  PREPARE_VOICE_NOTIFICATION_DELETION_ACTION,
  type ActionContract,
} from "../lib/actionContracts.js";
import { recordAudit } from "../lib/audit.js";
import type { AuthedUser } from "../middleware/auth.js";
import { deleteNotificationsByKeys, getAttentionFeed } from "./notificationService.js";
import { fail, ok, type ServiceResult } from "./result.js";

const PENDING_NOTIFICATION_DELETION = "delete_all_notifications";
const PENDING_NOTIFICATION_LIFETIME_MS = 5 * 60 * 1000;

const pendingPayloadSchema = z.object({
  notificationKeys: z.array(z.string().min(1)).min(1).max(1_000),
  severities: z.record(z.number().int().nonnegative()),
});

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

async function expirePendingDeletion(user: AuthedUser, now = new Date()) {
  await prisma.voicePendingAction.updateMany({
    where: {
      companyId: user.companyId,
      userId: user.id,
      actionType: PENDING_NOTIFICATION_DELETION,
      status: "pending",
      expiresAt: { lte: now },
    },
    data: { status: "expired", payload: Prisma.DbNull, resolvedAt: now },
  });
}

export async function hasPendingVoiceNotificationDeletion(user: AuthedUser) {
  const now = new Date();
  await expirePendingDeletion(user, now);
  return Boolean(
    await prisma.voicePendingAction.findFirst({
      where: {
        companyId: user.companyId,
        userId: user.id,
        actionType: PENDING_NOTIFICATION_DELETION,
        status: "pending",
        expiresAt: { gt: now },
      },
      select: { id: true },
    })
  );
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
  const now = new Date();
  const expiresAt = new Date(now.getTime() + PENDING_NOTIFICATION_LIFETIME_MS);
  const payload = { notificationKeys: feed.map((item) => item.key), severities };

  await prisma.$transaction(async (tx) => {
    await tx.voicePendingAction.updateMany({
      where: { companyId: user.companyId, userId: user.id, actionType: PENDING_NOTIFICATION_DELETION, status: "pending" },
      data: { status: "cancelled", payload: Prisma.DbNull, resolvedAt: now },
    });
    await tx.voicePendingAction.create({
      data: {
        companyId: user.companyId,
        userId: user.id,
        actionType: PENDING_NOTIFICATION_DELETION,
        payload: payload as Prisma.InputJsonValue,
        expiresAt,
      },
    });
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

  const now = new Date();
  await expirePendingDeletion(user, now);
  const pending = await prisma.voicePendingAction.findFirst({
    where: {
      companyId: user.companyId,
      userId: user.id,
      actionType: PENDING_NOTIFICATION_DELETION,
      status: "pending",
      expiresAt: { gt: now },
    },
    orderBy: { createdAt: "desc" },
  });
  if (!pending) {
    await recordFailure(user, CONFIRM_VOICE_NOTIFICATION_DELETION_ACTION, "NO_PENDING_NOTIFICATION_DELETION");
    return fail(409, "NO_PENDING_NOTIFICATION_DELETION", "There is no notification deletion waiting for confirmation.");
  }

  const claimed = await prisma.voicePendingAction.updateMany({
    where: { id: pending.id, status: "pending", expiresAt: { gt: now } },
    data: { status: "deleting" },
  });
  if (!claimed.count) {
    return fail(409, "NO_PENDING_NOTIFICATION_DELETION", "That notification deletion is no longer waiting for confirmation.");
  }

  const payload = pendingPayloadSchema.safeParse(pending.payload);
  if (!payload.success) {
    await prisma.voicePendingAction.update({
      where: { id: pending.id },
      data: { status: "failed", payload: Prisma.DbNull, resolvedAt: new Date() },
    });
    await recordFailure(user, CONFIRM_VOICE_NOTIFICATION_DELETION_ACTION, "PENDING_NOTIFICATION_DELETION_INVALID");
    return fail(409, "PENDING_NOTIFICATION_DELETION_INVALID", "The reviewed notification deletion is no longer valid. Please prepare it again.");
  }

  const result = await deleteNotificationsByKeys(user, payload.data.notificationKeys, true);
  const resolvedAt = new Date();
  await prisma.voicePendingAction.update({
    where: { id: pending.id },
    data: { status: result.ok ? "completed" : "failed", payload: Prisma.DbNull, resolvedAt },
  });
  if (!result.ok) return result;

  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: CONFIRM_VOICE_NOTIFICATION_DELETION_ACTION.actionName,
    inputPayload: { notificationCount: payload.data.notificationKeys.length },
    dataAfter: { completedAt: resolvedAt },
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

  const now = new Date();
  await expirePendingDeletion(user, now);
  const cancelled = await prisma.voicePendingAction.updateMany({
    where: { companyId: user.companyId, userId: user.id, actionType: PENDING_NOTIFICATION_DELETION, status: "pending" },
    data: { status: "cancelled", payload: Prisma.DbNull, resolvedAt: now },
  });
  if (!cancelled.count) {
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
