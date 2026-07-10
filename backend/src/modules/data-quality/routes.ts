import { Router } from "express";
import { requireAuth } from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/permissions.js";
import { ANALYZE_DATA_QUALITY_ACTION, MERGE_CLIENTS_ACTION } from "../../lib/actionContracts.js";
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

// merge_clients — Action Contract driven, confirmationRequired: true. A
// request without `confirmed: true` returns a 409 CONFIRMATION_REQUIRED
// preview and changes nothing; only `confirmed: true` performs the
// transaction. See dataQualityService.mergeClients for the full behaviour.
dataQualityRouter.post(
  "/merge-clients",
  requirePermission(MERGE_CLIENTS_ACTION.requiredPermission),
  async (req, res) => {
    const result = await dataQualityService.mergeClients(req.user!, req.body);
    if (!result.ok) {
      return res.status(result.httpStatus).json({ error: result.error, message: result.message, ...result.extra });
    }
    res.status(result.httpStatus).json(result.data);
  }
);
