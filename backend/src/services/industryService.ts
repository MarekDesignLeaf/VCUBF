import { z } from "zod";
import { prisma } from "../db.js";
import {
  CREATE_INDUSTRY_ACTION,
  INDUSTRY_SOURCES,
  INDUSTRY_VERIFICATION_STATUSES,
  LINK_INDUSTRY_SERVICE_ACTION,
  UPDATE_INDUSTRY_ACTION,
  UPDATE_INDUSTRY_SERVICE_LINK_ACTION,
} from "../lib/actionContracts.js";
import { recordAudit } from "../lib/audit.js";
import type { AuthedUser } from "../middleware/auth.js";
import { fail, ok, type ServiceResult } from "./result.js";

export const createIndustrySchema = z.object({
  name: z.string().trim().min(1, "name is required").max(200),
  description: z.string().max(5_000).optional(),
  source: z.enum(INDUSTRY_SOURCES).default("user_input"),
  verification_status: z.enum(INDUSTRY_VERIFICATION_STATUSES).default("user_entered"),
  notes: z.string().max(5_000).optional(),
});

export const updateIndustrySchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().max(5_000).nullable().optional(),
    source: z.enum(INDUSTRY_SOURCES).optional(),
    verification_status: z.enum(INDUSTRY_VERIFICATION_STATUSES).optional(),
    notes: z.string().max(5_000).nullable().optional(),
    is_active: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, "At least one field is required");

export const linkIndustryServiceSchema = z.object({
  service_catalogue_item_id: z.string().uuid(),
  notes: z.string().max(2_000).optional(),
});

export const updateIndustryServiceLinkSchema = z
  .object({ notes: z.string().max(2_000).nullable().optional(), is_active: z.boolean().optional() })
  .refine((data) => Object.keys(data).length > 0, "At least one field is required");

const industryInclude = {
  serviceLinks: {
    include: { serviceCatalogueItem: true },
    orderBy: { createdAt: "asc" as const },
  },
};

type IndustryAction =
  | typeof CREATE_INDUSTRY_ACTION
  | typeof UPDATE_INDUSTRY_ACTION
  | typeof LINK_INDUSTRY_SERVICE_ACTION
  | typeof UPDATE_INDUSTRY_SERVICE_LINK_ACTION;

async function auditError(user: AuthedUser, action: IndustryAction, inputPayload: unknown, errorMessage: string, dataBefore?: unknown) {
  await recordAudit({
    companyId: user.companyId, userId: user.id, actionName: action.actionName,
    inputPayload, dataBefore, riskLevel: action.riskLevel,
    confirmationRequired: action.confirmationRequired, result: "error", errorMessage,
  });
}

async function duplicateIndustry(user: AuthedUser, name: string, excludeId?: string) {
  return prisma.industry.findFirst({
    where: { companyId: user.companyId, name: { equals: name, mode: "insensitive" }, ...(excludeId ? { id: { not: excludeId } } : {}) },
  });
}

export async function listIndustries(user: AuthedUser, activeOnly = false) {
  return prisma.industry.findMany({
    where: { companyId: user.companyId, ...(activeOnly ? { isActive: true } : {}) },
    include: industryInclude,
    orderBy: { name: "asc" },
  });
}

export async function getIndustry(user: AuthedUser, id: string) {
  return prisma.industry.findFirst({ where: { id, companyId: user.companyId }, include: industryInclude });
}

export async function createIndustry(user: AuthedUser, rawInput: unknown): Promise<ServiceResult<unknown>> {
  const parsed = createIndustrySchema.safeParse(rawInput);
  if (!parsed.success) {
    await auditError(user, CREATE_INDUSTRY_ACTION, rawInput, "VALIDATION_FAILED");
    return fail(400, "VALIDATION_FAILED", parsed.error.message);
  }
  const input = parsed.data;
  if (await duplicateIndustry(user, input.name)) {
    await auditError(user, CREATE_INDUSTRY_ACTION, input, "INDUSTRY_ALREADY_EXISTS");
    return fail(409, "INDUSTRY_ALREADY_EXISTS");
  }
  const created = await prisma.industry.create({
    data: {
      companyId: user.companyId, name: input.name, description: input.description, source: input.source,
      verificationStatus: input.verification_status, notes: input.notes, createdBy: user.id,
    },
    include: industryInclude,
  });
  await recordAudit({
    companyId: user.companyId, userId: user.id, actionName: CREATE_INDUSTRY_ACTION.actionName,
    inputPayload: input, dataAfter: created, riskLevel: CREATE_INDUSTRY_ACTION.riskLevel,
    confirmationRequired: CREATE_INDUSTRY_ACTION.confirmationRequired, result: "success",
  });
  return ok(201, created);
}

export async function updateIndustry(user: AuthedUser, id: string, rawInput: unknown): Promise<ServiceResult<unknown>> {
  const parsed = updateIndustrySchema.safeParse(rawInput);
  if (!parsed.success) {
    await auditError(user, UPDATE_INDUSTRY_ACTION, { id, input: rawInput }, "VALIDATION_FAILED");
    return fail(400, "VALIDATION_FAILED", parsed.error.message);
  }
  const input = parsed.data;
  const existing = await prisma.industry.findFirst({ where: { id, companyId: user.companyId } });
  if (!existing) {
    await auditError(user, UPDATE_INDUSTRY_ACTION, { id, ...input }, "INDUSTRY_NOT_FOUND");
    return fail(404, "INDUSTRY_NOT_FOUND");
  }
  if (input.name && await duplicateIndustry(user, input.name, existing.id)) {
    await auditError(user, UPDATE_INDUSTRY_ACTION, { id, ...input }, "INDUSTRY_ALREADY_EXISTS", existing);
    return fail(409, "INDUSTRY_ALREADY_EXISTS");
  }
  const changes: Record<string, unknown> = {};
  const mapping: Record<string, string> = {
    name: "name", description: "description", source: "source", verification_status: "verificationStatus",
    notes: "notes", is_active: "isActive",
  };
  for (const [inputKey, dbKey] of Object.entries(mapping)) {
    if (Object.prototype.hasOwnProperty.call(input, inputKey)) changes[dbKey] = input[inputKey as keyof typeof input];
  }
  const updated = await prisma.industry.update({ where: { id: existing.id }, data: changes, include: industryInclude });
  await recordAudit({
    companyId: user.companyId, userId: user.id, actionName: UPDATE_INDUSTRY_ACTION.actionName,
    inputPayload: { id, changes }, dataBefore: existing, dataAfter: updated,
    riskLevel: UPDATE_INDUSTRY_ACTION.riskLevel, confirmationRequired: UPDATE_INDUSTRY_ACTION.confirmationRequired,
    result: "success",
  });
  return ok(200, updated);
}

export async function linkIndustryService(user: AuthedUser, industryId: string, rawInput: unknown): Promise<ServiceResult<unknown>> {
  const parsed = linkIndustryServiceSchema.safeParse(rawInput);
  if (!parsed.success) {
    await auditError(user, LINK_INDUSTRY_SERVICE_ACTION, { industryId, input: rawInput }, "VALIDATION_FAILED");
    return fail(400, "VALIDATION_FAILED", parsed.error.message);
  }
  const input = parsed.data;
  const [industry, service] = await Promise.all([
    prisma.industry.findFirst({ where: { id: industryId, companyId: user.companyId, isActive: true } }),
    prisma.serviceCatalogueItem.findFirst({ where: { id: input.service_catalogue_item_id, companyId: user.companyId, isActive: true } }),
  ]);
  if (!industry) {
    await auditError(user, LINK_INDUSTRY_SERVICE_ACTION, { industryId, ...input }, "INDUSTRY_NOT_FOUND");
    return fail(404, "INDUSTRY_NOT_FOUND");
  }
  if (!service) {
    await auditError(user, LINK_INDUSTRY_SERVICE_ACTION, { industryId, ...input }, "SERVICE_NOT_FOUND");
    return fail(404, "SERVICE_NOT_FOUND");
  }
  const existing = await prisma.industryServiceLink.findUnique({
    where: { industryId_serviceCatalogueItemId: { industryId, serviceCatalogueItemId: service.id } },
  });
  const linked = existing
    ? await prisma.industryServiceLink.update({ where: { id: existing.id }, data: { isActive: true, notes: input.notes } })
    : await prisma.industryServiceLink.create({
        data: { companyId: user.companyId, industryId, serviceCatalogueItemId: service.id, notes: input.notes, createdBy: user.id },
      });
  await recordAudit({
    companyId: user.companyId, userId: user.id, actionName: LINK_INDUSTRY_SERVICE_ACTION.actionName,
    inputPayload: { industryId, ...input }, dataBefore: existing, dataAfter: linked,
    riskLevel: LINK_INDUSTRY_SERVICE_ACTION.riskLevel,
    confirmationRequired: LINK_INDUSTRY_SERVICE_ACTION.confirmationRequired, result: "success",
  });
  return ok(existing ? 200 : 201, linked);
}

export async function updateIndustryServiceLink(user: AuthedUser, linkId: string, rawInput: unknown): Promise<ServiceResult<unknown>> {
  const parsed = updateIndustryServiceLinkSchema.safeParse(rawInput);
  if (!parsed.success) {
    await auditError(user, UPDATE_INDUSTRY_SERVICE_LINK_ACTION, { linkId, input: rawInput }, "VALIDATION_FAILED");
    return fail(400, "VALIDATION_FAILED", parsed.error.message);
  }
  const existing = await prisma.industryServiceLink.findFirst({ where: { id: linkId, companyId: user.companyId } });
  if (!existing) {
    await auditError(user, UPDATE_INDUSTRY_SERVICE_LINK_ACTION, { linkId, ...parsed.data }, "INDUSTRY_SERVICE_LINK_NOT_FOUND");
    return fail(404, "INDUSTRY_SERVICE_LINK_NOT_FOUND");
  }
  const changes: { notes?: string | null; isActive?: boolean } = {};
  if (parsed.data.notes !== undefined) changes.notes = parsed.data.notes;
  if (parsed.data.is_active !== undefined) changes.isActive = parsed.data.is_active;
  const updated = await prisma.industryServiceLink.update({ where: { id: existing.id }, data: changes });
  await recordAudit({
    companyId: user.companyId, userId: user.id, actionName: UPDATE_INDUSTRY_SERVICE_LINK_ACTION.actionName,
    inputPayload: { linkId, ...parsed.data }, dataBefore: existing, dataAfter: updated,
    riskLevel: UPDATE_INDUSTRY_SERVICE_LINK_ACTION.riskLevel,
    confirmationRequired: UPDATE_INDUSTRY_SERVICE_LINK_ACTION.confirmationRequired, result: "success",
  });
  return ok(200, updated);
}
