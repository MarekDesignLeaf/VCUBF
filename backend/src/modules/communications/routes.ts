import { Router } from "express";
import { requireAuth } from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/permissions.js";
import {
  CREATE_CLIENT_FROM_COMMUNICATION_ACTION,
  CREATE_COMMUNICATION_RECORD_ACTION,
  DELETE_GMAIL_INTAKE_ACTION,
  EXTRACT_COMMUNICATION_INTAKE_ACTION,
  FIND_UNRESOLVED_ENQUIRIES_ACTION,
  LOG_COMMUNICATION_INTAKE_ACTION,
  PREPARE_COMMUNICATION_REPLY_ACTION,
  SET_COMMUNICATION_INTAKE_RESOLUTION_ACTION,
  UPDATE_COMMUNICATION_RECORD_ACTION,
} from "../../lib/actionContracts.js";
import * as communicationService from "../../services/communicationService.js";
import * as gmailConnectorService from "../../services/gmailConnectorService.js";

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

communicationsRouter.get(
  "/enquiries",
  requirePermission(FIND_UNRESOLVED_ENQUIRIES_ACTION.requiredPermission),
  async (req, res) => {
    const parsed = communicationService.enquiryQuerySchema.safeParse({
      resolution: req.query.resolution,
      since: req.query.since,
      channel: req.query.channel,
    });
    if (!parsed.success) return res.status(400).json({ error: "VALIDATION_FAILED", message: parsed.error.message });
    res.json(await communicationService.listEnquiries(req.user!, parsed.data));
  }
);

communicationsRouter.get("/intakes", requirePermission("crm.read"), async (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  res.json(await communicationService.listCommunicationIntakes(req.user!, status));
});

communicationsRouter.get("/intakes/:id", requirePermission("crm.read"), async (req, res) => {
  const intake = await communicationService.getCommunicationIntake(req.user!, req.params.id);
  if (!intake) return res.status(404).json({ error: "COMMUNICATION_INTAKE_NOT_FOUND" });
  res.json(intake);
});

communicationsRouter.put(
  "/intakes/:id/resolution",
  requirePermission(SET_COMMUNICATION_INTAKE_RESOLUTION_ACTION.requiredPermission),
  async (req, res) => {
    const result = await communicationService.updateCommunicationIntakeResolution(req.user!, req.params.id, req.body);
    if (!result.ok) return res.status(result.httpStatus).json({ error: result.error, message: result.message, ...result.extra });
    res.status(result.httpStatus).json(result.data);
  }
);

communicationsRouter.post(
  "/intakes",
  requirePermission(LOG_COMMUNICATION_INTAKE_ACTION.requiredPermission),
  async (req, res) => {
    const result = await communicationService.createCommunicationIntake(req.user!, req.body);
    if (!result.ok) return res.status(result.httpStatus).json({ error: result.error, message: result.message, ...result.extra });
    res.status(result.httpStatus).json(result.data);
  }
);

communicationsRouter.post(
  "/intakes/:id/extract",
  requirePermission(EXTRACT_COMMUNICATION_INTAKE_ACTION.requiredPermission),
  async (req, res) => {
    const result = await communicationService.extractCommunicationIntake(req.user!, req.params.id);
    if (!result.ok) return res.status(result.httpStatus).json({ error: result.error, message: result.message, ...result.extra });
    res.status(result.httpStatus).json(result.data);
  }
);

communicationsRouter.post(
  "/intakes/:id/convert",
  requirePermission(CREATE_CLIENT_FROM_COMMUNICATION_ACTION.requiredPermission),
  async (req, res) => {
    const result = await communicationService.convertCommunicationIntake(req.user!, req.params.id, req.body);
    if (!result.ok) return res.status(result.httpStatus).json({ error: result.error, message: result.message, ...result.extra });
    res.status(result.httpStatus).json(result.data);
  }
);

communicationsRouter.post(
  "/intakes/:id/reply-draft",
  requirePermission(PREPARE_COMMUNICATION_REPLY_ACTION.requiredPermission),
  async (req, res) => {
    const result = await communicationService.prepareCommunicationReply(req.user!, req.params.id);
    if (!result.ok) return res.status(result.httpStatus).json({ error: result.error, message: result.message, ...result.extra });
    res.status(result.httpStatus).json(result.data);
  }
);

communicationsRouter.delete(
  "/intakes/:id",
  requirePermission("crm.manage"),
  requirePermission(DELETE_GMAIL_INTAKE_ACTION.requiredPermission),
  async (req, res) => {
    const result = await gmailConnectorService.deleteGmailIntake(req.user!, req.params.id, req.body);
    if (!result.ok) return res.status(result.httpStatus).json({ error: result.error, message: result.message, ...result.extra });
    res.status(result.httpStatus).json(result.data);
  }
);

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
