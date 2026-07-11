import { z } from "zod";
import { prisma } from "../db.js";
import { recordAudit } from "../lib/audit.js";
import {
  CREATE_WEBSITE_AUDIT_ACTION,
  type WebsiteAuditFindingCategory,
  type WebsiteAuditSeverity,
} from "../lib/actionContracts.js";
import type { AuthedUser } from "../middleware/auth.js";
import { fail, ok, type ServiceResult } from "./result.js";

const httpUrlSchema = z.string().url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "http:" || protocol === "https:";
}, "Only http and https URLs are supported");

const pageObservationSchema = z.object({
  url: httpUrlSchema,
  status_code: z.number().int().min(100).max(599).optional(),
  title: z.string().max(200).optional(),
  has_contact_details: z.boolean().optional(),
  has_contact_form: z.boolean().optional(),
  has_service_content: z.boolean().optional(),
  photo_count: z.number().int().nonnegative().optional(),
  service_names: z.array(z.string().trim().min(1)).max(100).default([]),
  broken_links: z.array(httpUrlSchema).max(100).default([]),
});

export const createWebsiteAuditSchema = z
  .object({
    website_url: httpUrlSchema,
    notes: z.string().max(2000).optional(),
    pages: z.array(pageObservationSchema).min(1).max(50),
  })
  .superRefine((data, ctx) => {
    const websiteOrigin = new URL(data.website_url).origin;
    data.pages.forEach((page, index) => {
      if (new URL(page.url).origin !== websiteOrigin) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["pages", index, "url"],
          message: "Observed pages must belong to the audited website origin",
        });
      }
    });
  });

interface FindingInput {
  category: WebsiteAuditFindingCategory;
  severity: WebsiteAuditSeverity;
  title: string;
  evidence: string;
  recommendation: string;
  pageUrl?: string;
  sourceType: "manual_observation" | "service_catalogue" | "business_context" | "portfolio";
  sourceRecordId?: string;
}

const severityOrder: Record<WebsiteAuditSeverity, number> = {
  urgent: 0,
  warning: 1,
  info: 2,
};

function normaliseName(value: string) {
  return value.trim().toLocaleLowerCase("en-GB").replace(/\s+/g, " ");
}

function buildObservationFindings(
  pages: z.infer<typeof pageObservationSchema>[]
): FindingInput[] {
  const findings: FindingInput[] = [];

  for (const page of pages) {
    if (page.status_code !== undefined && page.status_code >= 400) {
      findings.push({
        category: "technical",
        severity: page.status_code >= 500 ? "urgent" : "warning",
        title: `Page returned HTTP ${page.status_code}`,
        evidence: `The manual observation recorded HTTP status ${page.status_code} for ${page.url}.`,
        recommendation: "Investigate the page response and verify it again after the issue is corrected.",
        pageUrl: page.url,
        sourceType: "manual_observation",
      });
    }

    if (page.title !== undefined && page.title.trim().length === 0) {
      findings.push({
        category: "content",
        severity: "warning",
        title: "Page title is missing",
        evidence: `The manual observation explicitly recorded no page title for ${page.url}.`,
        recommendation: "Prepare a clear title based on verified company and service information for approval.",
        pageUrl: page.url,
        sourceType: "manual_observation",
      });
    }

    if (page.has_contact_details === false) {
      findings.push({
        category: "contact",
        severity: "warning",
        title: "Contact details were not found",
        evidence: `The manual observation marked contact details as missing on ${page.url}.`,
        recommendation: "Add verified company contact details after checking them against confirmed Business Context.",
        pageUrl: page.url,
        sourceType: "manual_observation",
      });
    }

    if (page.has_contact_form === false) {
      findings.push({
        category: "form",
        severity: "warning",
        title: "Contact form was not found",
        evidence: `The manual observation marked the contact form as missing on ${page.url}.`,
        recommendation: "Consider a contact form and define its lead-intake destination before implementation.",
        pageUrl: page.url,
        sourceType: "manual_observation",
      });
    }

    if (page.has_service_content === false) {
      findings.push({
        category: "service_content",
        severity: "warning",
        title: "Service content was not found",
        evidence: `The manual observation marked service content as missing on ${page.url}.`,
        recommendation: "Prepare service content from active Service Catalogue records and submit it for approval.",
        pageUrl: page.url,
        sourceType: "manual_observation",
      });
    }

    if (page.photo_count === 0) {
      findings.push({
        category: "photos",
        severity: "info",
        title: "No photographs were observed on the page",
        evidence: `The manual observation recorded zero photographs on ${page.url}.`,
        recommendation: "Review real company photographs marked usable for marketing before proposing page images.",
        pageUrl: page.url,
        sourceType: "manual_observation",
      });
    }

    if (page.broken_links.length > 0) {
      const uniqueLinks = [...new Set(page.broken_links)];
      findings.push({
        category: "technical",
        severity: "warning",
        title: `${uniqueLinks.length} broken link${uniqueLinks.length === 1 ? "" : "s"} recorded`,
        evidence: `The manual observation for ${page.url} recorded: ${uniqueLinks.join(", ")}.`,
        recommendation: "Repair or remove the recorded links, then verify every affected destination.",
        pageUrl: page.url,
        sourceType: "manual_observation",
      });
    }
  }

  return findings;
}

export async function listWebsiteAudits(user: AuthedUser) {
  return prisma.websiteAudit.findMany({
    where: { companyId: user.companyId },
    include: { _count: { select: { findings: true } } },
    orderBy: { createdAt: "desc" },
  });
}

export async function getWebsiteAudit(user: AuthedUser, id: string) {
  const audit = await prisma.websiteAudit.findFirst({
    where: { id, companyId: user.companyId },
    include: { findings: true },
  });
  if (!audit) return null;

  audit.findings.sort((a, b) => {
    const severityDifference =
      severityOrder[a.severity as WebsiteAuditSeverity] - severityOrder[b.severity as WebsiteAuditSeverity];
    return severityDifference || a.createdAt.getTime() - b.createdAt.getTime();
  });
  return audit;
}

export async function createWebsiteAudit(
  user: AuthedUser,
  rawInput: unknown
): Promise<ServiceResult<unknown>> {
  const parsed = createWebsiteAuditSchema.safeParse(rawInput);
  if (!parsed.success) {
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: CREATE_WEBSITE_AUDIT_ACTION.actionName,
      inputPayload: rawInput,
      riskLevel: CREATE_WEBSITE_AUDIT_ACTION.riskLevel,
      confirmationRequired: CREATE_WEBSITE_AUDIT_ACTION.confirmationRequired,
      result: "error",
      errorMessage: "VALIDATION_FAILED",
    });
    return fail(400, "VALIDATION_FAILED", parsed.error.message);
  }

  const input = parsed.data;
  const [services, confirmedContextCount, marketingPhotoCount] = await Promise.all([
    prisma.serviceCatalogueItem.findMany({
      where: { companyId: user.companyId, isActive: true },
      select: { id: true, name: true },
    }),
    prisma.businessContextItem.count({
      where: { companyId: user.companyId, isActive: true, verificationStatus: "confirmed" },
    }),
    prisma.portfolioPhoto.count({
      where: { companyId: user.companyId, usableForMarketing: true },
    }),
  ]);

  const findings = buildObservationFindings(input.pages);
  const observedServiceNames = new Set(
    input.pages.flatMap((page) => page.service_names).map(normaliseName)
  );

  if (services.length === 0) {
    findings.push({
      category: "data_gap",
      severity: "warning",
      title: "Service Catalogue is empty",
      evidence: "No active Service Catalogue item exists for this company.",
      recommendation: "Record the company's real services before preparing website service content.",
      sourceType: "service_catalogue",
    });
  } else {
    for (const service of services) {
      if (!observedServiceNames.has(normaliseName(service.name))) {
        findings.push({
          category: "missing_service_page",
          severity: "warning",
          title: `Service not observed on website: ${service.name}`,
          evidence: `Active Service Catalogue item ${service.name} (${service.id}) was not listed in any page observation.`,
          recommendation: `Prepare a page or section for ${service.name} from its verified catalogue data and request approval before publication.`,
          sourceType: "service_catalogue",
          sourceRecordId: service.id,
        });
      }
    }
  }

  if (confirmedContextCount === 0) {
    findings.push({
      category: "data_gap",
      severity: "warning",
      title: "No confirmed Business Context is available",
      evidence: "The company has no active Business Context item with verification status confirmed.",
      recommendation: "Confirm company facts and rules before drafting public website claims or contact content.",
      sourceType: "business_context",
    });
  }

  if (marketingPhotoCount === 0) {
    findings.push({
      category: "photos",
      severity: "info",
      title: "No reviewed marketing photographs are available",
      evidence: "No Portfolio Photo record is currently marked usable for marketing.",
      recommendation: "Review real company photographs and record approval evidence before proposing them for website use.",
      sourceType: "portfolio",
    });
  }

  const urgentCount = findings.filter((finding) => finding.severity === "urgent").length;
  const warningCount = findings.filter((finding) => finding.severity === "warning").length;
  const infoCount = findings.filter((finding) => finding.severity === "info").length;

  const created = await prisma.websiteAudit.create({
    data: {
      companyId: user.companyId,
      websiteUrl: input.website_url,
      observations: input.pages,
      notes: input.notes,
      pageCount: input.pages.length,
      findingCount: findings.length,
      urgentCount,
      warningCount,
      infoCount,
      createdBy: user.id,
      findings: {
        create: findings.map((finding) => ({
          companyId: user.companyId,
          category: finding.category,
          severity: finding.severity,
          title: finding.title,
          evidence: finding.evidence,
          recommendation: finding.recommendation,
          pageUrl: finding.pageUrl,
          sourceType: finding.sourceType,
          sourceRecordId: finding.sourceRecordId,
        })),
      },
    },
    include: { findings: true },
  });

  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: CREATE_WEBSITE_AUDIT_ACTION.actionName,
    inputPayload: input,
    dataAfter: created,
    riskLevel: CREATE_WEBSITE_AUDIT_ACTION.riskLevel,
    confirmationRequired: CREATE_WEBSITE_AUDIT_ACTION.confirmationRequired,
    result: "success",
  });

  return ok(201, created);
}
