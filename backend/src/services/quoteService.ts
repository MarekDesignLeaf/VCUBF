import { z } from "zod";
import { prisma } from "../db.js";
import { recordAudit } from "../lib/audit.js";
import {
  CREATE_QUOTE_ACTION,
  UPDATE_QUOTE_ACTION,
  CHANGE_QUOTE_STATUS_ACTION,
  QUOTE_STATUSES,
} from "../lib/actionContracts.js";
import type { AuthedUser } from "../middleware/auth.js";
import { fail, ok, type ServiceResult } from "./result.js";

// Quote, Pricing and Profitability Module. Every price and cost here is
// either typed in directly or pulled from a service catalogue entry the
// user created — the system never invents a price. Margin is computed only
// from what was actually entered; a line with no cost entered contributes
// to the subtotal but is excluded from the cost total and flagged so the
// margin figure is never silently wrong.

const quoteItemSchema = z.object({
  service_catalogue_item_id: z.string().uuid().optional(),
  description: z.string().min(1, "line item description is required"),
  quantity: z.number().positive().default(1),
  unit_price: z.number().nonnegative(),
  unit_cost: z.number().nonnegative().optional(),
});

export const createQuoteSchema = z.object({
  client_id: z.string().uuid(),
  job_id: z.string().uuid().optional(),
  title: z.string().min(1, "title is required"),
  notes: z.string().optional(),
  valid_until: z.string().datetime().optional(),
  items: z.array(quoteItemSchema).min(1, "at least one line item is required"),
});

export const updateQuoteSchema = z.object({
  title: z.string().min(1).optional(),
  notes: z.string().optional(),
  valid_until: z.string().datetime().nullable().optional(),
  items: z.array(quoteItemSchema).min(1).optional(),
});

export const changeQuoteStatusSchema = z.object({
  quote_status: z.enum(QUOTE_STATUSES),
});

interface QuoteTotals {
  subtotal: number;
  costTotal: number;
  costKnown: boolean;
  marginAmount: number | null;
  marginPct: number | null;
}

// Real math, not a guess: subtotal always sums quantity*unitPrice. Cost total
// only sums lines where a unit cost was actually entered. If ANY line is
// missing a cost, margin is reported as null (unknown) rather than computed
// from a partial, misleading cost total.
function computeTotals(items: { quantity: number; unitPrice: number; unitCost: number | null }[]): QuoteTotals {
  let subtotal = 0;
  let costTotal = 0;
  let costKnown = items.length > 0;
  for (const item of items) {
    subtotal += item.quantity * item.unitPrice;
    if (item.unitCost == null) {
      costKnown = false;
    } else {
      costTotal += item.quantity * item.unitCost;
    }
  }
  const marginAmount = costKnown ? subtotal - costTotal : null;
  const marginPct = costKnown && subtotal > 0 ? (marginAmount! / subtotal) * 100 : costKnown && subtotal === 0 ? 0 : null;
  return { subtotal, costTotal, costKnown, marginAmount, marginPct };
}

function withTotals<T extends { items: { quantity: number; unitPrice: number; unitCost: number | null }[] }>(
  quote: T
) {
  return { ...quote, totals: computeTotals(quote.items) };
}

const quoteInclude = {
  items: { orderBy: { sortOrder: "asc" as const } },
  client: { select: { id: true, displayName: true } },
  job: { select: { id: true, jobTitle: true } },
};

export async function listQuotes(user: AuthedUser, filters: { clientId?: string; jobId?: string; status?: string } = {}) {
  const quotes = await prisma.quote.findMany({
    where: {
      companyId: user.companyId,
      ...(filters.clientId ? { clientId: filters.clientId } : {}),
      ...(filters.jobId ? { jobId: filters.jobId } : {}),
      ...(filters.status ? { quoteStatus: filters.status } : {}),
    },
    include: quoteInclude,
    orderBy: { createdAt: "desc" },
  });
  return quotes.map(withTotals);
}

export async function getQuote(user: AuthedUser, id: string) {
  const quote = await prisma.quote.findFirst({
    where: { id, companyId: user.companyId },
    include: quoteInclude,
  });
  return quote ? withTotals(quote) : null;
}

async function resolveItemInputs(user: AuthedUser, items: z.infer<typeof quoteItemSchema>[]) {
  // Real-data guard: any referenced catalogue item must actually exist and
  // belong to this company — never trust a client-supplied id blindly.
  const catalogueIds = items.map((i) => i.service_catalogue_item_id).filter((id): id is string => !!id);
  if (catalogueIds.length > 0) {
    const found = await prisma.serviceCatalogueItem.findMany({
      where: { id: { in: catalogueIds }, companyId: user.companyId },
      select: { id: true },
    });
    const foundIds = new Set(found.map((f) => f.id));
    const missing = catalogueIds.filter((id) => !foundIds.has(id));
    if (missing.length > 0) {
      return { error: `Unknown service catalogue item id(s): ${missing.join(", ")}` };
    }
  }
  return {
    data: items.map((item, index) => ({
      serviceCatalogueItemId: item.service_catalogue_item_id,
      description: item.description,
      quantity: item.quantity,
      unitPrice: item.unit_price,
      unitCost: item.unit_cost ?? null,
      sortOrder: index,
    })),
  };
}

// prepare_quote — Action Contract driven.
export async function createQuote(user: AuthedUser, rawInput: unknown): Promise<ServiceResult<unknown>> {
  const parsed = createQuoteSchema.safeParse(rawInput);
  if (!parsed.success) {
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: CREATE_QUOTE_ACTION.actionName,
      inputPayload: rawInput,
      riskLevel: CREATE_QUOTE_ACTION.riskLevel,
      confirmationRequired: CREATE_QUOTE_ACTION.confirmationRequired,
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
      actionName: CREATE_QUOTE_ACTION.actionName,
      inputPayload: data,
      riskLevel: CREATE_QUOTE_ACTION.riskLevel,
      confirmationRequired: CREATE_QUOTE_ACTION.confirmationRequired,
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
        actionName: CREATE_QUOTE_ACTION.actionName,
        inputPayload: data,
        riskLevel: CREATE_QUOTE_ACTION.riskLevel,
        confirmationRequired: CREATE_QUOTE_ACTION.confirmationRequired,
        result: "error",
        errorMessage: "JOB_NOT_FOUND",
      });
      return fail(404, "JOB_NOT_FOUND");
    }
  }

  const resolved = await resolveItemInputs(user, data.items);
  if (resolved.error) {
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: CREATE_QUOTE_ACTION.actionName,
      inputPayload: data,
      riskLevel: CREATE_QUOTE_ACTION.riskLevel,
      confirmationRequired: CREATE_QUOTE_ACTION.confirmationRequired,
      result: "error",
      errorMessage: "VALIDATION_FAILED",
    });
    return fail(400, "VALIDATION_FAILED", resolved.error);
  }

  const created = await prisma.quote.create({
    data: {
      companyId: user.companyId,
      clientId: data.client_id,
      jobId: data.job_id,
      title: data.title,
      notes: data.notes,
      validUntil: data.valid_until ? new Date(data.valid_until) : undefined,
      createdBy: user.id,
      items: { create: resolved.data! },
    },
    include: quoteInclude,
  });

  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: CREATE_QUOTE_ACTION.actionName,
    inputPayload: data,
    dataAfter: created,
    riskLevel: CREATE_QUOTE_ACTION.riskLevel,
    confirmationRequired: CREATE_QUOTE_ACTION.confirmationRequired,
    result: "success",
  });

  return ok(201, withTotals(created));
}

// update_quote — Action Contract driven. Replaces the full item set when
// items are supplied (simplest correct semantics for a small MVP form).
export async function updateQuote(user: AuthedUser, quoteId: string, rawInput: unknown): Promise<ServiceResult<unknown>> {
  const parsed = updateQuoteSchema.safeParse(rawInput);
  if (!parsed.success) {
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: UPDATE_QUOTE_ACTION.actionName,
      inputPayload: { quoteId, ...(typeof rawInput === "object" && rawInput ? rawInput : {}) },
      riskLevel: UPDATE_QUOTE_ACTION.riskLevel,
      confirmationRequired: UPDATE_QUOTE_ACTION.confirmationRequired,
      result: "error",
      errorMessage: "VALIDATION_FAILED",
    });
    return fail(400, "VALIDATION_FAILED", parsed.error.message);
  }
  const data = parsed.data;

  const existing = await prisma.quote.findFirst({
    where: { id: quoteId, companyId: user.companyId },
    include: quoteInclude,
  });
  if (!existing) {
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: UPDATE_QUOTE_ACTION.actionName,
      inputPayload: { quoteId, ...data },
      riskLevel: UPDATE_QUOTE_ACTION.riskLevel,
      confirmationRequired: UPDATE_QUOTE_ACTION.confirmationRequired,
      result: "error",
      errorMessage: "QUOTE_NOT_FOUND",
    });
    return fail(404, "QUOTE_NOT_FOUND");
  }

  let itemsResolved: Awaited<ReturnType<typeof resolveItemInputs>> | undefined;
  if (data.items) {
    itemsResolved = await resolveItemInputs(user, data.items);
    if (itemsResolved.error) {
      await recordAudit({
        companyId: user.companyId,
        userId: user.id,
        actionName: UPDATE_QUOTE_ACTION.actionName,
        inputPayload: { quoteId, ...data },
        riskLevel: UPDATE_QUOTE_ACTION.riskLevel,
        confirmationRequired: UPDATE_QUOTE_ACTION.confirmationRequired,
        result: "error",
        errorMessage: "VALIDATION_FAILED",
      });
      return fail(400, "VALIDATION_FAILED", itemsResolved.error);
    }
  }

  const changes: Record<string, unknown> = {};
  if (data.title !== undefined) changes.title = data.title;
  if (data.notes !== undefined) changes.notes = data.notes;
  if (data.valid_until !== undefined) changes.validUntil = data.valid_until ? new Date(data.valid_until) : null;

  const updated = await prisma.$transaction(async (tx) => {
    if (itemsResolved?.data) {
      await tx.quoteItem.deleteMany({ where: { quoteId } });
    }
    return tx.quote.update({
      where: { id: quoteId },
      data: {
        ...changes,
        ...(itemsResolved?.data ? { items: { create: itemsResolved.data } } : {}),
      },
      include: quoteInclude,
    });
  });

  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: UPDATE_QUOTE_ACTION.actionName,
    inputPayload: { quoteId, ...data },
    dataBefore: existing,
    dataAfter: updated,
    riskLevel: UPDATE_QUOTE_ACTION.riskLevel,
    confirmationRequired: UPDATE_QUOTE_ACTION.confirmationRequired,
    result: "success",
  });

  return ok(200, withTotals(updated));
}

// change_quote_status — Action Contract driven. Internal record only; does
// not send anything to the client (no outbound communication connector exists yet).
export async function changeQuoteStatus(user: AuthedUser, quoteId: string, rawInput: unknown): Promise<ServiceResult<unknown>> {
  const parsed = changeQuoteStatusSchema.safeParse(rawInput);
  if (!parsed.success) {
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: CHANGE_QUOTE_STATUS_ACTION.actionName,
      inputPayload: { quoteId, ...(typeof rawInput === "object" && rawInput ? rawInput : {}) },
      riskLevel: CHANGE_QUOTE_STATUS_ACTION.riskLevel,
      confirmationRequired: CHANGE_QUOTE_STATUS_ACTION.confirmationRequired,
      result: "error",
      errorMessage: "VALIDATION_FAILED",
    });
    return fail(400, "VALIDATION_FAILED", parsed.error.message);
  }

  const existing = await prisma.quote.findFirst({ where: { id: quoteId, companyId: user.companyId } });
  if (!existing) {
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: CHANGE_QUOTE_STATUS_ACTION.actionName,
      inputPayload: { quoteId, ...parsed.data },
      riskLevel: CHANGE_QUOTE_STATUS_ACTION.riskLevel,
      confirmationRequired: CHANGE_QUOTE_STATUS_ACTION.confirmationRequired,
      result: "error",
      errorMessage: "QUOTE_NOT_FOUND",
    });
    return fail(404, "QUOTE_NOT_FOUND");
  }

  const updated = await prisma.quote.update({
    where: { id: quoteId },
    data: { quoteStatus: parsed.data.quote_status },
    include: quoteInclude,
  });

  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: CHANGE_QUOTE_STATUS_ACTION.actionName,
    inputPayload: { quoteId, ...parsed.data },
    dataBefore: existing,
    dataAfter: updated,
    riskLevel: CHANGE_QUOTE_STATUS_ACTION.riskLevel,
    confirmationRequired: CHANGE_QUOTE_STATUS_ACTION.confirmationRequired,
    result: "success",
  });

  return ok(200, withTotals(updated));
}
