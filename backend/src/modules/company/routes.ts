import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db.js";
import { recordAudit } from "../../lib/audit.js";
import { requireAuth } from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/permissions.js";
import { getEmmaPolicy, isAdministrator, updateEmmaPolicy, updateEmmaPolicySchema } from "../../services/emmaPolicyService.js";

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

companyRouter.get("/emma-policy", requirePermission("company.manage"), async (req, res) => {
  if (!isAdministrator(req.user!)) return res.status(403).json({ error: "ADMINISTRATOR_REQUIRED", message: "Only a company administrator can view Emma permissions." });
  const policy = await getEmmaPolicy(req.user!);
  if (!policy) return res.status(404).json({ error: "COMPANY_NOT_FOUND" });
  res.set("Cache-Control", "no-store");
  return res.json(policy);
});

companyRouter.put("/emma-policy", requirePermission("company.manage"), async (req, res) => {
  if (!isAdministrator(req.user!)) return res.status(403).json({ error: "ADMINISTRATOR_REQUIRED", message: "Only a company administrator can change Emma permissions." });
  const parsed = updateEmmaPolicySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "VALIDATION_FAILED", message: parsed.error.message });
  const policy = await updateEmmaPolicy(req.user!, parsed.data.disabled_capabilities);
  return res.json(policy);
});
