import { Router } from "express";
import { requireAuth } from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/permissions.js";
import {
  GET_ATTENTION_FEED_ACTION,
  ACKNOWLEDGE_NOTIFICATION_ACTION,
  DELETE_ALL_NOTIFICATIONS_ACTION,
  UNACKNOWLEDGE_NOTIFICATION_ACTION,
} from "../../lib/actionContracts.js";
import * as notificationService from "../../services/notificationService.js";
import { getDigestPreferences, sendNotificationDigest, updateDigestPreferences } from "../../services/notificationDigestService.js";

export const notificationsRouter = Router();

notificationsRouter.use(requireAuth);

notificationsRouter.get("/", requirePermission(GET_ATTENTION_FEED_ACTION.requiredPermission), async (req, res) => {
  const includeAcknowledged = req.query.include_acknowledged === "true";
  res.json(await notificationService.getAttentionFeed(req.user!, { includeAcknowledged }));
});

notificationsRouter.post(
  "/acknowledge",
  requirePermission(ACKNOWLEDGE_NOTIFICATION_ACTION.requiredPermission),
  async (req, res) => {
    const result = await notificationService.acknowledgeNotification(req.user!, req.body);
    if (!result.ok) return res.status(result.httpStatus).json({ error: result.error, message: result.message, ...result.extra });
    res.status(result.httpStatus).json(result.data);
  }
);

notificationsRouter.delete(
  "/:key",
  requirePermission(ACKNOWLEDGE_NOTIFICATION_ACTION.requiredPermission),
  async (req, res) => {
    const notificationKey = decodeURIComponent(req.params.key);
    const result = await notificationService.acknowledgeNotification(req.user!, {
      notification_key: notificationKey,
    });
    if (!result.ok) return res.status(result.httpStatus).json({ error: result.error, message: result.message, ...result.extra });
    res.status(result.httpStatus).json({ notification_key: notificationKey, deleted: true, reversible: true });
  }
);

notificationsRouter.post(
  "/delete-all",
  requirePermission(DELETE_ALL_NOTIFICATIONS_ACTION.requiredPermission),
  async (req, res) => {
    const result = await notificationService.deleteAllNotifications(req.user!, req.body);
    if (!result.ok) return res.status(result.httpStatus).json({ error: result.error, message: result.message, ...result.extra });
    res.status(result.httpStatus).json(result.data);
  }
);

notificationsRouter.post(
  "/:key/unacknowledge",
  requirePermission(UNACKNOWLEDGE_NOTIFICATION_ACTION.requiredPermission),
  async (req, res) => {
    const result = await notificationService.unacknowledgeNotification(req.user!, decodeURIComponent(req.params.key));
    if (!result.ok) return res.status(result.httpStatus).json({ error: result.error, message: result.message, ...result.extra });
    res.status(result.httpStatus).json(result.data);
  }
);

// Daily digest — opt-in per user; the digest is only ever sent to the
// signed-in user's own account email. A send without confirmed:true returns
// the exact message as a 409 preview and sends nothing.
notificationsRouter.get("/digest/preferences", requirePermission(GET_ATTENTION_FEED_ACTION.requiredPermission), async (req, res) => {
  res.json(await getDigestPreferences(req.user!));
});

notificationsRouter.put("/digest/preferences", requirePermission(GET_ATTENTION_FEED_ACTION.requiredPermission), async (req, res) => {
  const result = await updateDigestPreferences(req.user!, req.body);
  if (!result.ok) return res.status(result.httpStatus).json({ error: result.error, message: result.message });
  res.json(result.data);
});

notificationsRouter.post("/digest/send", requirePermission(GET_ATTENTION_FEED_ACTION.requiredPermission), async (req, res) => {
  const confirmed = typeof req.body === "object" && req.body !== null && (req.body as { confirmed?: unknown }).confirmed === true;
  const result = await sendNotificationDigest(req.user!, { confirmed });
  if (!result.ok) return res.status(result.httpStatus).json({ error: result.error, message: result.message, ...result.extra });
  res.json(result.data);
});
