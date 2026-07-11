import { z } from "zod";
import { prisma } from "../db.js";
import { recordAudit } from "../lib/audit.js";
import {
  LOG_PORTFOLIO_PHOTO_ACTION,
  PHOTO_DUPLICATE_REVIEW_STATUSES,
  PHOTO_QUALITY_REVIEW_STATUSES,
  PHOTO_SENSITIVE_DATA_REVIEW_STATUSES,
  PHOTO_USAGE_PERMISSION_STATUSES,
  UPDATE_PORTFOLIO_PHOTO_ACTION,
  PORTFOLIO_PHOTO_SOURCES,
  SELECT_PHOTOS_FOR_SERVICE_ACTION,
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
  quality_review_status: z.enum(PHOTO_QUALITY_REVIEW_STATUSES).default("unreviewed"),
  duplicate_review_status: z.enum(PHOTO_DUPLICATE_REVIEW_STATUSES).default("unreviewed"),
  sensitive_data_review_status: z.enum(PHOTO_SENSITIVE_DATA_REVIEW_STATUSES).default("unreviewed"),
  usage_permission_status: z.enum(PHOTO_USAGE_PERMISSION_STATUSES).default("unknown"),
});

export const updatePortfolioPhotoSchema = z.object({
  filename: z.string().min(1).optional(),
  caption: z.string().optional(),
  tags: z.array(z.string()).optional(),
  taken_at: z.string().datetime().nullable().optional(),
  source: z.enum(PORTFOLIO_PHOTO_SOURCES).optional(),
  usable_for_marketing: z.boolean().optional(),
  usable_for_marketing_notes: z.string().optional(),
  quality_review_status: z.enum(PHOTO_QUALITY_REVIEW_STATUSES).optional(),
  duplicate_review_status: z.enum(PHOTO_DUPLICATE_REVIEW_STATUSES).optional(),
  sensitive_data_review_status: z.enum(PHOTO_SENSITIVE_DATA_REVIEW_STATUSES).optional(),
  usage_permission_status: z.enum(PHOTO_USAGE_PERMISSION_STATUSES).optional(),
});

export const photoServiceSelectionSchema = z.object({
  service_catalogue_item_id: z.string().uuid(),
  photo_ids: z.array(z.string().uuid()).max(100).refine((ids) => new Set(ids).size === ids.length, {
    message: "photo_ids must not contain duplicates",
  }),
  own_production_only: z.boolean().default(true),
  review_notes: z.string().max(2000).optional(),
  confirmed: z.boolean().optional(),
});

const portfolioPhotoInclude = {
  client: { select: { id: true, displayName: true } },
  job: { select: { id: true, jobTitle: true, serviceCatalogueItemId: true } },
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
      qualityReviewStatus: data.quality_review_status,
      duplicateReviewStatus: data.duplicate_review_status,
      sensitiveDataReviewStatus: data.sensitive_data_review_status,
      usagePermissionStatus: data.usage_permission_status,
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
  if (data.quality_review_status !== undefined) changes.qualityReviewStatus = data.quality_review_status;
  if (data.duplicate_review_status !== undefined) changes.duplicateReviewStatus = data.duplicate_review_status;
  if (data.sensitive_data_review_status !== undefined) changes.sensitiveDataReviewStatus = data.sensitive_data_review_status;
  if (data.usage_permission_status !== undefined) changes.usagePermissionStatus = data.usage_permission_status;

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

type CandidatePhoto = Awaited<ReturnType<typeof listPortfolioPhotos>>[number];

function normalise(value: string) {
  return value.trim().toLowerCase();
}

function reviewCandidate(
  photo: CandidatePhoto,
  service: { id: string; name: string; category: string | null },
  ownProductionOnly: boolean
) {
  const tags = new Set(photo.tags.map(normalise));
  const reasons: string[] = [];
  if (photo.job?.serviceCatalogueItemId === service.id) reasons.push("linked_job_service");
  if (tags.has(normalise(service.name))) reasons.push("exact_service_name_tag");

  const blockers: string[] = [];
  if (reasons.length === 0) blockers.push("SERVICE_RELEVANCE_NOT_FOUND");
  if (!photo.usableForMarketing) blockers.push("MARKETING_USE_NOT_APPROVED");
  if (!photo.takenAt) blockers.push("TAKEN_DATE_MISSING");
  if (photo.qualityReviewStatus !== "approved") blockers.push("QUALITY_NOT_APPROVED");
  if (photo.duplicateReviewStatus !== "unique") blockers.push("DUPLICATE_NOT_CLEARED");
  if (photo.sensitiveDataReviewStatus !== "clear") blockers.push("SENSITIVE_DATA_NOT_CLEARED");
  if (!(["confirmed", "not_required"] as string[]).includes(photo.usagePermissionStatus)) {
    blockers.push("USAGE_PERMISSION_NOT_CONFIRMED");
  }
  if (ownProductionOnly && !(["employee_upload", "before_after"] as string[]).includes(photo.source)) {
    blockers.push("OWN_PRODUCTION_SOURCE_REQUIRED");
  }

  return { photo, reasons, blockers };
}

async function loadSelectionWorkspace(user: AuthedUser, serviceId: string, ownProductionOnly: boolean) {
  const [service, photos, selections] = await Promise.all([
    prisma.serviceCatalogueItem.findFirst({
      where: { id: serviceId, companyId: user.companyId },
      select: { id: true, name: true, category: true, isActive: true },
    }),
    prisma.portfolioPhoto.findMany({
      where: { companyId: user.companyId },
      include: portfolioPhotoInclude,
      orderBy: { createdAt: "desc" },
    }),
    prisma.photoServiceSelection.findMany({
      where: { companyId: user.companyId, serviceCatalogueItemId: serviceId, isSelected: true },
      select: { portfolioPhotoId: true },
    }),
  ]);
  if (!service) return null;

  const selectedPhotoIds = selections.map((selection) => selection.portfolioPhotoId);
  const selectedSet = new Set(selectedPhotoIds);
  const candidates = photos
    .map((photo) => reviewCandidate(photo, service, ownProductionOnly))
    .filter((candidate) => candidate.reasons.length > 0 || selectedSet.has(candidate.photo.id))
    .map((candidate) => ({
      ...candidate,
      isSelected: selectedSet.has(candidate.photo.id),
      eligible: candidate.blockers.length === 0,
    }))
    .sort((a, b) => Number(b.isSelected) - Number(a.isSelected) || a.photo.filename.localeCompare(b.photo.filename));

  return {
    service,
    ownProductionOnly,
    selectedPhotoIds,
    candidates,
    limitations: {
      actualImageFilesAvailable: false,
      automatedVisualReviewPerformed: false,
      publishingAvailable: false,
      explanation:
        "Candidates use only explicit job/service links or exact user-entered tags. Quality, duplicate, sensitive-data and usage-rights states are human-entered reviews.",
    },
  };
}

export async function getPhotoSelectionWorkspace(
  user: AuthedUser,
  serviceId: string,
  ownProductionOnly = true
) {
  if (!z.string().uuid().safeParse(serviceId).success) return fail(400, "VALIDATION_FAILED");
  const workspace = await loadSelectionWorkspace(user, serviceId, ownProductionOnly);
  if (!workspace) return fail(404, "SERVICE_NOT_FOUND");
  return ok(200, workspace);
}

export async function selectPhotosForService(
  user: AuthedUser,
  rawInput: unknown
): Promise<ServiceResult<unknown>> {
  const parsed = photoServiceSelectionSchema.safeParse(rawInput);
  if (!parsed.success) {
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: SELECT_PHOTOS_FOR_SERVICE_ACTION.actionName,
      inputPayload: rawInput,
      riskLevel: SELECT_PHOTOS_FOR_SERVICE_ACTION.riskLevel,
      confirmationRequired: SELECT_PHOTOS_FOR_SERVICE_ACTION.confirmationRequired,
      result: "error",
      errorMessage: "VALIDATION_FAILED",
    });
    return fail(400, "VALIDATION_FAILED", parsed.error.message);
  }
  const input = parsed.data;
  const workspace = await loadSelectionWorkspace(user, input.service_catalogue_item_id, input.own_production_only);
  if (!workspace) {
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: SELECT_PHOTOS_FOR_SERVICE_ACTION.actionName,
      inputPayload: input,
      riskLevel: SELECT_PHOTOS_FOR_SERVICE_ACTION.riskLevel,
      confirmationRequired: SELECT_PHOTOS_FOR_SERVICE_ACTION.confirmationRequired,
      result: "error",
      errorMessage: "SERVICE_NOT_FOUND",
    });
    return fail(404, "SERVICE_NOT_FOUND");
  }

  const photos = await prisma.portfolioPhoto.findMany({
    where: { companyId: user.companyId, id: { in: input.photo_ids } },
    include: portfolioPhotoInclude,
  });
  if (photos.length !== input.photo_ids.length) {
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: SELECT_PHOTOS_FOR_SERVICE_ACTION.actionName,
      inputPayload: input,
      riskLevel: SELECT_PHOTOS_FOR_SERVICE_ACTION.riskLevel,
      confirmationRequired: SELECT_PHOTOS_FOR_SERVICE_ACTION.confirmationRequired,
      result: "error",
      errorMessage: "PORTFOLIO_PHOTO_NOT_FOUND",
    });
    return fail(404, "PORTFOLIO_PHOTO_NOT_FOUND");
  }

  const reviewed = photos.map((photo) => reviewCandidate(photo, workspace.service, input.own_production_only));
  const blocked = reviewed
    .filter((candidate) => candidate.blockers.length > 0)
    .map((candidate) => ({
      photoId: candidate.photo.id,
      filename: candidate.photo.filename,
      blockers: candidate.blockers,
    }));
  if (blocked.length > 0) {
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: SELECT_PHOTOS_FOR_SERVICE_ACTION.actionName,
      inputPayload: input,
      dataBefore: { blocked },
      riskLevel: SELECT_PHOTOS_FOR_SERVICE_ACTION.riskLevel,
      confirmationRequired: SELECT_PHOTOS_FOR_SERVICE_ACTION.confirmationRequired,
      result: "rejected",
      errorMessage: "PHOTO_SELECTION_BLOCKED",
    });
    return fail(400, "PHOTO_SELECTION_BLOCKED", "Every selected photo must pass all explicit reviews.", { blocked });
  }

  const currentIds = workspace.selectedPhotoIds;
  const requestedSet = new Set(input.photo_ids);
  const currentSet = new Set(currentIds);
  const preview = {
    service: workspace.service,
    ownProductionOnly: input.own_production_only,
    requestedPhotos: reviewed.map((candidate) => ({
      id: candidate.photo.id,
      filename: candidate.photo.filename,
      evidence: candidate.reasons,
    })),
    addedPhotoIds: input.photo_ids.filter((id) => !currentSet.has(id)),
    removedPhotoIds: currentIds.filter((id) => !requestedSet.has(id)),
    unchangedPhotoIds: input.photo_ids.filter((id) => currentSet.has(id)),
    reviewNotes: input.review_notes ?? null,
    publicationWillOccur: false,
  };

  if (!input.confirmed) {
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: SELECT_PHOTOS_FOR_SERVICE_ACTION.actionName,
      inputPayload: input,
      dataBefore: preview,
      riskLevel: SELECT_PHOTOS_FOR_SERVICE_ACTION.riskLevel,
      confirmationRequired: SELECT_PHOTOS_FOR_SERVICE_ACTION.confirmationRequired,
      result: "error",
      errorMessage: "CONFIRMATION_REQUIRED",
    });
    return fail(409, "CONFIRMATION_REQUIRED", "Review the exact photo set and resubmit with confirmed: true.", {
      preview,
    });
  }

  const selectedAt = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.photoServiceSelection.updateMany({
      where: {
        companyId: user.companyId,
        serviceCatalogueItemId: workspace.service.id,
        ...(input.photo_ids.length > 0 ? { portfolioPhotoId: { notIn: input.photo_ids } } : {}),
      },
      data: { isSelected: false },
    });
    for (const candidate of reviewed) {
      await tx.photoServiceSelection.upsert({
        where: {
          serviceCatalogueItemId_portfolioPhotoId: {
            serviceCatalogueItemId: workspace.service.id,
            portfolioPhotoId: candidate.photo.id,
          },
        },
        create: {
          companyId: user.companyId,
          serviceCatalogueItemId: workspace.service.id,
          portfolioPhotoId: candidate.photo.id,
          isSelected: true,
          ownProductionRequired: input.own_production_only,
          reviewNotes: input.review_notes,
          evidenceSnapshot: {
            reasons: candidate.reasons,
            source: candidate.photo.source,
            takenAt: candidate.photo.takenAt?.toISOString() ?? null,
            qualityReviewStatus: candidate.photo.qualityReviewStatus,
            duplicateReviewStatus: candidate.photo.duplicateReviewStatus,
            sensitiveDataReviewStatus: candidate.photo.sensitiveDataReviewStatus,
            usagePermissionStatus: candidate.photo.usagePermissionStatus,
            usableForMarketing: candidate.photo.usableForMarketing,
          },
          selectedBy: user.id,
          selectedAt,
        },
        update: {
          isSelected: true,
          ownProductionRequired: input.own_production_only,
          reviewNotes: input.review_notes,
          evidenceSnapshot: {
            reasons: candidate.reasons,
            source: candidate.photo.source,
            takenAt: candidate.photo.takenAt?.toISOString() ?? null,
            qualityReviewStatus: candidate.photo.qualityReviewStatus,
            duplicateReviewStatus: candidate.photo.duplicateReviewStatus,
            sensitiveDataReviewStatus: candidate.photo.sensitiveDataReviewStatus,
            usagePermissionStatus: candidate.photo.usagePermissionStatus,
            usableForMarketing: candidate.photo.usableForMarketing,
          },
          selectedBy: user.id,
          selectedAt,
        },
      });
    }
  });

  const result = await loadSelectionWorkspace(user, workspace.service.id, input.own_production_only);
  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: SELECT_PHOTOS_FOR_SERVICE_ACTION.actionName,
    inputPayload: input,
    dataBefore: { selectedPhotoIds: currentIds },
    dataAfter: result,
    riskLevel: SELECT_PHOTOS_FOR_SERVICE_ACTION.riskLevel,
    confirmationRequired: SELECT_PHOTOS_FOR_SERVICE_ACTION.confirmationRequired,
    confirmed: true,
    result: "success",
  });
  return ok(200, result);
}
