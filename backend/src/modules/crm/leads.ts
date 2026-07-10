import { Router } from "express";
import { requireAuth } from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/permissions.js";
import { CONVERT_LEAD_ACTION, CREATE_LEAD_ACTION } from "../../lib/actionContracts.js";
import * as leadService from "../../services/leadService.js";

export const leadsRouter = Router();

leadsRouter.use(requireAuth);

leadsRouter.get("/", requirePermission("crm.read"), async (req, res) => {
  const { status } = req.query;
  res.json(await leadService.listLeads(req.user!, { status: typeof status === "string" ? status : undefined }));
});

leadsRouter.get("/:id", requirePermission("crm.read"), async (req, res) => {
  const lead = await leadService.getLead(req.user!, req.params.id);
  if (!lead) return res.status(404).json({ error: "NOT_FOUND" });
  res.json(lead);
});

leadsRouter.post("/", requirePermission(CREATE_LEAD_ACTION.requiredPermission), async (req, res) => {
  const result = await leadService.createLead(req.user!, req.body);
  if (!result.ok) {
    return res.status(result.httpStatus).json({ error: result.error, message: result.message, ...result.extra });
  }
  res.status(result.httpStatus).json(result.data);
});

leadsRouter.post("/:id/convert", requirePermission(CONVERT_LEAD_ACTION.requiredPermission), async (req, res) => {
  const result = await leadService.convertLead(req.user!, req.params.id);
  if (!result.ok) {
    return res.status(result.httpStatus).json({ error: result.error, message: result.message, ...result.extra });
  }
  res.status(result.httpStatus).json(result.data);
});
