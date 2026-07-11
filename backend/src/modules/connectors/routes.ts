import { Router } from "express";
import { z } from "zod";
import {
  DISABLE_CONNECTOR_SOURCE_ACTION,
  DISCONNECT_GMAIL_SOURCE_ACTION,
  ENABLE_CONNECTOR_SOURCE_ACTION,
  REGISTER_CONNECTOR_SOURCE_ACTION,
  START_GMAIL_OAUTH_ACTION,
  SYNC_GMAIL_MESSAGES_ACTION,
  IMPORT_GOOGLE_CONTACT_ACTION,
  UPDATE_CONNECTOR_SOURCE_ACTION,
} from "../../lib/actionContracts.js";
import { requireAuth } from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/permissions.js";
import * as connectorService from "../../services/connectorService.js";
import * as gmailConnectorService from "../../services/gmailConnectorService.js";
import * as googleContactsConnectorService from "../../services/googleContactsConnectorService.js";

export const connectorsRouter = Router();

// Google redirects here without the application's JWT. The one-time,
// short-lived state binds the callback to its tenant, source and initiating
// user; it is consumed before the provider code is exchanged.
connectorsRouter.get("/gmail/oauth/callback", async (req, res) => {
  const result = await gmailConnectorService.completeGmailOAuth(req.query);
  if (!result.ok) return res.status(result.httpStatus).json({ error: result.error, message: result.message, ...result.extra });
  res.redirect(303, result.data.redirectUrl);
});

connectorsRouter.get("/google-contacts/oauth/callback", async (req, res) => {
  const result = await googleContactsConnectorService.completeGoogleContactsOAuth(req.query);
  if (!result.ok) return res.status(result.httpStatus).json({ error: result.error, message: result.message, ...result.extra });
  res.redirect(303, result.data.redirectUrl);
});

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

connectorsRouter.post(
  "/sources/:id/oauth/start",
  requirePermission(START_GMAIL_OAUTH_ACTION.requiredPermission),
  async (req, res) => {
    const source = await connectorService.getConnectorSource(req.user!, req.params.id);
    const result = source?.connectorKey === "google_contacts"
      ? await googleContactsConnectorService.startGoogleContactsOAuth(req.user!, req.params.id)
      : await gmailConnectorService.startGmailOAuth(req.user!, req.params.id);
    if (!result.ok) return res.status(result.httpStatus).json({ error: result.error, message: result.message, ...result.extra });
    res.status(result.httpStatus).json(result.data);
  }
);

connectorsRouter.post(
  "/sources/:id/sync",
  requirePermission(SYNC_GMAIL_MESSAGES_ACTION.requiredPermission),
  async (req, res) => {
    const source = await connectorService.getConnectorSource(req.user!, req.params.id);
    const result = source?.connectorKey === "google_contacts"
      ? await googleContactsConnectorService.syncGoogleContacts(req.user!, req.params.id)
      : await gmailConnectorService.syncGmailMessages(req.user!, req.params.id, req.body);
    if (!result.ok) return res.status(result.httpStatus).json({ error: result.error, message: result.message, ...result.extra });
    res.status(result.httpStatus).json(result.data);
  }
);

connectorsRouter.post(
  "/sources/:id/disconnect",
  requirePermission(DISCONNECT_GMAIL_SOURCE_ACTION.requiredPermission),
  async (req, res) => {
    const source = await connectorService.getConnectorSource(req.user!, req.params.id);
    const result = source?.connectorKey === "google_contacts"
      ? await googleContactsConnectorService.disconnectGoogleContactsSource(req.user!, req.params.id, req.body)
      : await gmailConnectorService.disconnectGmailSource(req.user!, req.params.id, req.body);
    if (!result.ok) return res.status(result.httpStatus).json({ error: result.error, message: result.message, ...result.extra });
    res.status(result.httpStatus).json(result.data);
  }
);

connectorsRouter.get(
  "/sources/:id/external-contacts",
  requirePermission("connectors.read"),
  async (req, res) => {
    const result = await googleContactsConnectorService.listExternalContacts(req.user!, req.params.id, req.query);
    if (!result.ok) return res.status(result.httpStatus).json({ error: result.error, message: result.message, ...result.extra });
    res.status(result.httpStatus).json(result.data);
  }
);

connectorsRouter.post(
  "/sources/:id/external-contacts/:externalContactId/import",
  requirePermission("connectors.manage"),
  requirePermission(IMPORT_GOOGLE_CONTACT_ACTION.requiredPermission),
  async (req, res) => {
    const result = await googleContactsConnectorService.importGoogleContact(
      req.user!, req.params.id, req.params.externalContactId, req.body
    );
    if (!result.ok) return res.status(result.httpStatus).json({ error: result.error, message: result.message, ...result.extra });
    res.status(result.httpStatus).json(result.data);
  }
);
