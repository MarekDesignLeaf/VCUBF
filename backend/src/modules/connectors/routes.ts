import { Router } from "express";
import { z } from "zod";
import {
  DISABLE_CONNECTOR_SOURCE_ACTION,
  ENABLE_CONNECTOR_SOURCE_ACTION,
  REGISTER_CONNECTOR_SOURCE_ACTION,
  UPDATE_CONNECTOR_SOURCE_ACTION,
} from "../../lib/actionContracts.js";
import { requireAuth } from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/permissions.js";
import * as connectorService from "../../services/connectorService.js";

export const connectorsRouter = Router();
connectorsRouter.use(requireAuth);

const listQuerySchema = z.object({ active_only: z.enum(["true", "false"]).optional() });

connectorsRouter.get("/definitions", requirePermission("connectors.read"), (_req, res) => {
  res.json(connectorService.listConnectorDefinitions());
});

connectorsRouter.get("/sources", requirePermission("connectors.read"), async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "VALIDATION_FAILED", message: parsed.error.message });
  res.json(await connectorService.listConnectorSources(req.user!, parsed.data.active_only === "true"));
});

connectorsRouter.get("/sources/:id", requirePermission("connectors.read"), async (req, res) => {
  const source = await connectorService.getConnectorSource(req.user!, req.params.id);
  if (!source) return res.status(404).json({ error: "CONNECTOR_SOURCE_NOT_FOUND" });
  res.json(source);
});

connectorsRouter.post("/sources", requirePermission(REGISTER_CONNECTOR_SOURCE_ACTION.requiredPermission), async (req, res) => {
  const result = await connectorService.registerConnectorSource(req.user!, req.body);
  if (!result.ok) return res.status(result.httpStatus).json({ error: result.error, message: result.message, ...result.extra });
  res.status(result.httpStatus).json(result.data);
});

connectorsRouter.put("/sources/:id", requirePermission(UPDATE_CONNECTOR_SOURCE_ACTION.requiredPermission), async (req, res) => {
  const result = await connectorService.updateConnectorSource(req.user!, req.params.id, req.body);
  if (!result.ok) return res.status(result.httpStatus).json({ error: result.error, message: result.message, ...result.extra });
  res.status(result.httpStatus).json(result.data);
});

connectorsRouter.post("/sources/:id/disable", requirePermission(DISABLE_CONNECTOR_SOURCE_ACTION.requiredPermission), async (req, res) => {
  const result = await connectorService.disableConnectorSource(req.user!, req.params.id);
  if (!result.ok) return res.status(result.httpStatus).json({ error: result.error, message: result.message, ...result.extra });
  res.status(result.httpStatus).json(result.data);
});

connectorsRouter.post("/sources/:id/enable", requirePermission(ENABLE_CONNECTOR_SOURCE_ACTION.requiredPermission), async (req, res) => {
  const result = await connectorService.enableConnectorSource(req.user!, req.params.id, req.body);
  if (!result.ok) return res.status(result.httpStatus).json({ error: result.error, message: result.message, ...result.extra });
  res.status(result.httpStatus).json(result.data);
});
