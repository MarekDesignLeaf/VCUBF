import { z } from "zod";
import { prisma } from "../db.js";
import { recordAudit } from "../lib/audit.js";
import {
  BUSINESS_CONTEXT_CATEGORIES,
  BUSINESS_CONTEXT_SOURCES,
  BUSINESS_CONTEXT_VERIFICATION_STATUSES,
  CREATE_BUSINESS_CONTEXT_ITEM_ACTION,
  UPDATE_BUSINESS_CONTEXT_ITEM_ACTION,
} from "../lib/actionContracts.js";
import type { AuthedUser } from "../middleware/auth.js";
import { fail, ok, type ServiceResult } from "./result.js";

// Business Context Layer — the structured company knowledge foundation.
// This module deliberately stores only explicit context items, each with a
// source and verification status. It does not extract facts automatically,
// duplicate operational records, or generate public claims. Later Website,
// Business Growth and Communication Intelligence slices can read these
// records as real context instead of asking an LLM to invent company facts.

export const createBusinessContextItemSchema = z.object({
  category: z.enum(BUSINESS_CONTEXT_CATEGORIES),
  label: z.string().min(1, "label is required"),
  value: z.string().min(1, "value is required"),
  source: z.enum(BUSINESS_CONTEXT_SOURCES).default("user_input"),
  verification_status: z.enum(BUSINESS_CONTEXT_VERIFICATION_STATUSES).default("user_entered"),
  notes: z.string().optional(),
});

export const updateBusinessContextItemSchema = z.object({
  category: z.enum(BUSINESS_CONTEXT_CATEGORIES).optional(),
  label: z.string().min(1).optional(),
  value: z.string().min(1).optional(),
  source: z.enum(BUSINESS_CONTEXT_SOURCES).optional(),
  verification_status: z.enum(BUSINESS_CONTEXT_VERIFICATION_STATUSES).optional(),
  notes: z.string().nullable().optional(),
  is_active: z.boolean().optional(),
});

export async function listBusinessContextItems(
  user: AuthedUser,
  filters: { category?: string; activeOnly?: boolean } = {}
) {
  return prisma.businessContextItem.findMany({
    where: {
      companyId: user.companyId,
      ...(filters.category ? { category: filters.category } : {}),
      ...(filters.activeOnly ? { isActive: true } : {}),
    },
    orderBy: [{ category: "asc" }, { label: "asc" }],
  });
}

export async function getBusinessContextItem(user: AuthedUser, id: string) {
  return prisma.businessContextItem.findFirst({
    where: { id, companyId: user.companyId },
  });
}

// create_business_context_item — Action Contract driven.
export async function createBusinessContextItem(user: AuthedUser, rawInput: unknown): Promise<ServiceResult<unknown>> {
  const parsed = createBusinessContextItemSchema.safeParse(rawInput);
  if (!parsed.success) {
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: CREATE_BUSINESS_CONTEXT_ITEM_ACTION.actionName,
      inputPayload: rawInput,
      riskLevel: CREATE_BUSINESS_CONTEXT_ITEM_ACTION.riskLevel,
      confirmationRequired: CREATE_BUSINESS_CONTEXT_ITEM_ACTION.confirmationRequired,
      result: "error",
      errorMessage: "VALIDATION_FAILED",
    });
    return fail(400, "VALIDATION_FAILED", parsed.error.message);
  }

  const data = parsed.data;
  const created = await prisma.businessContextItem.create({
    data: {
      companyId: user.companyId,
      category: data.category,
      label: data.label,
      value: data.value,
      source: data.source,
      verificationStatus: data.verification_status,
      notes: data.notes,
      createdBy: user.id,
    },
  });

  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: CREATE_BUSINESS_CONTEXT_ITEM_ACTION.actionName,
    inputPayload: data,
    dataAfter: created,
    riskLevel: CREATE_BUSINESS_CONTEXT_ITEM_ACTION.riskLevel,
    confirmationRequired: CREATE_BUSINESS_CONTEXT_ITEM_ACTION.confirmationRequired,
    result: "success",
  });

  return ok(201, created);
}

// update_business_context_item — Action Contract driven.
export async function updateBusinessContextItem(
  user: AuthedUser,
  id: string,
  rawInput: unknown
): Promise<ServiceResult<unknown>> {
  const parsed = updateBusinessContextItemSchema.safeParse(rawInput);
  if (!parsed.success) {
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: UPDATE_BUSINESS_CONTEXT_ITEM_ACTION.actionName,
      inputPayload: { id, ...(typeof rawInput === "object" && rawInput ? rawInput : {}) },
      riskLevel: UPDATE_BUSINESS_CONTEXT_ITEM_ACTION.riskLevel,
      confirmationRequired: UPDATE_BUSINESS_CONTEXT_ITEM_ACTION.confirmationRequired,
      result: "error",
      errorMessage: "VALIDATION_FAILED",
    });
    return fail(400, "VALIDATION_FAILED", parsed.error.message);
  }

  const existing = await prisma.businessContextItem.findFirst({ where: { id, companyId: user.companyId } });
  if (!existing) {
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: UPDATE_BUSINESS_CONTEXT_ITEM_ACTION.actionName,
      inputPayload: { id, ...(typeof parsed.data === "object" ? parsed.data : {}) },
      riskLevel: UPDATE_BUSINESS_CONTEXT_ITEM_ACTION.riskLevel,
      confirmationRequired: UPDATE_BUSINESS_CONTEXT_ITEM_ACTION.confirmationRequired,
      result: "error",
      errorMessage: "BUSINESS_CONTEXT_ITEM_NOT_FOUND",
    });
    return fail(404, "BUSINESS_CONTEXT_ITEM_NOT_FOUND");
  }

  const data = parsed.data;
  const changes: Record<string, unknown> = {};
  if (data.category !== undefined) changes.category = data.category;
  if (data.label !== undefined) changes.label = data.label;
  if (data.value !== undefined) changes.value = data.value;
  if (data.source !== undefined) changes.source = data.source;
  if (data.verification_status !== undefined) changes.verificationStatus = data.verification_status;
  if (data.notes !== undefined) changes.notes = data.notes;
  if (data.is_active !== undefined) changes.isActive = data.is_active;

  const updated = await prisma.businessContextItem.update({
    where: { id: existing.id },
    data: changes,
  });

  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: UPDATE_BUSINESS_CONTEXT_ITEM_ACTION.actionName,
    inputPayload: { id, changes },
    dataBefore: existing,
    dataAfter: updated,
    riskLevel: UPDATE_BUSINESS_CONTEXT_ITEM_ACTION.riskLevel,
    confirmationRequired: UPDATE_BUSINESS_CONTEXT_ITEM_ACTION.confirmationRequired,
    result: "success",
  });

  return ok(200, updated);
}
