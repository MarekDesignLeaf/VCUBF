import { Router } from "express";
import { requireAuth } from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/permissions.js";
import {
  ARCHIVE_CLIENT_ACTION,
  CREATE_CLIENT_ACTION,
  DELETE_CLIENT_PERMANENTLY_ACTION,
  UPDATE_CLIENT_ACTION,
} from "../../lib/actionContracts.js";
import * as clientService from "../../services/clientService.js";
import * as permanentDeletion from "../../services/crmPermanentDeletionService.js";

export const clientsRouter = Router();

clientsRouter.use(requireAuth);

// ?status=archived lists archived clients (so they can be found again, and
// deleted permanently if nothing depends on them); the default stays active.
clientsRouter.get("/", requirePermission("crm.read"), async (req, res) => {
  const status = req.query.status === "archived" ? "archived" : "active";
  res.json(await clientService.listClients(req.user!, status));
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

// DELETE /:id is, and stays, the confirmed ARCHIVE (soft-delete): the client
// disappears from active CRM views while jobs, invoices and history keep
// their client relation. Permanent deletion is a different action with its
// own route below, so a caller can never reach it by accident.
clientsRouter.delete("/:id", requirePermission(ARCHIVE_CLIENT_ACTION.requiredPermission), async (req, res) => {
  const result = await clientService.archiveClient(req.user!, req.params.id, req.body);
  if (!result.ok) {
    return res.status(result.httpStatus).json({ error: result.error, message: result.message, ...result.extra });
  }
  res.status(result.httpStatus).json(result.data);
});

// Permanent deletion: a separate action from archiving. GET gives the exact
// record, links, dependency counts, blockers and the digest to confirm; POST
// with confirmed, preview_digest and the typed display name deletes, inside
// the company, only if nothing depends on the client.
clientsRouter.get("/:id/permanent-deletion", requirePermission(DELETE_CLIENT_PERMANENTLY_ACTION.requiredPermission), async (req, res) => {
  const result = await permanentDeletion.previewClientPermanentDeletion(req.user!, req.params.id);
  if (!result.ok) return res.status(result.httpStatus).json({ error: result.error, message: result.message, ...result.extra });
  res.status(result.httpStatus).json(result.data);
});

clientsRouter.post("/:id/permanent-deletion", requirePermission(DELETE_CLIENT_PERMANENTLY_ACTION.requiredPermission), async (req, res) => {
  const result = await permanentDeletion.deleteClientPermanently(req.user!, req.params.id, req.body);
  if (!result.ok) return res.status(result.httpStatus).json({ error: result.error, message: result.message, ...result.extra });
  res.status(result.httpStatus).json(result.data);
});
