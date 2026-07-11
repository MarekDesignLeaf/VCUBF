import { Router } from "express";
import { z } from "zod";
import {
  CREATE_INDUSTRY_ACTION, LINK_INDUSTRY_SERVICE_ACTION,
  UPDATE_INDUSTRY_ACTION, UPDATE_INDUSTRY_SERVICE_LINK_ACTION,
} from "../../lib/actionContracts.js";
import { requireAuth } from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/permissions.js";
import * as industryService from "../../services/industryService.js";

export const industriesRouter = Router();
industriesRouter.use(requireAuth);
const listQuerySchema = z.object({ active_only: z.enum(["true", "false"]).optional() });

industriesRouter.get("/", requirePermission("crm.read"), async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "VALIDATION_FAILED", message: parsed.error.message });
  res.json(await industryService.listIndustries(req.user!, parsed.data.active_only === "true"));
});
industriesRouter.get("/:id", requirePermission("crm.read"), async (req, res) => {
  const industry = await industryService.getIndustry(req.user!, req.params.id);
  if (!industry) return res.status(404).json({ error: "INDUSTRY_NOT_FOUND" });
  res.json(industry);
});
industriesRouter.post("/", requirePermission(CREATE_INDUSTRY_ACTION.requiredPermission), async (req, res) => {
  const result = await industryService.createIndustry(req.user!, req.body);
  if (!result.ok) return res.status(result.httpStatus).json({ error: result.error, message: result.message, ...result.extra });
  res.status(result.httpStatus).json(result.data);
});
industriesRouter.put("/:id", requirePermission(UPDATE_INDUSTRY_ACTION.requiredPermission), async (req, res) => {
  const result = await industryService.updateIndustry(req.user!, req.params.id, req.body);
  if (!result.ok) return res.status(result.httpStatus).json({ error: result.error, message: result.message, ...result.extra });
  res.status(result.httpStatus).json(result.data);
});
industriesRouter.post("/:id/services", requirePermission(LINK_INDUSTRY_SERVICE_ACTION.requiredPermission), async (req, res) => {
  const result = await industryService.linkIndustryService(req.user!, req.params.id, req.body);
  if (!result.ok) return res.status(result.httpStatus).json({ error: result.error, message: result.message, ...result.extra });
  res.status(result.httpStatus).json(result.data);
});
industriesRouter.put("/service-links/:linkId", requirePermission(UPDATE_INDUSTRY_SERVICE_LINK_ACTION.requiredPermission), async (req, res) => {
  const result = await industryService.updateIndustryServiceLink(req.user!, req.params.linkId, req.body);
  if (!result.ok) return res.status(result.httpStatus).json({ error: result.error, message: result.message, ...result.extra });
  res.status(result.httpStatus).json(result.data);
});
