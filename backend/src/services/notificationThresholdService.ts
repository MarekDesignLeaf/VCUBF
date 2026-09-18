import { z } from "zod";
import { prisma } from "../db.js";
import { recordAudit } from "../lib/audit.js";
import { UPDATE_NOTIFICATION_THRESHOLDS_ACTION } from "../lib/actionContracts.js";
import type { AuthedUser } from "../middleware/auth.js";
import { fail, ok, type ServiceResult } from "./result.js";

// Notification and Escalation Module — the day thresholds behind the
// computed attention feed. They started life as fixed constants
// (QUOTE_EXPIRY_WARNING_WINDOW_DAYS = 7, STALE_LEAD_THRESHOLD_DAYS = 14,
// STUCK_JOB_THRESHOLD_DAYS = 10, resource readiness 3 days). Those values
// remain the safe defaults for every company; an administrator may override
// them per company within bounded ranges. Every change is audited with the
// before/after values. Nothing here changes what is *measured* — only the
// number of days after which a real, already-stored fact is surfaced.

export interface NotificationThresholds {
  quoteExpiryWarningDays: number;
  staleLeadDays: number;
  stuckJobDays: number;
  resourceReadinessDays: number;
}

export const DEFAULT_NOTIFICATION_THRESHOLDS: Readonly<NotificationThresholds> = {
  quoteExpiryWarningDays: 7,
  staleLeadDays: 14,
  stuckJobDays: 10,
  resourceReadinessDays: 3,
};

export const notificationThresholdsSchema = z.object({
  quote_expiry_warning_days: z.number().int().min(1).max(90),
  stale_lead_days: z.number().int().min(1).max(365),
  stuck_job_days: z.number().int().min(1).max(365),
  resource_readiness_days: z.number().int().min(1).max(30),
}).strict();

export type NotificationThresholdsInput = z.infer<typeof notificationThresholdsSchema>;

const STORED_KEYS: Record<keyof NotificationThresholds, keyof NotificationThresholdsInput> = {
  quoteExpiryWarningDays: "quote_expiry_warning_days",
  staleLeadDays: "stale_lead_days",
  stuckJobDays: "stuck_job_days",
  resourceReadinessDays: "resource_readiness_days",
};

/** Merge a stored override object over the defaults, ignoring anything malformed. */
export function resolveNotificationThresholds(stored: unknown): NotificationThresholds {
  const source = (stored && typeof stored === "object" ? stored : {}) as Record<string, unknown>;
  const resolved: NotificationThresholds = { ...DEFAULT_NOTIFICATION_THRESHOLDS };
  for (const [key, storedKey] of Object.entries(STORED_KEYS) as [keyof NotificationThresholds, keyof NotificationThresholdsInput][]) {
    const value = source[storedKey];
    const bound = notificationThresholdsSchema.shape[storedKey];
    if (typeof value === "number" && bound.safeParse(value).success) resolved[key] = value;
  }
  return resolved;
}

export async function getNotificationThresholds(companyId: string): Promise<NotificationThresholds> {
  const company = await prisma.company.findUnique({ where: { id: companyId }, select: { notificationThresholds: true } });
  return resolveNotificationThresholds(company?.notificationThresholds);
}

export function thresholdsView(thresholds: NotificationThresholds) {
  return {
    thresholds,
    defaults: DEFAULT_NOTIFICATION_THRESHOLDS,
    isDefault: (Object.keys(DEFAULT_NOTIFICATION_THRESHOLDS) as (keyof NotificationThresholds)[]).every((key) => thresholds[key] === DEFAULT_NOTIFICATION_THRESHOLDS[key]),
    limits: {
      quoteExpiryWarningDays: { min: 1, max: 90 },
      staleLeadDays: { min: 1, max: 365 },
      stuckJobDays: { min: 1, max: 365 },
      resourceReadinessDays: { min: 1, max: 30 },
    },
  };
}

export async function updateNotificationThresholds(user: AuthedUser, rawInput: unknown): Promise<ServiceResult<ReturnType<typeof thresholdsView>>> {
  const parsed = notificationThresholdsSchema.safeParse(rawInput);
  if (!parsed.success) {
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: UPDATE_NOTIFICATION_THRESHOLDS_ACTION.actionName,
      inputPayload: rawInput,
      riskLevel: UPDATE_NOTIFICATION_THRESHOLDS_ACTION.riskLevel,
      result: "error",
      errorMessage: "VALIDATION_FAILED",
    });
    return fail(400, "VALIDATION_FAILED", parsed.error.message);
  }
  const before = await getNotificationThresholds(user.companyId);
  const updated = await prisma.company.update({
    where: { id: user.companyId },
    data: { notificationThresholds: parsed.data },
    select: { notificationThresholds: true },
  });
  const after = resolveNotificationThresholds(updated.notificationThresholds);
  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: UPDATE_NOTIFICATION_THRESHOLDS_ACTION.actionName,
    inputPayload: parsed.data,
    dataBefore: before,
    dataAfter: after,
    riskLevel: UPDATE_NOTIFICATION_THRESHOLDS_ACTION.riskLevel,
    result: "success",
  });
  return ok(200, thresholdsView(after));
}
