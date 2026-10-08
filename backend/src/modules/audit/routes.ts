import { Router } from "express";
import { prisma } from "../../db.js";
import { requireAuth } from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/permissions.js";
import { shadowSummary } from "../../agents/shadowAgent.js";

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

// GET /audit/agent-shadow — how often the agent in shadow agrees with what the
// parser actually did (masterplan F1 acceptance: ≥ 95 % on ≥ 100 requests).
// Counts and token totals only; agent runs hold no message text.
auditRouter.get("/agent-shadow", async (req, res) => {
  const raw = typeof req.query.since === "string" ? req.query.since : undefined;
  const since = raw ? new Date(raw) : undefined;
  if (since && Number.isNaN(since.getTime())) {
    return res.status(400).json({ error: "VALIDATION_FAILED", message: "since must be an ISO date." });
  }
  res.json(await shadowSummary(req.user!.companyId, since));
});
