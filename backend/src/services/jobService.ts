import { z } from "zod";
import { prisma } from "../db.js";
import { recordAudit } from "../lib/audit.js";
import { CHANGE_JOB_STATUS_ACTION, CREATE_JOB_ACTION, JOB_STATUSES } from "../lib/actionContracts.js";
import type { AuthedUser } from "../middleware/auth.js";
import { fail, ok, type ServiceResult } from "./result.js";

export const createJobSchema = z.object({
  client_id: z.string().uuid("client_id must be a valid id"),
  job_title: z.string().min(1, "job_title is required"),
  job_status: z.enum(JOB_STATUSES).optional(),
  property_address: z.string().optional(),
  planned_start_at: z.string().datetime().optional(),
  planned_end_at: z.string().datetime().optional(),
  notes: z.string().optional(),
});

export const changeStatusSchema = z.object({
  job_status: z.enum(JOB_STATUSES, {
    errorMap: () => ({ message: `job_status must be one of: ${JOB_STATUSES.join(", ")}` }),
  }),
});

export async function listJobs(user: AuthedUser, filters: { clientId?: string; status?: string }) {
  return prisma.job.findMany({
    where: {
      companyId: user.companyId,
      ...(filters.clientId ? { clientId: filters.clientId } : {}),
      ...(filters.status ? { jobStatus: filters.status } : {}),
    },
    include: { client: { select: { id: true, displayName: true } } },
    orderBy: { createdAt: "desc" },
  });
}

export async function getJob(user: AuthedUser, id: string) {
  return prisma.job.findFirst({
    where: { id, companyId: user.companyId },
    include: { client: { select: { id: true, displayName: true } } },
  });
}

// create_job — Action Contract driven.
export async function createJob(user: AuthedUser, rawInput: unknown): Promise<ServiceResult<unknown>> {
  const parsed = createJobSchema.safeParse(rawInput);
  if (!parsed.success) {
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: CREATE_JOB_ACTION.actionName,
      inputPayload: rawInput,
      riskLevel: CREATE_JOB_ACTION.riskLevel,
      confirmationRequired: CREATE_JOB_ACTION.confirmationRequired,
      result: "error",
      errorMessage: "VALIDATION_FAILED",
    });
    return fail(400, "VALIDATION_FAILED", parsed.error.message);
  }
  const data = parsed.data;

  const client = await prisma.client.findFirst({ where: { id: data.client_id, companyId: user.companyId } });
  if (!client) {
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: CREATE_JOB_ACTION.actionName,
      inputPayload: data,
      riskLevel: CREATE_JOB_ACTION.riskLevel,
      confirmationRequired: CREATE_JOB_ACTION.confirmationRequired,
      result: "error",
      errorMessage: "CLIENT_NOT_FOUND",
    });
    return fail(404, "CLIENT_NOT_FOUND", "client_id does not belong to your company.");
  }

  const job = await prisma.job.create({
    data: {
      companyId: user.companyId,
      clientId: data.client_id,
      jobTitle: data.job_title,
      jobStatus: data.job_status ?? "nova",
      propertyAddress: data.property_address,
      plannedStartAt: data.planned_start_at ? new Date(data.planned_start_at) : undefined,
      plannedEndAt: data.planned_end_at ? new Date(data.planned_end_at) : undefined,
      notes: data.notes,
      createdBy: user.id,
    },
  });

  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: CREATE_JOB_ACTION.actionName,
    inputPayload: data,
    dataAfter: job,
    riskLevel: CREATE_JOB_ACTION.riskLevel,
    confirmationRequired: CREATE_JOB_ACTION.confirmationRequired,
    result: "success",
  });

  return ok(201, job);
}

// change_job_status — Action Contract driven.
export async function changeJobStatus(user: AuthedUser, jobId: string, rawInput: unknown): Promise<ServiceResult<unknown>> {
  const parsed = changeStatusSchema.safeParse(rawInput);
  if (!parsed.success) {
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: CHANGE_JOB_STATUS_ACTION.actionName,
      inputPayload: { jobId, ...(typeof rawInput === "object" && rawInput ? rawInput : {}) },
      riskLevel: CHANGE_JOB_STATUS_ACTION.riskLevel,
      confirmationRequired: CHANGE_JOB_STATUS_ACTION.confirmationRequired,
      result: "error",
      errorMessage: "VALIDATION_FAILED",
    });
    return fail(400, "VALIDATION_FAILED", parsed.error.message);
  }

  const existing = await prisma.job.findFirst({ where: { id: jobId, companyId: user.companyId } });
  if (!existing) {
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: CHANGE_JOB_STATUS_ACTION.actionName,
      inputPayload: { jobId, ...parsed.data },
      riskLevel: CHANGE_JOB_STATUS_ACTION.riskLevel,
      confirmationRequired: CHANGE_JOB_STATUS_ACTION.confirmationRequired,
      result: "error",
      errorMessage: "JOB_NOT_FOUND",
    });
    return fail(404, "JOB_NOT_FOUND");
  }

  const job = await prisma.job.update({ where: { id: existing.id }, data: { jobStatus: parsed.data.job_status } });

  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: CHANGE_JOB_STATUS_ACTION.actionName,
    inputPayload: { jobId: existing.id, job_status: parsed.data.job_status },
    dataBefore: { jobStatus: existing.jobStatus },
    dataAfter: { jobStatus: job.jobStatus },
    riskLevel: CHANGE_JOB_STATUS_ACTION.riskLevel,
    confirmationRequired: CHANGE_JOB_STATUS_ACTION.confirmationRequired,
    result: "success",
  });

  return ok(200, job);
}

// Case-insensitive substring match on job title — used by the Text Command
// Layer to resolve "set job X as scheduled" to a specific record.
export async function findJobsByTitle(user: AuthedUser, title: string) {
  return prisma.job.findMany({
    where: { companyId: user.companyId, jobTitle: { contains: title, mode: "insensitive" } },
    include: { client: { select: { id: true, displayName: true } } },
  });
}

// Maps common English/Czech words used in a spoken/typed command to the
// canonical technical status code. Anything not in this table is passed
// through as-is and validated by changeStatusSchema (so "dokonceno" still
// works directly). Kept as structured data, not inferred by a prompt.
const STATUS_WORD_MAP: Record<string, string> = {
  new: "nova",
  nova: "nova",
  scheduled: "naplanovano",
  naplanovano: "naplanovano",
  "in progress": "v_realizaci",
  v_realizaci: "v_realizaci",
  "waiting for material": "ceka_na_material",
  ceka_na_material: "ceka_na_material",
  "waiting for client": "ceka_na_klienta",
  ceka_na_klienta: "ceka_na_klienta",
  done: "dokonceno",
  completed: "dokonceno",
  dokonceno: "dokonceno",
  cancelled: "zruseno",
  canceled: "zruseno",
  zruseno: "zruseno",
};

export function resolveStatusWord(word: string): string {
  const key = word.trim().toLowerCase();
  return STATUS_WORD_MAP[key] ?? key;
}
