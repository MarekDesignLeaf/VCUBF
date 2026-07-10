import { Router } from "express";
import { requireAuth } from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/permissions.js";
import { CREATE_SERVICE_ACTION, UPDATE_SERVICE_ACTION } from "../../lib/actionContracts.js";
import * as serviceCatalogueService from "../../services/serviceCatalogueService.js";

export const catalogueRouter = Router();

catalogueRouter.use(requireAuth);

catalogueRouter.get("/", requirePermission("crm.read"), async (req, res) => {
  const activeOnly = req.query.active_only === "true";
  res.json(await serviceCatalogueService.listServices(req.user!, { activeOnly }));
});

catalogueRouter.get("/:id", requirePermission("crm.read"), async (req, res) => {
  const service = await serviceCatalogueService.getService(req.user!, req.params.id);
  if (!service) return res.status(404).json({ error: "NOT_FOUND" });
  res.json(service);
});

catalogueRouter.post("/", requirePermission(CREATE_SERVICE_ACTION.requiredPermission), async (req, res) => {
  const result = await serviceCatalogueService.createService(req.user!, req.body);
  if (!result.ok) {
    return res.status(result.httpStatus).json({ error: result.error, message: result.message, ...result.extra });
  }
  res.status(result.httpStatus).json(result.data);
});

catalogueRouter.put("/:id", requirePermission(UPDATE_SERVICE_ACTION.requiredPermission), async (req, res) => {
  const result = await serviceCatalogueService.updateService(req.user!, req.params.id, req.body);
  if (!result.ok) {
    return res.status(result.httpStatus).json({ error: result.error, message: result.message, ...result.extra });
  }
  res.status(result.httpStatus).json(result.data);
});
