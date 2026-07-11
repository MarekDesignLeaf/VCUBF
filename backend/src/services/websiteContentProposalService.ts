import { z } from "zod";
import { prisma } from "../db.js";
import { recordAudit } from "../lib/audit.js";
import {
  DECIDE_WEBSITE_CONTENT_PROPOSAL_ACTION,
  PREPARE_WEBSITE_CONTENT_PROPOSAL_ACTION,
  WEBSITE_CONTENT_PROPOSAL_TYPES,
} from "../lib/actionContracts.js";
import type { AuthedUser } from "../middleware/auth.js";
import { fail, ok, type ServiceResult } from "./result.js";

const httpUrlSchema = z.string().url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "http:" || protocol === "https:";
}, "Only http and https URLs are supported");

const sourceIdArraySchema = z
  .array(z.string().uuid())
  .max(50)
  .default([])
  .refine((ids) => new Set(ids).size === ids.length, "Source IDs must be unique");

export const createWebsiteContentProposalSchema = z
  .object({
    website_audit_id: z.string().uuid().optional(),
    proposal_type: z.enum(WEBSITE_CONTENT_PROPOSAL_TYPES),
    target_page_url: httpUrlSchema,
    headline: z.string().trim().min(1).max(200).optional(),
    content_body: z.string().trim().min(1, "content_body is required").max(20_000),
    notes: z.string().max(2_000).optional(),
    business_context_ids: sourceIdArraySchema,
    service_catalogue_item_ids: sourceIdArraySchema,
    portfolio_photo_ids: sourceIdArraySchema,
    website_audit_finding_ids: sourceIdArraySchema,
  })
  .superRefine((data, ctx) => {
    const sourceCount =
      (data.website_audit_id ? 1 : 0) +
      data.business_context_ids.length +
      data.service_catalogue_item_ids.length +
      data.portfolio_photo_ids.length +
      data.website_audit_finding_ids.length;
    if (sourceCount === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["business_context_ids"],
        message: "At least one verified Secretary source is required",
      });
    }
  });

export const decideWebsiteContentProposalSchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  decision_notes: z.string().max(2_000).optional(),
  confirmed: z.boolean().optional(),
});

async function recordActionError(
  user: AuthedUser,
  action: typeof PREPARE_WEBSITE_CONTENT_PROPOSAL_ACTION | typeof DECIDE_WEBSITE_CONTENT_PROPOSAL_ACTION,
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

const proposalInclude = {
  websiteAudit: {
    select: {
      id: true,
      websiteUrl: true,
      findingCount: true,
      urgentCount: true,
      warningCount: true,
      infoCount: true,
    },
  },
};

export async function listWebsiteContentProposals(user: AuthedUser, status?: string) {
  return prisma.websiteContentProposal.findMany({
    where: { companyId: user.companyId, ...(status ? { status } : {}) },
    include: proposalInclude,
    orderBy: { createdAt: "desc" },
  });
}

export async function getWebsiteContentProposal(user: AuthedUser, id: string) {
  return prisma.websiteContentProposal.findFirst({
    where: { id, companyId: user.companyId },
    include: proposalInclude,
  });
}

export async function createWebsiteContentProposal(
  user: AuthedUser,
  rawInput: unknown
): Promise<ServiceResult<unknown>> {
  const parsed = createWebsiteContentProposalSchema.safeParse(rawInput);
  if (!parsed.success) {
    await recordActionError(
      user,
      PREPARE_WEBSITE_CONTENT_PROPOSAL_ACTION,
      rawInput,
      "VALIDATION_FAILED"
    );
    return fail(400, "VALIDATION_FAILED", parsed.error.message);
  }
  const input = parsed.data;

  const [websiteAudit, businessContext, services, photos, auditFindings] = await Promise.all([
    input.website_audit_id
      ? prisma.websiteAudit.findFirst({
          where: { id: input.website_audit_id, companyId: user.companyId },
          select: {
            id: true,
            websiteUrl: true,
            observationSource: true,
            observations: true,
            findingCount: true,
            urgentCount: true,
            warningCount: true,
            infoCount: true,
          },
        })
      : Promise.resolve(null),
    prisma.businessContextItem.findMany({
      where: {
        id: { in: input.business_context_ids },
        companyId: user.companyId,
        isActive: true,
        verificationStatus: "confirmed",
      },
      select: { id: true, category: true, label: true, value: true, source: true, verificationStatus: true },
    }),
    prisma.serviceCatalogueItem.findMany({
      where: { id: { in: input.service_catalogue_item_ids }, companyId: user.companyId, isActive: true },
      select: { id: true, name: true, description: true, category: true },
    }),
    prisma.portfolioPhoto.findMany({
      where: {
        id: { in: input.portfolio_photo_ids },
        companyId: user.companyId,
        usableForMarketing: true,
        takenAt: { not: null },
        qualityReviewStatus: "approved",
        duplicateReviewStatus: "unique",
        sensitiveDataReviewStatus: "clear",
        usagePermissionStatus: { in: ["confirmed", "not_required"] },
      },
      select: {
        id: true,
        filename: true,
        caption: true,
        tags: true,
        source: true,
        takenAt: true,
        usableForMarketingNotes: true,
        qualityReviewStatus: true,
        duplicateReviewStatus: true,
        sensitiveDataReviewStatus: true,
        usagePermissionStatus: true,
      },
    }),
    prisma.websiteAuditFinding.findMany({
      where: {
        id: { in: input.website_audit_finding_ids },
        companyId: user.companyId,
        ...(input.website_audit_id ? { websiteAuditId: input.website_audit_id } : {}),
      },
      select: {
        id: true,
        websiteAuditId: true,
        category: true,
        severity: true,
        title: true,
        evidence: true,
        recommendation: true,
        pageUrl: true,
        sourceType: true,
        sourceRecordId: true,
      },
    }),
  ]);

  if (input.website_audit_id && !websiteAudit) {
    await recordActionError(
      user,
      PREPARE_WEBSITE_CONTENT_PROPOSAL_ACTION,
      input,
      "WEBSITE_AUDIT_NOT_FOUND"
    );
    return fail(404, "WEBSITE_AUDIT_NOT_FOUND");
  }

  if (websiteAudit && new URL(websiteAudit.websiteUrl).origin !== new URL(input.target_page_url).origin) {
    await recordActionError(
      user,
      PREPARE_WEBSITE_CONTENT_PROPOSAL_ACTION,
      input,
      "TARGET_URL_MISMATCH"
    );
    return fail(400, "TARGET_URL_MISMATCH", "target_page_url must belong to the linked audit website.");
  }

  if (businessContext.length !== input.business_context_ids.length) {
    await recordActionError(
      user,
      PREPARE_WEBSITE_CONTENT_PROPOSAL_ACTION,
      input,
      "SOURCE_NOT_CONFIRMED"
    );
    return fail(
      400,
      "SOURCE_NOT_CONFIRMED",
      "Every business_context_id must be active, confirmed and belong to your company."
    );
  }

  if (
    services.length !== input.service_catalogue_item_ids.length ||
    photos.length !== input.portfolio_photo_ids.length ||
    auditFindings.length !== input.website_audit_finding_ids.length
  ) {
    await recordActionError(
      user,
      PREPARE_WEBSITE_CONTENT_PROPOSAL_ACTION,
      input,
      "SOURCE_NOT_AVAILABLE"
    );
    return fail(
      400,
      "SOURCE_NOT_AVAILABLE",
      "Every selected service, photo and audit finding must be eligible and belong to your company."
    );
  }

  const sourceSnapshot = {
    websiteAudit,
    businessContext,
    services,
    photos,
    auditFindings,
  };

  const created = await prisma.websiteContentProposal.create({
    data: {
      companyId: user.companyId,
      websiteAuditId: input.website_audit_id,
      proposalType: input.proposal_type,
      targetPageUrl: input.target_page_url,
      headline: input.headline,
      contentBody: input.content_body,
      sourceSnapshot,
      notes: input.notes,
      createdBy: user.id,
    },
    include: proposalInclude,
  });

  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: PREPARE_WEBSITE_CONTENT_PROPOSAL_ACTION.actionName,
    inputPayload: input,
    dataAfter: created,
    riskLevel: PREPARE_WEBSITE_CONTENT_PROPOSAL_ACTION.riskLevel,
    confirmationRequired: PREPARE_WEBSITE_CONTENT_PROPOSAL_ACTION.confirmationRequired,
    result: "success",
  });

  return ok(201, created);
}

export async function decideWebsiteContentProposal(
  user: AuthedUser,
  id: string,
  rawInput: unknown
): Promise<ServiceResult<unknown>> {
  const parsed = decideWebsiteContentProposalSchema.safeParse(rawInput);
  if (!parsed.success) {
    await recordActionError(
      user,
      DECIDE_WEBSITE_CONTENT_PROPOSAL_ACTION,
      { id, input: rawInput },
      "VALIDATION_FAILED"
    );
    return fail(400, "VALIDATION_FAILED", parsed.error.message);
  }
  const input = parsed.data;

  const existing = await prisma.websiteContentProposal.findFirst({
    where: { id, companyId: user.companyId },
  });
  if (!existing) {
    await recordActionError(
      user,
      DECIDE_WEBSITE_CONTENT_PROPOSAL_ACTION,
      { id, ...input },
      "WEBSITE_CONTENT_PROPOSAL_NOT_FOUND"
    );
    return fail(404, "WEBSITE_CONTENT_PROPOSAL_NOT_FOUND");
  }
  if (existing.status !== "ready_for_review") {
    await recordActionError(
      user,
      DECIDE_WEBSITE_CONTENT_PROPOSAL_ACTION,
      { id, ...input },
      "WEBSITE_CONTENT_PROPOSAL_ALREADY_DECIDED",
      existing
    );
    return fail(409, "WEBSITE_CONTENT_PROPOSAL_ALREADY_DECIDED");
  }

  const snapshot = existing.sourceSnapshot as {
    businessContext?: unknown[];
    services?: unknown[];
    photos?: unknown[];
    auditFindings?: unknown[];
    websiteAudit?: unknown;
  };
  const preview = {
    proposalId: existing.id,
    proposalType: existing.proposalType,
    targetPageUrl: existing.targetPageUrl,
    headline: existing.headline,
    currentStatus: existing.status,
    proposedStatus: input.decision,
    contentBody: existing.contentBody,
    sourceCounts: {
      websiteAudit: snapshot.websiteAudit ? 1 : 0,
      businessContext: snapshot.businessContext?.length ?? 0,
      services: snapshot.services?.length ?? 0,
      photos: snapshot.photos?.length ?? 0,
      auditFindings: snapshot.auditFindings?.length ?? 0,
    },
  };

  if (!input.confirmed) {
    await recordActionError(
      user,
      DECIDE_WEBSITE_CONTENT_PROPOSAL_ACTION,
      { id, ...input },
      "CONFIRMATION_REQUIRED",
      preview
    );
    return fail(
      409,
      "CONFIRMATION_REQUIRED",
      "Review the preview and resubmit with confirmed: true.",
      { preview }
    );
  }

  const updatedCount = await prisma.websiteContentProposal.updateMany({
    where: { id: existing.id, companyId: user.companyId, status: "ready_for_review" },
    data: {
      status: input.decision,
      decisionNotes: input.decision_notes,
      reviewedBy: user.id,
      reviewedAt: new Date(),
    },
  });
  if (updatedCount.count !== 1) {
    await recordActionError(
      user,
      DECIDE_WEBSITE_CONTENT_PROPOSAL_ACTION,
      { id, ...input },
      "WEBSITE_CONTENT_PROPOSAL_ALREADY_DECIDED",
      existing
    );
    return fail(409, "WEBSITE_CONTENT_PROPOSAL_ALREADY_DECIDED");
  }

  const updated = await prisma.websiteContentProposal.findFirstOrThrow({
    where: { id: existing.id, companyId: user.companyId },
    include: proposalInclude,
  });

  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: DECIDE_WEBSITE_CONTENT_PROPOSAL_ACTION.actionName,
    inputPayload: { id, ...input },
    dataBefore: existing,
    dataAfter: updated,
    riskLevel: DECIDE_WEBSITE_CONTENT_PROPOSAL_ACTION.riskLevel,
    confirmationRequired: DECIDE_WEBSITE_CONTENT_PROPOSAL_ACTION.confirmationRequired,
    confirmed: true,
    result: "success",
  });

  return ok(200, updated);
}
