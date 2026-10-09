import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db.js";
import { recordAudit } from "../../lib/audit.js";
import { SET_COMPANY_SAFE_MODE_ACTION } from "../../lib/actionContracts.js";
import { requireAuth } from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/permissions.js";
import { getEmmaPolicy, isAdministrator, updateEmmaPolicy, updateEmmaPolicySchema } from "../../services/emmaPolicyService.js";
import { getNotificationThresholds, thresholdsView, updateNotificationThresholds } from "../../services/notificationThresholdService.js";

export const companyRouter = Router();
const companySchema = z.object({ name: z.string().trim().min(2).max(160) });

companyRouter.use(requireAuth);

const companyView = {
  id: true,
  name: true,
  createdAt: true,
  setupCompletedAt: true,
  primaryAdministrator: { select: { id: true, displayName: true, email: true, role: true, isActive: true } },
} as const;

companyRouter.get("/", requirePermission("company.manage"), async (req, res) => {
  const company = await prisma.company.findUnique({ where: { id: req.user!.companyId }, select: companyView });
  if (!company) return res.status(404).json({ error: "COMPANY_NOT_FOUND" });
  res.json(company);
});

companyRouter.put("/", requirePermission("company.manage"), async (req, res) => {
  const parsed = companySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "VALIDATION_FAILED", message: parsed.error.message });
  const before = await prisma.company.findUnique({ where: { id: req.user!.companyId }, select: { name: true } });
  if (!before) return res.status(404).json({ error: "COMPANY_NOT_FOUND" });
  const company = await prisma.company.update({ where: { id: req.user!.companyId }, data: { name: parsed.data.name }, select: companyView });
  await recordAudit({
    companyId: req.user!.companyId,
    userId: req.user!.id,
    actionName: "update_company_profile",
    inputPayload: { name: parsed.data.name },
    dataBefore: before,
    dataAfter: { name: company.name },
    riskLevel: 2,
    result: "success",
  });
  res.json(company);
});

// Emergency stop (masterplan layer H). Everyone signed in may see whether it
// is on — the interface warns before anyone tries to change something — but
// only an administrator switches it, and every switch is audited at risk 4.
const safeModeSchema = z.object({ enabled: z.boolean(), reason: z.string().trim().max(500).optional() });

async function safeModeView(companyId: string) {
  const company = await prisma.company.findUnique({ where: { id: companyId }, select: { safeModeSince: true } });
  return company ? { enabled: company.safeModeSince !== null, since: company.safeModeSince } : null;
}

companyRouter.get("/safe-mode", async (req, res) => {
  const view = await safeModeView(req.user!.companyId);
  if (!view) return res.status(404).json({ error: "COMPANY_NOT_FOUND" });
  res.set("Cache-Control", "no-store");
  return res.json(view);
});

companyRouter.put("/safe-mode", requirePermission(SET_COMPANY_SAFE_MODE_ACTION.requiredPermission), async (req, res) => {
  const user = req.user!;
  if (!isAdministrator(user)) {
    return res.status(403).json({ error: "ADMINISTRATOR_REQUIRED", message: "Only a company administrator can switch the emergency stop." });
  }
  const parsed = safeModeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "VALIDATION_FAILED", message: parsed.error.message });
  const before = await safeModeView(user.companyId);
  if (!before) return res.status(404).json({ error: "COMPANY_NOT_FOUND" });
  // Conditional update: two administrators switching at once change it once,
  // and only a real change is audited.
  const changed = await prisma.company.updateMany({
    where: { id: user.companyId, safeModeSince: parsed.data.enabled ? null : { not: null } },
    data: { safeModeSince: parsed.data.enabled ? new Date() : null },
  });
  const after = await safeModeView(user.companyId);
  if (changed.count > 0) {
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: SET_COMPANY_SAFE_MODE_ACTION.actionName,
      inputPayload: { enabled: parsed.data.enabled, reason: parsed.data.reason ?? null },
      dataBefore: before,
      dataAfter: after,
      riskLevel: SET_COMPANY_SAFE_MODE_ACTION.riskLevel,
      result: "success",
    });
  }
  res.set("Cache-Control", "no-store");
  return res.json(after);
});

companyRouter.get("/emma-policy", requirePermission("company.manage"), async (req, res) => {
  if (!isAdministrator(req.user!)) return res.status(403).json({ error: "ADMINISTRATOR_REQUIRED", message: "Only a company administrator can view {assistant} permissions." });
  const policy = await getEmmaPolicy(req.user!);
  if (!policy) return res.status(404).json({ error: "COMPANY_NOT_FOUND" });
  res.set("Cache-Control", "no-store");
  return res.json(policy);
});

companyRouter.put("/emma-policy", requirePermission("company.manage"), async (req, res) => {
  if (!isAdministrator(req.user!)) return res.status(403).json({ error: "ADMINISTRATOR_REQUIRED", message: "Only a company administrator can change {assistant} permissions." });
  const parsed = updateEmmaPolicySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "VALIDATION_FAILED", message: parsed.error.message });
  const policy = await updateEmmaPolicy(req.user!, parsed.data.disabled_capabilities);
  return res.json(policy);
});

// Notification thresholds — per-company overrides of the fixed defaults used
// by the computed attention feed. Read shows the effective values next to the
// defaults; write validates bounded integers and audits before/after.
companyRouter.get("/notification-thresholds", requirePermission("company.manage"), async (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json(thresholdsView(await getNotificationThresholds(req.user!.companyId)));
});

companyRouter.put("/notification-thresholds", requirePermission("company.manage"), async (req, res) => {
  const result = await updateNotificationThresholds(req.user!, req.body);
  if (!result.ok) return res.status(result.httpStatus).json({ error: result.error, message: result.message });
  res.json(result.data);
});
