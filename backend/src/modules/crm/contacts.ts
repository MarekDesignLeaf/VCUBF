import { Router } from "express";
import { z } from "zod";
import { ARCHIVE_CONTACT_ACTION, CREATE_CONTACT_ACTION, UPDATE_CONTACT_ACTION } from "../../lib/actionContracts.js";
import { requireAuth } from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/permissions.js";
import * as contactService from "../../services/contactService.js";

export const contactsRouter = Router();
contactsRouter.use(requireAuth);

const listQuerySchema = z.object({
  client_id: z.string().uuid().optional(),
  active_only: z.enum(["true", "false"]).optional(),
  search: z.string().trim().max(200).optional(),
});

contactsRouter.get("/", requirePermission("crm.read"), async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "VALIDATION_FAILED", message: parsed.error.message });
  res.json(await contactService.listContacts(req.user!, {
    clientId: parsed.data.client_id,
    activeOnly: parsed.data.active_only === "true",
    search: parsed.data.search,
  }));
});

contactsRouter.get("/:id", requirePermission("crm.read"), async (req, res) => {
  const contact = await contactService.getContact(req.user!, req.params.id);
  if (!contact) return res.status(404).json({ error: "CONTACT_NOT_FOUND" });
  res.json(contact);
});

contactsRouter.post("/", requirePermission(CREATE_CONTACT_ACTION.requiredPermission), async (req, res) => {
  const result = await contactService.createContact(req.user!, req.body);
  if (!result.ok) return res.status(result.httpStatus).json({ error: result.error, message: result.message, ...result.extra });
  res.status(result.httpStatus).json(result.data);
});

contactsRouter.put("/:id", requirePermission(UPDATE_CONTACT_ACTION.requiredPermission), async (req, res) => {
  const result = await contactService.updateContact(req.user!, req.params.id, req.body);
  if (!result.ok) return res.status(result.httpStatus).json({ error: result.error, message: result.message, ...result.extra });
  res.status(result.httpStatus).json(result.data);
});

contactsRouter.delete("/:id", requirePermission(ARCHIVE_CONTACT_ACTION.requiredPermission), async (req, res) => {
  const result = await contactService.archiveContact(req.user!, req.params.id, req.body);
  if (!result.ok) return res.status(result.httpStatus).json({ error: result.error, message: result.message, ...result.extra });
  res.status(result.httpStatus).json(result.data);
});
