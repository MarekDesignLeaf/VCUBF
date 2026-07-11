import { Router } from "express";
import { requireAuth } from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/permissions.js";
import { metricsQuerySchema, getMetricsOverview } from "../../services/metricsService.js";
import { GET_METRICS_OVERVIEW_ACTION } from "../../lib/actionContracts.js";

export const metricsRouter = Router();
metricsRouter.use(requireAuth);
metricsRouter.get("/overview", requirePermission(GET_METRICS_OVERVIEW_ACTION.requiredPermission), async (req, res) => {
  const parsed = metricsQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "VALIDATION_FAILED", message: parsed.error.message });
  res.json(await getMetricsOverview(req.user!, parsed.data));
});
