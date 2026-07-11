import { z } from "zod";
import { prisma } from "../db.js";
import {
  CREATE_DOCUMENT_RECORD_ACTION,
  DOCUMENT_SENSITIVITIES,
  DOCUMENT_SOURCES,
  DOCUMENT_TYPES,
  DOCUMENT_VERIFICATION_STATUSES,
  UPDATE_DOCUMENT_RECORD_ACTION,
} from "../lib/actionContracts.js";
import { recordAudit } from "../lib/audit.js";
import type { AuthedUser } from "../middleware/auth.js";
import { fail, ok, type ServiceResult } from "./result.js";

export const createDocumentRecordSchema = z
  .object({
    client_id: z.string().uuid().optional(),
    job_id: z.string().uuid().optional(),
    title: z.string().trim().min(1, "title is required").max(300),
    document_type: z.enum(DOCUMENT_TYPES),
    document_reference: z.string().trim().min(1, "document_reference is required").max(2_048),
    source: z.enum(DOCUMENT_SOURCES).default("user_input"),
    sensitivity: z.enum(DOCUMENT_SENSITIVITIES).default("normal"),
    verification_status: z.enum(DOCUMENT_VERIFICATION_STATUSES).default("user_entered"),
    issued_at: z.string().datetime().optional(),
    expires_at: z.string().datetime().optional(),
    notes: z.string().max(5_000).optional(),
  })
  .refine((data) => !data.issued_at || !data.expires_at || data.expires_at >= data.issued_at, {
    message: "expires_at must not be earlier than issued_at",
    path: ["expires_at"],
  });

export const updateDocumentRecordSchema = z
  .object({
    client_id: z.string().uuid().nullable().optional(),
    job_id: z.string().uuid().nullable().optional(),
    title: z.string().trim().min(1).max(300).optional(),
    document_type: z.enum(DOCUMENT_TYPES).optional(),
    document_reference: z.string().trim().min(1).max(2_048).optional(),
    source: z.enum(DOCUMENT_SOURCES).optional(),
    sensitivity: z.enum(DOCUMENT_SENSITIVITIES).optional(),
    verification_status: z.enum(DOCUMENT_VERIFICATION_STATUSES).optional(),
    issued_at: z.string().datetime().nullable().optional(),
    expires_at: z.string().datetime().nullable().optional(),
    notes: z.string().max(5_000).nullable().optional(),
    is_active: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, "At least one field is required");

const documentInclude = {
  client: { select: { id: true, displayName: true } },
  job: { select: { id: true, jobTitle: true } },
};

async function auditError(
  user: AuthedUser,
  action: typeof CREATE_DOCUMENT_RECORD_ACTION | typeof UPDATE_DOCUMENT_RECORD_ACTION,
  inputPayload: unknown,
  errorMessage: string,
  dataBefore?: unknown
) {
  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: action.actionName,
    inputPayload,
    dataBefore,
    riskLevel: action.riskLevel,
    confirmationRequired: action.confirmationRequired,
    result: "error",
    errorMessage,
  });
}

type RelationResolution =
  | { ok: true; clientId: string | null; jobId: string | null }
  | { ok: false; error: "CLIENT_NOT_FOUND" | "JOB_NOT_FOUND" | "RELATED_RECORD_MISMATCH" };

async function resolveRelations(
  user: AuthedUser,
  clientId?: string | null,
  jobId?: string | null
): Promise<RelationResolution> {
  const [client, job] = await Promise.all([
    clientId
      ? prisma.client.findFirst({ where: { id: clientId, companyId: user.companyId, isActive: true } })
      : Promise.resolve(null),
    jobId ? prisma.job.findFirst({ where: { id: jobId, companyId: user.companyId } }) : Promise.resolve(null),
  ]);
  if (clientId && !client) return { ok: false, error: "CLIENT_NOT_FOUND" };
  if (jobId && !job) return { ok: false, error: "JOB_NOT_FOUND" };
  if (client && job && client.id !== job.clientId) return { ok: false, error: "RELATED_RECORD_MISMATCH" };
  return { ok: true, clientId: job?.clientId ?? client?.id ?? null, jobId: job?.id ?? null };
}

export interface DocumentRecordFilters {
  clientId?: string;
  jobId?: string;
  documentType?: string;
  sensitivity?: string;
  activeOnly?: boolean;
}

export async function listDocumentRecords(user: AuthedUser, filters: DocumentRecordFilters = {}) {
  return prisma.documentRecord.findMany({
    where: {
      companyId: user.companyId,
      ...(filters.clientId ? { clientId: filters.clientId } : {}),
      ...(filters.jobId ? { jobId: filters.jobId } : {}),
      ...(filters.documentType ? { documentType: filters.documentType } : {}),
      ...(filters.sensitivity ? { sensitivity: filters.sensitivity } : {}),
      ...(filters.activeOnly ? { isActive: true } : {}),
    },
    include: documentInclude,
    orderBy: [{ issuedAt: "desc" }, { createdAt: "desc" }],
  });
}

export async function getDocumentRecord(user: AuthedUser, id: string) {
  return prisma.documentRecord.findFirst({
    where: { id, companyId: user.companyId },
    include: documentInclude,
  });
}

export async function createDocumentRecord(user: AuthedUser, rawInput: unknown): Promise<ServiceResult<unknown>> {
  const parsed = createDocumentRecordSchema.safeParse(rawInput);
  if (!parsed.success) {
    await auditError(user, CREATE_DOCUMENT_RECORD_ACTION, rawInput, "VALIDATION_FAILED");
    return fail(400, "VALIDATION_FAILED", parsed.error.message);
  }
  const input = parsed.data;
  const relations = await resolveRelations(user, input.client_id, input.job_id);
  if (!relations.ok) {
    await auditError(user, CREATE_DOCUMENT_RECORD_ACTION, input, relations.error);
    const status = relations.error === "RELATED_RECORD_MISMATCH" ? 409 : 404;
    return fail(status, relations.error);
  }
  const created = await prisma.documentRecord.create({
    data: {
      companyId: user.companyId,
      clientId: relations.clientId,
      jobId: relations.jobId,
      title: input.title,
      documentType: input.document_type,
      documentReference: input.document_reference,
      source: input.source,
      sensitivity: input.sensitivity,
      verificationStatus: input.verification_status,
      issuedAt: input.issued_at ? new Date(input.issued_at) : undefined,
      expiresAt: input.expires_at ? new Date(input.expires_at) : undefined,
      notes: input.notes,
      createdBy: user.id,
    },
    include: documentInclude,
  });
  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: CREATE_DOCUMENT_RECORD_ACTION.actionName,
    inputPayload: input,
    dataAfter: created,
    riskLevel: CREATE_DOCUMENT_RECORD_ACTION.riskLevel,
    confirmationRequired: CREATE_DOCUMENT_RECORD_ACTION.confirmationRequired,
    result: "success",
  });
  return ok(201, created);
}

export async function updateDocumentRecord(
  user: AuthedUser,
  id: string,
  rawInput: unknown
): Promise<ServiceResult<unknown>> {
  const parsed = updateDocumentRecordSchema.safeParse(rawInput);
  if (!parsed.success) {
    await auditError(user, UPDATE_DOCUMENT_RECORD_ACTION, { id, input: rawInput }, "VALIDATION_FAILED");
    return fail(400, "VALIDATION_FAILED", parsed.error.message);
  }
  const input = parsed.data;
  const existing = await prisma.documentRecord.findFirst({ where: { id, companyId: user.companyId } });
  if (!existing) {
    await auditError(user, UPDATE_DOCUMENT_RECORD_ACTION, { id, ...input }, "DOCUMENT_RECORD_NOT_FOUND");
    return fail(404, "DOCUMENT_RECORD_NOT_FOUND");
  }
  const targetClientId = input.client_id !== undefined ? input.client_id : existing.clientId;
  const targetJobId = input.job_id !== undefined ? input.job_id : existing.jobId;
  const relations = await resolveRelations(user, targetClientId, targetJobId);
  if (!relations.ok) {
    await auditError(user, UPDATE_DOCUMENT_RECORD_ACTION, { id, ...input }, relations.error, existing);
    const status = relations.error === "RELATED_RECORD_MISMATCH" ? 409 : 404;
    return fail(status, relations.error);
  }
  const finalIssuedAt = input.issued_at !== undefined ? (input.issued_at ? new Date(input.issued_at) : null) : existing.issuedAt;
  const finalExpiresAt = input.expires_at !== undefined ? (input.expires_at ? new Date(input.expires_at) : null) : existing.expiresAt;
  if (finalIssuedAt && finalExpiresAt && finalExpiresAt < finalIssuedAt) {
    await auditError(user, UPDATE_DOCUMENT_RECORD_ACTION, { id, ...input }, "VALIDATION_FAILED", existing);
    return fail(400, "VALIDATION_FAILED", "expires_at must not be earlier than issued_at");
  }
  const changes: Record<string, unknown> = { clientId: relations.clientId, jobId: relations.jobId };
  const mapping: Record<string, string> = {
    title: "title", document_type: "documentType", document_reference: "documentReference", source: "source",
    sensitivity: "sensitivity", verification_status: "verificationStatus", notes: "notes", is_active: "isActive",
  };
  for (const [inputKey, dbKey] of Object.entries(mapping)) {
    if (Object.prototype.hasOwnProperty.call(input, inputKey)) changes[dbKey] = input[inputKey as keyof typeof input];
  }
  if (input.issued_at !== undefined) changes.issuedAt = finalIssuedAt;
  if (input.expires_at !== undefined) changes.expiresAt = finalExpiresAt;
  const updated = await prisma.documentRecord.update({
    where: { id: existing.id },
    data: changes,
    include: documentInclude,
  });
  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: UPDATE_DOCUMENT_RECORD_ACTION.actionName,
    inputPayload: { id, changes },
    dataBefore: existing,
    dataAfter: updated,
    riskLevel: UPDATE_DOCUMENT_RECORD_ACTION.riskLevel,
    confirmationRequired: UPDATE_DOCUMENT_RECORD_ACTION.confirmationRequired,
    result: "success",
  });
  return ok(200, updated);
}
