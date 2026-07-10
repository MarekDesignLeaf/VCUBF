import { Router } from "express";
import { requireAuth } from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/permissions.js";
import { ANALYZE_DATA_QUALITY_ACTION } from "../../lib/actionContracts.js";
import * as dataQualityService from "../../services/dataQualityService.js";

// Data Quality Engine — read-only analysis view. Duplicate/missing-contact
// findings also feed additively into GET /notifications; this endpoint
// exists for a dedicated review page that shows the full structural report
// (including which fields matched) without the acknowledgement filtering
// the unified feed applies.
export const dataQualityRouter = Router();

dataQualityRouter.use(requireAuth);

dataQualityRouter.get("/", requirePermission(ANALYZE_DATA_QUALITY_ACTION.requiredPermission), async (req, res) => {
  res.json(await dataQualityService.getDataQualityReport(req.user!));
});
