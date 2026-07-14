import { Router } from "express";
import { requireAuth } from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/permissions.js";
import { ARCHIVE_CLIENT_ACTION, CREATE_CLIENT_ACTION, UPDATE_CLIENT_ACTION } from "../../lib/actionContracts.js";
import * as clientService from "../../services/clientService.js";

export const clientsRouter = Router();

clientsRouter.use(requireAuth);

clientsRouter.get("/", requirePermission("crm.read"), async (req, res) => {
  res.json(await clientService.listClients(req.user!));
});

clientsRouter.get("/search", requirePermission("crm.read"), async (req, res) => {
  res.json(await clientService.searchClients(req.user!, String(req.query.q ?? "")));
});

clientsRouter.get("/:id", requirePermission("crm.read"), async (req, res) => {
  const client = await clientService.getClient(req.user!, req.params.id);
  if (!client) return res.status(404).json({ error: "NOT_FOUND" });
  res.json(client);
});

clientsRouter.post("/", requirePermission(CREATE_CLIENT_ACTION.requiredPermission), async (req, res) => {
  const result = await clientService.createClient(req.user!, req.body);
  if (!result.ok) {
    return res.status(result.httpStatus).json({ error: result.error, message: result.message, ...result.extra });
  }
  res.status(result.httpStatus).json(result.data);
});

clientsRouter.put("/:id", requirePermission(UPDATE_CLIENT_ACTION.requiredPermission), async (req, res) => {
  const result = await clientService.updateClient(req.user!, req.params.id, req.body);
  if (!result.ok) {
    return res.status(result.httpStatus).json({ error: result.error, message: result.message, ...result.extra });
  }
  res.status(result.httpStatus).json(result.data);
});

// Client deletion is deliberately a confirmed soft-delete. It disappears
// from active CRM views, while jobs, invoices and history keep their client
// relation and remain auditable.
clientsRouter.delete("/:id", requirePermission(ARCHIVE_CLIENT_ACTION.requiredPermission), async (req, res) => {
  const result = await clientService.archiveClient(req.user!, req.params.id, req.body);
  if (!result.ok) {
    return res.status(result.httpStatus).json({ error: result.error, message: result.message, ...result.extra });
  }
  res.status(result.httpStatus).json(result.data);
});
