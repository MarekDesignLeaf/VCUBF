import { z } from "zod";
import { prisma } from "../db.js";
import { recordAudit } from "../lib/audit.js";
import { nonnegativeMoney } from "../lib/money.js";
import { CREATE_SERVICE_ACTION, UPDATE_SERVICE_ACTION } from "../lib/actionContracts.js";
import type { AuthedUser } from "../middleware/auth.js";
import { fail, ok, type ServiceResult } from "./result.js";

// Service Catalogue Module. Every field here is entered by the user — this
// service never fabricates a name, price, or description.

export const createServiceSchema = z.object({
  name: z.string().min(1, "name is required"),
  description: z.string().optional(),
  category: z.string().optional(),
  base_price_min: nonnegativeMoney.optional(),
  base_price_max: nonnegativeMoney.optional(),
  price_unit: z.string().optional(),
  default_duration_hours: z.number().positive().optional(),
  default_required_skills: z.array(z.string()).optional(),
});

export const updateServiceSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  category: z.string().optional(),
  base_price_min: nonnegativeMoney.nullable().optional(),
  base_price_max: nonnegativeMoney.nullable().optional(),
  price_unit: z.string().optional(),
  default_duration_hours: z.number().positive().nullable().optional(),
  default_required_skills: z.array(z.string()).optional(),
  is_active: z.boolean().optional(),
});
function numericPrices<T extends { basePriceMin: unknown; basePriceMax: unknown; referenceRateGbp: unknown }>(x:T){return {...x,basePriceMin:x.basePriceMin==null?null:Number(x.basePriceMin),basePriceMax:x.basePriceMax==null?null:Number(x.basePriceMax),referenceRateGbp:x.referenceRateGbp==null?null:Number(x.referenceRateGbp)}}

export async function listServices(user: AuthedUser, filters: { activeOnly?: boolean } = {}) {
  return (await prisma.serviceCatalogueItem.findMany({
    where: {
      companyId: user.companyId,
      ...(filters.activeOnly ? { isActive: true } : {}),
    },
    orderBy: { name: "asc" },
  })).map(numericPrices);
}

export async function getService(user: AuthedUser, id: string) {
  const x=await prisma.serviceCatalogueItem.findFirst({ where: { id, companyId: user.companyId } });return x?numericPrices(x):null;
}

// Case-insensitive substring match on name — used by the Text Command Layer
// to resolve "create job X based on service Y" style references (and for
// simple "create service" duplicate-name awareness later, if needed).
export async function findServicesByName(user: AuthedUser, name: string) {
  return (await prisma.serviceCatalogueItem.findMany({
    where: { companyId: user.companyId, name: { contains: name, mode: "insensitive" } },
  })).map(numericPrices);
}

// create_service_catalogue_item — Action Contract driven.
export async function createService(user: AuthedUser, rawInput: unknown): Promise<ServiceResult<unknown>> {
  const parsed = createServiceSchema.safeParse(rawInput);
  if (!parsed.success) {
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: CREATE_SERVICE_ACTION.actionName,
      inputPayload: rawInput,
      riskLevel: CREATE_SERVICE_ACTION.riskLevel,
      confirmationRequired: CREATE_SERVICE_ACTION.confirmationRequired,
      result: "error",
      errorMessage: "VALIDATION_FAILED",
    });
    return fail(400, "VALIDATION_FAILED", parsed.error.message);
  }
  const data = parsed.data;

  const created = await prisma.serviceCatalogueItem.create({
    data: {
      companyId: user.companyId,
      name: data.name,
      description: data.description,
      category: data.category,
      basePriceMin: data.base_price_min,
      basePriceMax: data.base_price_max,
      priceUnit: data.price_unit,
      defaultDurationHours: data.default_duration_hours,
      defaultRequiredSkills: data.default_required_skills ?? [],
      createdBy: user.id,
    },
  });

  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: CREATE_SERVICE_ACTION.actionName,
    inputPayload: data,
    dataAfter: created,
    riskLevel: CREATE_SERVICE_ACTION.riskLevel,
    confirmationRequired: CREATE_SERVICE_ACTION.confirmationRequired,
    result: "success",
  });

  return ok(201, numericPrices(created));
}

// update_service_catalogue_item — Action Contract driven.
export async function updateService(
  user: AuthedUser,
  serviceId: string,
  rawInput: unknown
): Promise<ServiceResult<unknown>> {
  const parsed = updateServiceSchema.safeParse(rawInput);
  if (!parsed.success) {
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: UPDATE_SERVICE_ACTION.actionName,
      inputPayload: { serviceId, ...(typeof rawInput === "object" && rawInput ? rawInput : {}) },
      riskLevel: UPDATE_SERVICE_ACTION.riskLevel,
      confirmationRequired: UPDATE_SERVICE_ACTION.confirmationRequired,
      result: "error",
      errorMessage: "VALIDATION_FAILED",
    });
    return fail(400, "VALIDATION_FAILED", parsed.error.message);
  }
  const data = parsed.data;

  const existing = await prisma.serviceCatalogueItem.findFirst({ where: { id: serviceId, companyId: user.companyId } });
  if (!existing) {
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: UPDATE_SERVICE_ACTION.actionName,
      inputPayload: { serviceId, ...data },
      riskLevel: UPDATE_SERVICE_ACTION.riskLevel,
      confirmationRequired: UPDATE_SERVICE_ACTION.confirmationRequired,
      result: "error",
      errorMessage: "SERVICE_NOT_FOUND",
    });
    return fail(404, "SERVICE_NOT_FOUND");
  }

  const changes: Record<string, unknown> = {};
  if (data.name !== undefined) changes.name = data.name;
  if (data.description !== undefined) changes.description = data.description;
  if (data.category !== undefined) changes.category = data.category;
  if (data.base_price_min !== undefined) changes.basePriceMin = data.base_price_min;
  if (data.base_price_max !== undefined) changes.basePriceMax = data.base_price_max;
  if (data.price_unit !== undefined) changes.priceUnit = data.price_unit;
  if (data.default_duration_hours !== undefined) changes.defaultDurationHours = data.default_duration_hours;
  if (data.default_required_skills !== undefined) changes.defaultRequiredSkills = data.default_required_skills;
  if (data.is_active !== undefined) changes.isActive = data.is_active;

  const updated = await prisma.serviceCatalogueItem.update({ where: { id: existing.id }, data: changes });

  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: UPDATE_SERVICE_ACTION.actionName,
    inputPayload: { serviceId, changes },
    dataBefore: existing,
    dataAfter: updated,
    riskLevel: UPDATE_SERVICE_ACTION.riskLevel,
    confirmationRequired: UPDATE_SERVICE_ACTION.confirmationRequired,
    result: "success",
  });

  return ok(200, numericPrices(updated));
}
