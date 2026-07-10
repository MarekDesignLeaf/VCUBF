import { Router } from "express";
import { prisma } from "../../db.js";
import { requireAuth } from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/permissions.js";

export const auditRouter = Router();

auditRouter.use(requireAuth, requirePermission("users.manage"));

// GET /audit/log — Audit Engine read access (admin only in MVP)
auditRouter.get("/log", async (req, res) => {
  const entries = await prisma.auditLog.findMany({
    where: { companyId: req.user!.companyId },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  res.json(entries);
});
