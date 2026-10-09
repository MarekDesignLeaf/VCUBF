import { Router } from "express";
import { prisma } from "../../db.js";
import { requireAuth } from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/permissions.js";
import { shadowSummary } from "../../agents/shadowAgent.js";
import { controlTowerOverview } from "../../agents/controlTower.js";

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
// Always over the whole current cohort (model, tool set, build): no time
// window, so failures cannot be filtered out of the verdict.
auditRouter.get("/agent-shadow", async (req, res) => {
  res.json(await shadowSummary(req.user!.companyId));
});

// GET /audit/control-tower — Agent Control Tower v1 (masterplan layer I, §57):
// build, models, shadow and emergency-stop state, what waits for a yes (counts
// only, never the payload) and the latest agent runs (fingerprints only, D4).
auditRouter.get("/control-tower", async (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json(await controlTowerOverview(req.user!.companyId));
});
