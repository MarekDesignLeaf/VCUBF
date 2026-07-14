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
