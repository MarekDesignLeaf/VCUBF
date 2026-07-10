import { z } from "zod";
import { prisma } from "../db.js";
import { recordAudit } from "../lib/audit.js";
import {
  LOG_PORTFOLIO_PHOTO_ACTION,
  UPDATE_PORTFOLIO_PHOTO_ACTION,
  PORTFOLIO_PHOTO_SOURCES,
} from "../lib/actionContracts.js";
import type { AuthedUser } from "../middleware/auth.js";
import { fail, ok, type ServiceResult } from "./result.js";

// Portfolio and Photo Intelligence Module — the manual-entry foundation of a
// future automated photo-selection/website-publishing workflow. Every field
// is exactly what the user typed in: `filename` is a literal filename/
// reference, `source` is a user-selected value, never guessed. There is no
// image upload/storage or AI-selection/website-publishing connector yet —
// this table and its optional CRM linkage (client, job) are designed so a
// future automated workflow can write into the same structure instead of
// creating a second, disconnected record type.

export const createPortfolioPhotoSchema = z.object({
  client_id: z.string().uuid().optional(),
  job_id: z.string().uuid().optional(),
  filename: z.string().min(1, "filename is required"),
  caption: z.string().optional(),
  tags: z.array(z.string()).default([]),
  taken_at: z.string().datetime().optional(),
  source: z.enum(PORTFOLIO_PHOTO_SOURCES),
  usable_for_marketing: z.boolean().default(false),
  usable_for_marketing_notes: z.string().optional(),
});

export const updatePortfolioPhotoSchema = z.object({
  filename: z.string().min(1).optional(),
  caption: z.string().optional(),
  tags: z.array(z.string()).optional(),
  taken_at: z.string().datetime().nullable().optional(),
  source: z.enum(PORTFOLIO_PHOTO_SOURCES).optional(),
  usable_for_marketing: z.boolean().optional(),
  usable_for_marketing_notes: z.string().optional(),
});

const portfolioPhotoInclude = {
  client: { select: { id: true, displayName: true } },
  job: { select: { id: true, jobTitle: true } },
};

export async function listPortfolioPhotos(
  user: AuthedUser,
  filters: { clientId?: string; jobId?: string; tag?: string; usableForMarketing?: boolean; source?: string } = {}
) {
  return prisma.portfolioPhoto.findMany({
    where: {
      companyId: user.companyId,
      ...(filters.clientId ? { clientId: filters.clientId } : {}),
      ...(filters.jobId ? { jobId: filters.jobId } : {}),
      ...(filters.tag ? { tags: { has: filters.tag } } : {}),
      ...(filters.usableForMarketing !== undefined ? { usableForMarketing: filters.usableForMarketing } : {}),
      ...(filters.source ? { source: filters.source } : {}),
    },
    include: portfolioPhotoInclude,
    orderBy: { createdAt: "desc" },
  });
}

export async function getPortfolioPhoto(user: AuthedUser, id: string) {
  return prisma.portfolioPhoto.findFirst({
    where: { id, companyId: user.companyId },
    include: portfolioPhotoInclude,
  });
}

// log_portfolio_photo — Action Contract driven.
export async function createPortfolioPhoto(user: AuthedUser, rawInput: unknown): Promise<ServiceResult<unknown>> {
  const parsed = createPortfolioPhotoSchema.safeParse(rawInput);
  if (!parsed.success) {
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: LOG_PORTFOLIO_PHOTO_ACTION.actionName,
      inputPayload: rawInput,
      riskLevel: LOG_PORTFOLIO_PHOTO_ACTION.riskLevel,
      confirmationRequired: LOG_PORTFOLIO_PHOTO_ACTION.confirmationRequired,
      result: "error",
      errorMessage: "VALIDATION_FAILED",
    });
    return fail(400, "VALIDATION_FAILED", parsed.error.message);
  }
  const data = parsed.data;

  if (data.client_id) {
    const client = await prisma.client.findFirst({ where: { id: data.client_id, companyId: user.companyId } });
    if (!client) {
      await recordAudit({
        companyId: user.companyId,
        userId: user.id,
        actionName: LOG_PORTFOLIO_PHOTO_ACTION.actionName,
        inputPayload: data,
        riskLevel: LOG_PORTFOLIO_PHOTO_ACTION.riskLevel,
        confirmationRequired: LOG_PORTFOLIO_PHOTO_ACTION.confirmationRequired,
        result: "error",
        errorMessage: "CLIENT_NOT_FOUND",
      });
      return fail(404, "CLIENT_NOT_FOUND");
    }
  }

  if (data.job_id) {
    const job = await prisma.job.findFirst({ where: { id: data.job_id, companyId: user.companyId } });
    if (!job) {
      await recordAudit({
        companyId: user.companyId,
        userId: user.id,
        actionName: LOG_PORTFOLIO_PHOTO_ACTION.actionName,
        inputPayload: data,
        riskLevel: LOG_PORTFOLIO_PHOTO_ACTION.riskLevel,
        confirmationRequired: LOG_PORTFOLIO_PHOTO_ACTION.confirmationRequired,
        result: "error",
        errorMessage: "JOB_NOT_FOUND",
      });
      return fail(404, "JOB_NOT_FOUND");
    }
  }

  const created = await prisma.portfolioPhoto.create({
    data: {
      companyId: user.companyId,
      clientId: data.client_id,
      jobId: data.job_id,
      filename: data.filename,
      caption: data.caption,
      tags: data.tags,
      takenAt: data.taken_at ? new Date(data.taken_at) : undefined,
      source: data.source,
      usableForMarketing: data.usable_for_marketing,
      usableForMarketingNotes: data.usable_for_marketing_notes,
      createdBy: user.id,
    },
    include: portfolioPhotoInclude,
  });

  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: LOG_PORTFOLIO_PHOTO_ACTION.actionName,
    inputPayload: data,
    dataAfter: created,
    riskLevel: LOG_PORTFOLIO_PHOTO_ACTION.riskLevel,
    confirmationRequired: LOG_PORTFOLIO_PHOTO_ACTION.confirmationRequired,
    result: "success",
  });

  return ok(201, created);
}

// update_portfolio_photo — Action Contract driven.
export async function updatePortfolioPhoto(
  user: AuthedUser,
  id: string,
  rawInput: unknown
): Promise<ServiceResult<unknown>> {
  const parsed = updatePortfolioPhotoSchema.safeParse(rawInput);
  if (!parsed.success) {
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: UPDATE_PORTFOLIO_PHOTO_ACTION.actionName,
      inputPayload: { id, ...(typeof rawInput === "object" && rawInput ? rawInput : {}) },
      riskLevel: UPDATE_PORTFOLIO_PHOTO_ACTION.riskLevel,
      confirmationRequired: UPDATE_PORTFOLIO_PHOTO_ACTION.confirmationRequired,
      result: "error",
      errorMessage: "VALIDATION_FAILED",
    });
    return fail(400, "VALIDATION_FAILED", parsed.error.message);
  }
  const data = parsed.data;

  const existing = await prisma.portfolioPhoto.findFirst({ where: { id, companyId: user.companyId } });
  if (!existing) {
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: UPDATE_PORTFOLIO_PHOTO_ACTION.actionName,
      inputPayload: { id, ...data },
      riskLevel: UPDATE_PORTFOLIO_PHOTO_ACTION.riskLevel,
      confirmationRequired: UPDATE_PORTFOLIO_PHOTO_ACTION.confirmationRequired,
      result: "error",
      errorMessage: "PORTFOLIO_PHOTO_NOT_FOUND",
    });
    return fail(404, "PORTFOLIO_PHOTO_NOT_FOUND");
  }

  const changes: Record<string, unknown> = {};
  if (data.filename !== undefined) changes.filename = data.filename;
  if (data.caption !== undefined) changes.caption = data.caption;
  if (data.tags !== undefined) changes.tags = data.tags;
  if (data.taken_at !== undefined) changes.takenAt = data.taken_at ? new Date(data.taken_at) : null;
  if (data.source !== undefined) changes.source = data.source;
  if (data.usable_for_marketing !== undefined) changes.usableForMarketing = data.usable_for_marketing;
  if (data.usable_for_marketing_notes !== undefined) changes.usableForMarketingNotes = data.usable_for_marketing_notes;

  const updated = await prisma.portfolioPhoto.update({
    where: { id: existing.id },
    data: changes,
    include: portfolioPhotoInclude,
  });

  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: UPDATE_PORTFOLIO_PHOTO_ACTION.actionName,
    inputPayload: { id, changes },
    dataBefore: existing,
    dataAfter: updated,
    riskLevel: UPDATE_PORTFOLIO_PHOTO_ACTION.riskLevel,
    confirmationRequired: UPDATE_PORTFOLIO_PHOTO_ACTION.confirmationRequired,
    result: "success",
  });

  return ok(200, updated);
}
