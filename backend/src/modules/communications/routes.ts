import { Router } from "express";
import { requireAuth } from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/permissions.js";
import {
  CREATE_COMMUNICATION_RECORD_ACTION,
  UPDATE_COMMUNICATION_RECORD_ACTION,
} from "../../lib/actionContracts.js";
import * as communicationService from "../../services/communicationService.js";

export const communicationsRouter = Router();

communicationsRouter.use(requireAuth);

communicationsRouter.get("/", requirePermission("crm.read"), async (req, res) => {
  const { client_id, job_id, channel, follow_up_needed } = req.query;
  res.json(
    await communicationService.listCommunicationRecords(req.user!, {
      clientId: typeof client_id === "string" ? client_id : undefined,
      jobId: typeof job_id === "string" ? job_id : undefined,
      channel: typeof channel === "string" ? channel : undefined,
      followUpNeeded:
        follow_up_needed === "true" ? true : follow_up_needed === "false" ? false : undefined,
    })
  );
});

communicationsRouter.get("/follow-ups-due", requirePermission("crm.read"), async (req, res) => {
  res.json(await communicationService.listFollowUpsDue(req.user!));
});

communicationsRouter.get("/:id", requirePermission("crm.read"), async (req, res) => {
  const record = await communicationService.getCommunicationRecord(req.user!, req.params.id);
  if (!record) return res.status(404).json({ error: "COMMUNICATION_RECORD_NOT_FOUND" });
  res.json(record);
});

communicationsRouter.post(
  "/",
  requirePermission(CREATE_COMMUNICATION_RECORD_ACTION.requiredPermission),
  async (req, res) => {
    const result = await communicationService.createCommunicationRecord(req.user!, req.body);
    if (!result.ok) return res.status(result.httpStatus).json({ error: result.error, message: result.message, ...result.extra });
    res.status(result.httpStatus).json(result.data);
  }
);

communicationsRouter.put(
  "/:id",
  requirePermission(UPDATE_COMMUNICATION_RECORD_ACTION.requiredPermission),
  async (req, res) => {
    const result = await communicationService.updateCommunicationRecord(req.user!, req.params.id, req.body);
    if (!result.ok) return res.status(result.httpStatus).json({ error: result.error, message: result.message, ...result.extra });
    res.status(result.httpStatus).json(result.data);
  }
);
