import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Prisma } from "@prisma/client";
import { parse } from "csv-parse/sync";
import { z } from "zod";
import { prisma } from "../db.js";
import {
  ACTIVATE_REFERENCE_ACTIVITY_ACTION,
  LIST_REFERENCE_ACTIVITIES_ACTION,
} from "../lib/actionContracts.js";
import { recordAudit } from "../lib/audit.js";
import { nonnegativeMoney } from "../lib/money.js";
import type { AuthedUser } from "../middleware/auth.js";
import { fail, ok, type ServiceResult } from "./result.js";

const CATALOGUE_FILE_NAME = "SECRETARY_ACTIVITIES_CATALOGUE.csv";
const CATALOGUE_PATH = fileURLToPath(new URL(`../../data/${CATALOGUE_FILE_NAME}`, import.meta.url));
const REQUIRED_HEADERS = [
  "industry_code",
  "industry_name",
  "subtype_code",
  "subtype_name",
  "activity_code",
  "activity_name",
  "default_pricing_method",
  "rate_unit",
  "oxfordshire_rate_gbp",
  "available_pricing_methods",
] as const;

interface CsvActivityRow extends Record<string, string> {
  industry_code: string;
  industry_name: string;
  subtype_code: string;
  subtype_name: string;
  activity_code: string;
  activity_name: string;
  default_pricing_method: string;
  rate_unit: string;
  oxfordshire_rate_gbp: string;
  available_pricing_methods: string;
}

export interface ReferenceActivity {
  industryCode: string;
  industryName: string;
  subtypeCode: string;
  subtypeName: string;
  activityCode: string;
  activityName: string;
  defaultPricingMethod: string;
  rateUnit: string;
  oxfordshireRateGbp: number;
  availablePricingMethods: string[];
}

interface CatalogueData {
  entries: ReferenceActivity[];
  byCode: Map<string, ReferenceActivity>;
  rawRowCount: number;
  duplicateRowCount: number;
  industries: Array<{ code: string; name: string }>;
}

let catalogueCache: CatalogueData | null = null;

function normalizedRow(row: CsvActivityRow) {
  return REQUIRED_HEADERS.map((header) => row[header].trim()).join("\u0000");
}

function loadCatalogue(): CatalogueData {
  if (catalogueCache) return catalogueCache;
  const text = readFileSync(CATALOGUE_PATH, "utf8");
  let headers: string[] = [];
  const rows = parse(text, {
    bom: true,
    columns: (header: string[]) => {
      headers = header;
      return header;
    },
    skip_empty_lines: true,
    trim: true,
  }) as CsvActivityRow[];
  if (headers.length !== REQUIRED_HEADERS.length || REQUIRED_HEADERS.some((header, index) => headers[index] !== header)) {
    throw new Error("REFERENCE_CATALOGUE_HEADERS_INVALID");
  }

  const byCode = new Map<string, ReferenceActivity>();
  const rawByCode = new Map<string, string>();
  const industries = new Map<string, string>();
  let duplicateRowCount = 0;
  for (const row of rows) {
    if (REQUIRED_HEADERS.some((header) => !row[header])) throw new Error("REFERENCE_CATALOGUE_ROW_INVALID");
    const rate = Number(row.oxfordshire_rate_gbp);
    if (!Number.isFinite(rate) || rate < 0) throw new Error("REFERENCE_CATALOGUE_RATE_INVALID");
    const existingRaw = rawByCode.get(row.activity_code);
    const currentRaw = normalizedRow(row);
    if (existingRaw) {
      if (existingRaw !== currentRaw) throw new Error("REFERENCE_CATALOGUE_CODE_CONFLICT");
      duplicateRowCount += 1;
      continue;
    }
    rawByCode.set(row.activity_code, currentRaw);
    industries.set(row.industry_code, row.industry_name);
    byCode.set(row.activity_code, {
      industryCode: row.industry_code,
      industryName: row.industry_name,
      subtypeCode: row.subtype_code,
      subtypeName: row.subtype_name,
      activityCode: row.activity_code,
      activityName: row.activity_name,
      defaultPricingMethod: row.default_pricing_method,
      rateUnit: row.rate_unit,
      oxfordshireRateGbp: rate,
      availablePricingMethods: row.available_pricing_methods.split("|").map((value) => value.trim()).filter(Boolean),
    });
  }
  catalogueCache = {
    entries: [...byCode.values()],
    byCode,
    rawRowCount: rows.length,
    duplicateRowCount,
    industries: [...industries].map(([code, name]) => ({ code, name })),
  };
  return catalogueCache;
}

export const referenceActivityQuerySchema = z
  .object({
    search: z.string().trim().max(200).optional(),
    industry_code: z.string().trim().max(200).optional(),
    subtype_code: z.string().trim().max(300).optional(),
    offset: z.coerce.number().int().min(0).default(0),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export const activateReferenceActivitySchema = z
  .object({
    confirmed: z.boolean().optional(),
    description: z.string().trim().max(5000).optional(),
    base_price_min: nonnegativeMoney.optional(),
    base_price_max: nonnegativeMoney.optional(),
    price_unit: z.string().trim().max(100).optional(),
    default_duration_hours: z.number().positive().optional(),
    default_required_skills: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
  })
  .strict()
  .refine(
    (value) => value.base_price_min === undefined || value.base_price_max === undefined || value.base_price_min <= value.base_price_max,
    "base_price_min must be less than or equal to base_price_max"
  );

export async function listReferenceActivities(user: AuthedUser, rawQuery: unknown): Promise<ServiceResult<unknown>> {
  const parsed = referenceActivityQuerySchema.safeParse(rawQuery);
  if (!parsed.success) {
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: LIST_REFERENCE_ACTIVITIES_ACTION.actionName,
      inputPayload: {},
      riskLevel: 0,
      result: "error",
      errorMessage: "VALIDATION_FAILED",
    });
    return fail(400, "VALIDATION_FAILED", parsed.error.message);
  }
  try {
    const catalogue = loadCatalogue();
    const search = parsed.data.search?.toLocaleLowerCase("en-GB");
    const filtered = catalogue.entries.filter((entry) => {
      if (parsed.data.industry_code && entry.industryCode !== parsed.data.industry_code) return false;
      if (parsed.data.subtype_code && entry.subtypeCode !== parsed.data.subtype_code) return false;
      if (!search) return true;
      return [entry.activityName, entry.activityCode, entry.subtypeName, entry.industryName]
        .some((value) => value.toLocaleLowerCase("en-GB").includes(search));
    });
    const pageEntries = filtered.slice(parsed.data.offset, parsed.data.offset + parsed.data.limit);
    const activated = await prisma.serviceCatalogueItem.findMany({
      where: {
        companyId: user.companyId,
        referenceActivityCode: { in: pageEntries.map((entry) => entry.activityCode) },
      },
      select: { id: true, referenceActivityCode: true, isActive: true },
    });
    const activatedByCode = new Map(activated.map((item) => [item.referenceActivityCode, item]));
    const items = pageEntries.map((entry) => ({
      ...entry,
      activatedServiceId: activatedByCode.get(entry.activityCode)?.id ?? null,
      activatedServiceIsActive: activatedByCode.get(entry.activityCode)?.isActive ?? null,
    }));
    const result = {
      items,
      total: filtered.length,
      offset: parsed.data.offset,
      limit: parsed.data.limit,
      industries: catalogue.industries,
      catalogue: {
        sourceFile: CATALOGUE_FILE_NAME,
        rawRowCount: catalogue.rawRowCount,
        uniqueActivityCount: catalogue.entries.length,
        duplicateRowCount: catalogue.duplicateRowCount,
        industryCount: catalogue.industries.length,
        pricingDisclaimer: "Oxfordshire rates are reference values only and are never copied into company prices automatically.",
      },
    };
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: LIST_REFERENCE_ACTIVITIES_ACTION.actionName,
      inputPayload: {
        searchProvided: Boolean(search),
        industryCode: parsed.data.industry_code,
        subtypeCode: parsed.data.subtype_code,
        offset: parsed.data.offset,
        limit: parsed.data.limit,
      },
      dataAfter: { returnedCount: items.length, total: filtered.length },
      riskLevel: 0,
      result: "success",
    });
    return ok(200, result);
  } catch {
    return fail(500, "REFERENCE_CATALOGUE_UNAVAILABLE");
  }
}

export async function activateReferenceActivity(
  user: AuthedUser,
  activityCode: string,
  rawInput: unknown
): Promise<ServiceResult<unknown>> {
  const parsedCode = z.string().trim().min(1).max(300).safeParse(activityCode);
  const parsed = activateReferenceActivitySchema.safeParse(rawInput);
  if (!parsedCode.success || !parsed.success) {
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: ACTIVATE_REFERENCE_ACTIVITY_ACTION.actionName,
      inputPayload: { activityCode },
      riskLevel: ACTIVATE_REFERENCE_ACTIVITY_ACTION.riskLevel,
      confirmationRequired: true,
      result: "error",
      errorMessage: "VALIDATION_FAILED",
    });
    return fail(
      400,
      "VALIDATION_FAILED",
      !parsed.success ? parsed.error.message : !parsedCode.success ? parsedCode.error.message : "Invalid input"
    );
  }
  let entry: ReferenceActivity | undefined;
  try {
    entry = loadCatalogue().byCode.get(parsedCode.data);
  } catch {
    return fail(500, "REFERENCE_CATALOGUE_UNAVAILABLE");
  }
  if (!entry) return fail(404, "REFERENCE_ACTIVITY_NOT_FOUND");
  const existing = await prisma.serviceCatalogueItem.findFirst({
    where: { companyId: user.companyId, referenceActivityCode: entry.activityCode },
  });
  if (existing) return fail(409, "REFERENCE_ACTIVITY_ALREADY_ACTIVATED", undefined, { serviceId: existing.id });

  const input = parsed.data;
  const preview = {
    activity: entry,
    companyPrice: {
      basePriceMin: input.base_price_min ?? null,
      basePriceMax: input.base_price_max ?? null,
      priceUnit: input.price_unit ?? null,
    },
    referenceRateAppliedToCompanyPrice: false,
    willCreateOrConfirmIndustry: entry.industryName,
    willCreateService: entry.activityName,
  };
  if (!input.confirmed) {
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: ACTIVATE_REFERENCE_ACTIVITY_ACTION.actionName,
      inputPayload: { activityCode: entry.activityCode, confirmed: false },
      dataBefore: preview,
      riskLevel: ACTIVATE_REFERENCE_ACTIVITY_ACTION.riskLevel,
      confirmationRequired: true,
      result: "rejected",
      errorMessage: "CONFIRMATION_REQUIRED",
    });
    return fail(409, "CONFIRMATION_REQUIRED", "Confirm that the company really performs this activity.", { preview });
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      let industry = await tx.industry.findFirst({
        where: { companyId: user.companyId, name: { equals: entry!.industryName, mode: "insensitive" } },
      });
      if (!industry) {
        industry = await tx.industry.create({
          data: {
            companyId: user.companyId,
            name: entry!.industryName,
            source: "confirmed_company_data",
            verificationStatus: "confirmed",
            notes: `${CATALOGUE_FILE_NAME} industry_code=${entry!.industryCode}`,
            createdBy: user.id,
          },
        });
      } else if (!industry.isActive || industry.verificationStatus !== "confirmed") {
        industry = await tx.industry.update({
          where: { id: industry.id },
          data: { isActive: true, verificationStatus: "confirmed" },
        });
      }
      const service = await tx.serviceCatalogueItem.create({
        data: {
          companyId: user.companyId,
          name: entry!.activityName,
          description: input.description,
          category: entry!.subtypeName,
          basePriceMin: input.base_price_min,
          basePriceMax: input.base_price_max,
          priceUnit: input.price_unit,
          defaultDurationHours: input.default_duration_hours,
          defaultRequiredSkills: input.default_required_skills ?? [],
          source: "confirmed_reference_activity",
          sourceReference: `${CATALOGUE_FILE_NAME}#${entry!.activityCode}`,
          referenceActivityCode: entry!.activityCode,
          referenceIndustryCode: entry!.industryCode,
          referenceSubtypeCode: entry!.subtypeCode,
          referencePricingMethod: entry!.defaultPricingMethod,
          referenceRateUnit: entry!.rateUnit,
          referenceRateGbp: entry!.oxfordshireRateGbp,
          referencePricingMethods: entry!.availablePricingMethods,
          createdBy: user.id,
        },
      });
      const link = await tx.industryServiceLink.create({
        data: {
          companyId: user.companyId,
          industryId: industry.id,
          serviceCatalogueItemId: service.id,
          notes: `Confirmed activation from ${CATALOGUE_FILE_NAME}`,
          createdBy: user.id,
        },
      });
      return {
        service: {
          ...service,
          basePriceMin: service.basePriceMin == null ? null : Number(service.basePriceMin),
          basePriceMax: service.basePriceMax == null ? null : Number(service.basePriceMax),
          referenceRateGbp: service.referenceRateGbp == null ? null : Number(service.referenceRateGbp),
        },
        industry,
        link,
      };
    });
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: ACTIVATE_REFERENCE_ACTIVITY_ACTION.actionName,
      inputPayload: {
        activityCode: entry.activityCode,
        confirmed: true,
        companyPriceEntered: input.base_price_min !== undefined || input.base_price_max !== undefined,
      },
      dataAfter: result,
      riskLevel: ACTIVATE_REFERENCE_ACTIVITY_ACTION.riskLevel,
      confirmationRequired: true,
      confirmed: true,
      result: "success",
    });
    return ok(201, result);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return fail(409, "REFERENCE_ACTIVITY_ALREADY_ACTIVATED");
    }
    throw error;
  }
}
