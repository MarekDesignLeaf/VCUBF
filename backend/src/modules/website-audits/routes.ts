import { Router } from "express";
import { requireAuth } from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/permissions.js";
import { CREATE_WEBSITE_AUDIT_ACTION } from "../../lib/actionContracts.js";
import * as websiteAuditService from "../../services/websiteAuditService.js";

export const websiteAuditsRouter = Router();

websiteAuditsRouter.use(requireAuth);

websiteAuditsRouter.get("/", requirePermission("crm.read"), async (req, res) => {
  res.json(await websiteAuditService.listWebsiteAudits(req.user!));
});

websiteAuditsRouter.get("/:id", requirePermission("crm.read"), async (req, res) => {
  const audit = await websiteAuditService.getWebsiteAudit(req.user!, req.params.id);
  if (!audit) return res.status(404).json({ error: "WEBSITE_AUDIT_NOT_FOUND" });
  res.json(audit);
});

websiteAuditsRouter.post(
  "/",
  requirePermission(CREATE_WEBSITE_AUDIT_ACTION.requiredPermission),
  async (req, res) => {
    const result = await websiteAuditService.createWebsiteAudit(req.user!, req.body);
    if (!result.ok) {
      return res
        .status(result.httpStatus)
        .json({ error: result.error, message: result.message, ...result.extra });
    }
    res.status(result.httpStatus).json(result.data);
  }
);
