import { Router } from "express";
import { z } from "zod";
import {
  CREATE_DOCUMENT_RECORD_ACTION,
  DOCUMENT_SENSITIVITIES,
  DOCUMENT_TYPES,
  UPDATE_DOCUMENT_RECORD_ACTION,
} from "../../lib/actionContracts.js";
import { requireAuth } from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/permissions.js";
import * as documentService from "../../services/documentRecordService.js";

export const documentsRouter = Router();
documentsRouter.use(requireAuth);

const listQuerySchema = z.object({
  client_id: z.string().uuid().optional(),
  job_id: z.string().uuid().optional(),
  document_type: z.enum(DOCUMENT_TYPES).optional(),
  sensitivity: z.enum(DOCUMENT_SENSITIVITIES).optional(),
  active_only: z.enum(["true", "false"]).optional(),
});

documentsRouter.get("/", requirePermission("crm.read"), async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "VALIDATION_FAILED", message: parsed.error.message });
  res.json(await documentService.listDocumentRecords(req.user!, {
    clientId: parsed.data.client_id,
    jobId: parsed.data.job_id,
    documentType: parsed.data.document_type,
    sensitivity: parsed.data.sensitivity,
    activeOnly: parsed.data.active_only === "true",
  }));
});

documentsRouter.get("/:id", requirePermission("crm.read"), async (req, res) => {
  const document = await documentService.getDocumentRecord(req.user!, req.params.id);
  if (!document) return res.status(404).json({ error: "DOCUMENT_RECORD_NOT_FOUND" });
  res.json(document);
});

documentsRouter.post("/", requirePermission(CREATE_DOCUMENT_RECORD_ACTION.requiredPermission), async (req, res) => {
  const result = await documentService.createDocumentRecord(req.user!, req.body);
  if (!result.ok) return res.status(result.httpStatus).json({ error: result.error, message: result.message, ...result.extra });
  res.status(result.httpStatus).json(result.data);
});

documentsRouter.put("/:id", requirePermission(UPDATE_DOCUMENT_RECORD_ACTION.requiredPermission), async (req, res) => {
  const result = await documentService.updateDocumentRecord(req.user!, req.params.id, req.body);
  if (!result.ok) return res.status(result.httpStatus).json({ error: result.error, message: result.message, ...result.extra });
  res.status(result.httpStatus).json(result.data);
});
