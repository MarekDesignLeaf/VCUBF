import { Router } from "express";
import { requireAuth } from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/permissions.js";
import { DETECT_ACTION_PATTERNS_ACTION } from "../../lib/actionContracts.js";
import * as memoryModelService from "../../services/memoryModelService.js";

// Memory Model — read-only pattern-detection view. See
// memoryModelService.ts: this never creates a Playbook or any other record,
// it only surfaces candidate repeated-action patterns from the company's
// own AuditLog for a human to review.
export const memoryModelRouter = Router();

memoryModelRouter.use(requireAuth);

memoryModelRouter.get(
  "/patterns",
  requirePermission(DETECT_ACTION_PATTERNS_ACTION.requiredPermission),
  async (req, res) => {
    res.json(await memoryModelService.detectRepeatedActionPatterns(req.user!));
  }
);
