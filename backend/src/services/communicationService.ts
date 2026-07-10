import { z } from "zod";
import { prisma } from "../db.js";
import { recordAudit } from "../lib/audit.js";
import {
  CREATE_COMMUNICATION_RECORD_ACTION,
  UPDATE_COMMUNICATION_RECORD_ACTION,
  COMMUNICATION_CHANNELS,
  COMMUNICATION_DIRECTIONS,
} from "../lib/actionContracts.js";
import type { AuthedUser } from "../middleware/auth.js";
import { fail, ok, type ServiceResult } from "./result.js";

// Communication Log Module — the manual-entry foundation of the
// Communication Intelligence Module. Every field is exactly what the user
// typed in: who was contacted, what was discussed or promised, and when it
// happened (not necessarily "now" — a call from yesterday can be logged
// today). There is no email/WhatsApp/SMS connector yet, so nothing here is
// auto-extracted; this table and its CRM linkage (client, optional job) are
// designed so a future automated extraction workflow can write into the
// same structure instead of creating a second, disconnected record type.

export const createCommunicationRecordSchema = z.object({
  client_id: z.string().uuid(),
  job_id: z.string().uuid().optional(),
  channel: z.enum(COMMUNICATION_CHANNELS),
  direction: z.enum(COMMUNICATION_DIRECTIONS),
  summary: z.string().min(1, "summary is required"),
  full_text: z.string().optional(),
  occurred_at: z.string().datetime(),
  follow_up_needed: z.boolean().default(false),
  follow_up_due_at: z.string().datetime().optional(),
});

export const updateCommunicationRecordSchema = z.object({
  channel: z.enum(COMMUNICATION_CHANNELS).optional(),
  direction: z.enum(COMMUNICATION_DIRECTIONS).optional(),
  summary: z.string().min(1).optional(),
  full_text: z.string().optional(),
  occurred_at: z.string().datetime().optional(),
  follow_up_needed: z.boolean().optional(),
  follow_up_due_at: z.string().datetime().nullable().optional(),
});

const communicationRecordInclude = {
  client: { select: { id: true, displayName: true } },
  job: { select: { id: true, jobTitle: true } },
};

export async function listCommunicationRecords(
  user: AuthedUser,
  filters: { clientId?: string; jobId?: string; channel?: string; followUpNeeded?: boolean } = {}
) {
  return prisma.communicationRecord.findMany({
    where: {
      companyId: user.companyId,
      ...(filters.clientId ? { clientId: filters.clientId } : {}),
      ...(filters.jobId ? { jobId: filters.jobId } : {}),
      ...(filters.channel ? { channel: filters.channel } : {}),
      ...(filters.followUpNeeded !== undefined ? { followUpNeeded: filters.followUpNeeded } : {}),
    },
    include: communicationRecordInclude,
    orderBy: { occurredAt: "desc" },
  });
}

export async function getCommunicationRecord(user: AuthedUser, id: string) {
  return prisma.communicationRecord.findFirst({
    where: { id, companyId: user.companyId },
    include: communicationRecordInclude,
  });
}

// Follow-ups due: company-scoped records where follow_up_needed is true and
// either there is no due date yet (so it never silently falls off a list
// just because a date wasn't entered) or the due date has already arrived.
export async function listFollowUpsDue(user: AuthedUser) {
  const now = new Date();
  return prisma.communicationRecord.findMany({
    where: {
      companyId: user.companyId,
      followUpNeeded: true,
      OR: [{ followUpDueAt: null }, { followUpDueAt: { lte: now } }],
    },
    include: communicationRecordInclude,
    orderBy: [{ followUpDueAt: "asc" }, { occurredAt: "desc" }],
  });
}

// log_communication — Action Contract driven.
export async function createCommunicationRecord(user: AuthedUser, rawInput: unknown): Promise<ServiceResult<unknown>> {
  const parsed = createCommunicationRecordSchema.safeParse(rawInput);
  if (!parsed.success) {
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: CREATE_COMMUNICATION_RECORD_ACTION.actionName,
      inputPayload: rawInput,
      riskLevel: CREATE_COMMUNICATION_RECORD_ACTION.riskLevel,
      confirmationRequired: CREATE_COMMUNICATION_RECORD_ACTION.confirmationRequired,
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
      actionName: CREATE_COMMUNICATION_RECORD_ACTION.actionName,
      inputPayload: data,
      riskLevel: CREATE_COMMUNICATION_RECORD_ACTION.riskLevel,
      confirmationRequired: CREATE_COMMUNICATION_RECORD_ACTION.confirmationRequired,
      result: "error",
      errorMessage: "CLIENT_NOT_FOUND",
    });
    return fail(404, "CLIENT_NOT_FOUND");
  }

  if (data.job_id) {
    const job = await prisma.job.findFirst({ where: { id: data.job_id, companyId: user.companyId } });
    if (!job) {
      await recordAudit({
        companyId: user.companyId,
        userId: user.id,
        actionName: CREATE_COMMUNICATION_RECORD_ACTION.actionName,
        inputPayload: data,
        riskLevel: CREATE_COMMUNICATION_RECORD_ACTION.riskLevel,
        confirmationRequired: CREATE_COMMUNICATION_RECORD_ACTION.confirmationRequired,
        result: "error",
        errorMessage: "JOB_NOT_FOUND",
      });
      return fail(404, "JOB_NOT_FOUND");
    }
  }

  const created = await prisma.communicationRecord.create({
    data: {
      companyId: user.companyId,
      clientId: data.client_id,
      jobId: data.job_id,
      channel: data.channel,
      direction: data.direction,
      summary: data.summary,
      fullText: data.full_text,
      occurredAt: new Date(data.occurred_at),
      followUpNeeded: data.follow_up_needed,
      followUpDueAt: data.follow_up_due_at ? new Date(data.follow_up_due_at) : undefined,
      createdBy: user.id,
    },
    include: communicationRecordInclude,
  });

  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: CREATE_COMMUNICATION_RECORD_ACTION.actionName,
    inputPayload: data,
    dataAfter: created,
    riskLevel: CREATE_COMMUNICATION_RECORD_ACTION.riskLevel,
    confirmationRequired: CREATE_COMMUNICATION_RECORD_ACTION.confirmationRequired,
    result: "success",
  });

  return ok(201, created);
}

// update_communication_record — Action Contract driven.
export async function updateCommunicationRecord(
  user: AuthedUser,
  id: string,
  rawInput: unknown
): Promise<ServiceResult<unknown>> {
  const parsed = updateCommunicationRecordSchema.safeParse(rawInput);
  if (!parsed.success) {
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: UPDATE_COMMUNICATION_RECORD_ACTION.actionName,
      inputPayload: { id, ...(typeof rawInput === "object" && rawInput ? rawInput : {}) },
      riskLevel: UPDATE_COMMUNICATION_RECORD_ACTION.riskLevel,
      confirmationRequired: UPDATE_COMMUNICATION_RECORD_ACTION.confirmationRequired,
      result: "error",
      errorMessage: "VALIDATION_FAILED",
    });
    return fail(400, "VALIDATION_FAILED", parsed.error.message);
  }
  const data = parsed.data;

  const existing = await prisma.communicationRecord.findFirst({ where: { id, companyId: user.companyId } });
  if (!existing) {
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: UPDATE_COMMUNICATION_RECORD_ACTION.actionName,
      inputPayload: { id, ...data },
      riskLevel: UPDATE_COMMUNICATION_RECORD_ACTION.riskLevel,
      confirmationRequired: UPDATE_COMMUNICATION_RECORD_ACTION.confirmationRequired,
      result: "error",
      errorMessage: "COMMUNICATION_RECORD_NOT_FOUND",
    });
    return fail(404, "COMMUNICATION_RECORD_NOT_FOUND");
  }

  const changes: Record<string, unknown> = {};
  if (data.channel !== undefined) changes.channel = data.channel;
  if (data.direction !== undefined) changes.direction = data.direction;
  if (data.summary !== undefined) changes.summary = data.summary;
  if (data.full_text !== undefined) changes.fullText = data.full_text;
  if (data.occurred_at !== undefined) changes.occurredAt = new Date(data.occurred_at);
  if (data.follow_up_needed !== undefined) changes.followUpNeeded = data.follow_up_needed;
  if (data.follow_up_due_at !== undefined) {
    changes.followUpDueAt = data.follow_up_due_at ? new Date(data.follow_up_due_at) : null;
  }

  const updated = await prisma.communicationRecord.update({
    where: { id: existing.id },
    data: changes,
    include: communicationRecordInclude,
  });

  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: UPDATE_COMMUNICATION_RECORD_ACTION.actionName,
    inputPayload: { id, changes },
    dataBefore: existing,
    dataAfter: updated,
    riskLevel: UPDATE_COMMUNICATION_RECORD_ACTION.riskLevel,
    confirmationRequired: UPDATE_COMMUNICATION_RECORD_ACTION.confirmationRequired,
    result: "success",
  });

  return ok(200, updated);
}
