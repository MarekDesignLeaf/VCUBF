import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db.js";
import { requireAuth } from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/permissions.js";
import { recordAudit } from "../../lib/audit.js";
import { CHANGE_JOB_STATUS_ACTION, CREATE_JOB_ACTION, JOB_STATUSES } from "../../lib/actionContracts.js";

export const jobsRouter = Router();

jobsRouter.use(requireAuth);

const createJobSchema = z.object({
  client_id: z.string().uuid("client_id must be a valid id"),
  job_title: z.string().min(1, "job_title is required"),
  job_status: z.enum(JOB_STATUSES).optional(),
  property_address: z.string().optional(),
  planned_start_at: z.string().datetime().optional(),
  planned_end_at: z.string().datetime().optional(),
  notes: z.string().optional(),
});

const changeStatusSchema = z.object({
  job_status: z.enum(JOB_STATUSES, {
    errorMap: () => ({ message: `job_status must be one of: ${JOB_STATUSES.join(", ")}` }),
  }),
});

// GET /crm/jobs?client_id=&status=
jobsRouter.get("/", requirePermission("crm.read"), async (req, res) => {
  const { client_id, status } = req.query;
  const jobs = await prisma.job.findMany({
    where: {
      companyId: req.user!.companyId,
      ...(typeof client_id === "string" ? { clientId: client_id } : {}),
      ...(typeof status === "string" ? { jobStatus: status } : {}),
    },
    include: { client: { select: { id: true, displayName: true } } },
    orderBy: { createdAt: "desc" },
  });
  res.json(jobs);
});

// GET /crm/jobs/:id
jobsRouter.get("/:id", requirePermission("crm.read"), async (req, res) => {
  const job = await prisma.job.findFirst({
    where: { id: req.params.id, companyId: req.user!.companyId },
    include: { client: { select: { id: true, displayName: true } } },
  });
  if (!job) return res.status(404).json({ error: "NOT_FOUND" });
  res.json(job);
});

// POST /crm/jobs — Action Contract: create_job
jobsRouter.post("/", requirePermission(CREATE_JOB_ACTION.requiredPermission), async (req, res) => {
  const parsed = createJobSchema.safeParse(req.body);
  if (!parsed.success) {
    await recordAudit({
      companyId: req.user!.companyId,
      userId: req.user!.id,
      actionName: CREATE_JOB_ACTION.actionName,
      inputPayload: req.body,
      riskLevel: CREATE_JOB_ACTION.riskLevel,
      confirmationRequired: CREATE_JOB_ACTION.confirmationRequired,
      result: "error",
      errorMessage: "VALIDATION_FAILED",
    });
    return res.status(400).json({ error: "VALIDATION_FAILED", message: parsed.error.message });
  }
  const data = parsed.data;

  // client_id must belong to this company — never trust a cross-tenant id.
  const client = await prisma.client.findFirst({
    where: { id: data.client_id, companyId: req.user!.companyId },
  });
  if (!client) {
    await recordAudit({
      companyId: req.user!.companyId,
      userId: req.user!.id,
      actionName: CREATE_JOB_ACTION.actionName,
      inputPayload: data,
      riskLevel: CREATE_JOB_ACTION.riskLevel,
      confirmationRequired: CREATE_JOB_ACTION.confirmationRequired,
      result: "error",
      errorMessage: "CLIENT_NOT_FOUND",
    });
    return res.status(404).json({ error: "CLIENT_NOT_FOUND", message: "client_id does not belong to your company." });
  }

  const job = await prisma.job.create({
    data: {
      companyId: req.user!.companyId,
      clientId: data.client_id,
      jobTitle: data.job_title,
      jobStatus: data.job_status ?? "nova",
      propertyAddress: data.property_address,
      plannedStartAt: data.planned_start_at ? new Date(data.planned_start_at) : undefined,
      plannedEndAt: data.planned_end_at ? new Date(data.planned_end_at) : undefined,
      notes: data.notes,
      createdBy: req.user!.id,
    },
  });

  await recordAudit({
    companyId: req.user!.companyId,
    userId: req.user!.id,
    actionName: CREATE_JOB_ACTION.actionName,
    inputPayload: data,
    dataAfter: job,
    riskLevel: CREATE_JOB_ACTION.riskLevel,
    confirmationRequired: CREATE_JOB_ACTION.confirmationRequired,
    result: "success",
  });

  res.status(201).json(job);
});

// PUT /crm/jobs/:id — Action Contract: change_job_status
jobsRouter.put("/:id", requirePermission(CHANGE_JOB_STATUS_ACTION.requiredPermission), async (req, res) => {
  const parsed = changeStatusSchema.safeParse(req.body);
  if (!parsed.success) {
    await recordAudit({
      companyId: req.user!.companyId,
      userId: req.user!.id,
      actionName: CHANGE_JOB_STATUS_ACTION.actionName,
      inputPayload: { jobId: req.params.id, ...req.body },
      riskLevel: CHANGE_JOB_STATUS_ACTION.riskLevel,
      confirmationRequired: CHANGE_JOB_STATUS_ACTION.confirmationRequired,
      result: "error",
      errorMessage: "VALIDATION_FAILED",
    });
    return res.status(400).json({ error: "VALIDATION_FAILED", message: parsed.error.message });
  }

  const existing = await prisma.job.findFirst({
    where: { id: req.params.id, companyId: req.user!.companyId },
  });
  if (!existing) {
    await recordAudit({
      companyId: req.user!.companyId,
      userId: req.user!.id,
      actionName: CHANGE_JOB_STATUS_ACTION.actionName,
      inputPayload: { jobId: req.params.id, ...parsed.data },
      riskLevel: CHANGE_JOB_STATUS_ACTION.riskLevel,
      confirmationRequired: CHANGE_JOB_STATUS_ACTION.confirmationRequired,
      result: "error",
      errorMessage: "JOB_NOT_FOUND",
    });
    return res.status(404).json({ error: "JOB_NOT_FOUND" });
  }

  const job = await prisma.job.update({
    where: { id: existing.id },
    data: { jobStatus: parsed.data.job_status },
  });

  await recordAudit({
    companyId: req.user!.companyId,
    userId: req.user!.id,
    actionName: CHANGE_JOB_STATUS_ACTION.actionName,
    inputPayload: { jobId: existing.id, job_status: parsed.data.job_status },
    dataBefore: { jobStatus: existing.jobStatus },
    dataAfter: { jobStatus: job.jobStatus },
    riskLevel: CHANGE_JOB_STATUS_ACTION.riskLevel,
    confirmationRequired: CHANGE_JOB_STATUS_ACTION.confirmationRequired,
    result: "success",
  });

  res.json(job);
});
