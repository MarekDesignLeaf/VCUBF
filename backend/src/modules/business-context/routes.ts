import { Router } from "express";
import { CREATE_BUSINESS_CONTEXT_ITEM_ACTION, UPDATE_BUSINESS_CONTEXT_ITEM_ACTION } from "../../lib/actionContracts.js";
import { requireAuth } from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/permissions.js";
import * as businessContextService from "../../services/businessContextService.js";

export const businessContextRouter = Router();

businessContextRouter.use(requireAuth);

businessContextRouter.get("/", requirePermission("crm.read"), async (req, res) => {
  const { category, active_only } = req.query;
  res.json(
    await businessContextService.listBusinessContextItems(req.user!, {
      category: typeof category === "string" ? category : undefined,
      activeOnly: active_only === "true",
    })
  );
});

businessContextRouter.get("/:id", requirePermission("crm.read"), async (req, res) => {
  const item = await businessContextService.getBusinessContextItem(req.user!, req.params.id);
  if (!item) return res.status(404).json({ error: "BUSINESS_CONTEXT_ITEM_NOT_FOUND" });
  res.json(item);
});

businessContextRouter.post(
  "/",
  requirePermission(CREATE_BUSINESS_CONTEXT_ITEM_ACTION.requiredPermission),
  async (req, res) => {
    const result = await businessContextService.createBusinessContextItem(req.user!, req.body);
    if (!result.ok) return res.status(result.httpStatus).json({ error: result.error, message: result.message, ...result.extra });
    res.status(result.httpStatus).json(result.data);
  }
);

businessContextRouter.put(
  "/:id",
  requirePermission(UPDATE_BUSINESS_CONTEXT_ITEM_ACTION.requiredPermission),
  async (req, res) => {
    const result = await businessContextService.updateBusinessContextItem(req.user!, req.params.id, req.body);
    if (!result.ok) return res.status(result.httpStatus).json({ error: result.error, message: result.message, ...result.extra });
    res.status(result.httpStatus).json(result.data);
  }
);
