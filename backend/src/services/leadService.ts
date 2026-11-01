import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { recordAudit } from "../lib/audit.js";
import { CONVERT_LEAD_ACTION, CREATE_LEAD_ACTION, UPDATE_LEAD_ACTION } from "../lib/actionContracts.js";
import { phoneNumberSchema } from "../lib/contactNormalization.js";
import type { AuthedUser } from "../middleware/auth.js";
import { fail, ok, type ServiceResult } from "./result.js";
import { assertNotInSafeModeLocked } from "../lib/safeMode.js";

export const createLeadSchema = z.object({
  name: z.string().min(1, "name is required"),
  phone: phoneNumberSchema.optional(),
  email: z.string().email().optional().or(z.literal("")),
  service_requested: z.string().optional(),
  location: z.string().optional(),
  source: z.string().optional(),
  urgency: z.string().optional(),
  notes: z.string().optional(),
});

/**
 * Correcting a lead.
 *
 * `source` is absent on purpose: it records where the enquiry came from, and a
 * value anyone can retype answers nothing. "converted" is absent from the status
 * list for a harder reason — that word asserts a client record exists, and only
 * convertLead creates one.
 *
 * Nullable fields let a wrong value be removed rather than only overwritten.
 */
export const updateLeadSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    phone: phoneNumberSchema.nullable().optional(),
    email: z.string().email().nullable().optional().or(z.literal("")),
    service_requested: z.string().nullable().optional(),
    location: z.string().nullable().optional(),
    urgency: z.string().nullable().optional(),
    lead_status: z.enum(["new", "contacted", "qualified", "lost"]).optional(),
    notes: z.string().nullable().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, "At least one field is required");

export async function listLeads(user: AuthedUser, filters: { status?: string }) {
  return prisma.lead.findMany({
    where: { companyId: user.companyId, ...(filters.status ? { leadStatus: filters.status } : {}) },
    orderBy: { createdAt: "desc" },
  });
}

export async function getLead(user: AuthedUser, id: string) {
  return prisma.lead.findFirst({ where: { id, companyId: user.companyId } });
}

// Case-insensitive substring match on lead name — used by the Text Command
// Layer to resolve "convert lead John" to a specific record. Returns all
// matches so the caller can detect ambiguity and ask for clarification
// instead of guessing.
export async function findLeadsByName(user: AuthedUser, name: string) {
  return prisma.lead.findMany({
    where: { companyId: user.companyId, name: { contains: name, mode: "insensitive" } },
  });
}

export async function findClientsByName(user: AuthedUser, name: string) {
  return prisma.client.findMany({
    where: { companyId: user.companyId, displayName: { contains: name, mode: "insensitive" } },
  });
}

// create_lead — Action Contract driven.
export async function createLead(user: AuthedUser, rawInput: unknown): Promise<ServiceResult<unknown>> {
  const parsed = createLeadSchema.safeParse(rawInput);
  if (!parsed.success) {
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: CREATE_LEAD_ACTION.actionName,
      inputPayload: rawInput,
      riskLevel: CREATE_LEAD_ACTION.riskLevel,
      confirmationRequired: CREATE_LEAD_ACTION.confirmationRequired,
      result: "error",
      errorMessage: "VALIDATION_FAILED",
    });
    return fail(400, "VALIDATION_FAILED", parsed.error.message);
  }
  const data = parsed.data;

  const lead = await prisma.lead.create({
    data: {
      companyId: user.companyId,
      name: data.name,
      phone: data.phone,
      email: data.email || undefined,
      serviceRequested: data.service_requested,
      location: data.location,
      source: data.source ?? "manual",
      urgency: data.urgency,
      notes: data.notes,
      createdBy: user.id,
    },
  });

  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: CREATE_LEAD_ACTION.actionName,
    inputPayload: data,
    dataAfter: lead,
    riskLevel: CREATE_LEAD_ACTION.riskLevel,
    confirmationRequired: CREATE_LEAD_ACTION.confirmationRequired,
    result: "success",
  });

  return ok(201, lead);
}

// update_lead — Action Contract driven.
export async function updateLead(user: AuthedUser, leadId: string, rawInput: unknown): Promise<ServiceResult<unknown>> {
  const parsed = updateLeadSchema.safeParse(rawInput);
  if (!parsed.success) {
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: UPDATE_LEAD_ACTION.actionName,
      inputPayload: { leadId, input: rawInput },
      riskLevel: UPDATE_LEAD_ACTION.riskLevel,
      confirmationRequired: UPDATE_LEAD_ACTION.confirmationRequired,
      result: "error",
      errorMessage: "VALIDATION_FAILED",
    });
    return fail(400, "VALIDATION_FAILED", parsed.error.message);
  }
  const input = parsed.data;

  const existing = await prisma.lead.findFirst({ where: { id: leadId, companyId: user.companyId } });
  if (!existing) {
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: UPDATE_LEAD_ACTION.actionName,
      inputPayload: { leadId, ...input },
      riskLevel: UPDATE_LEAD_ACTION.riskLevel,
      confirmationRequired: UPDATE_LEAD_ACTION.confirmationRequired,
      result: "error",
      errorMessage: "LEAD_NOT_FOUND",
    });
    return fail(404, "LEAD_NOT_FOUND");
  }

  // Conversion is a fact that already happened and left a client behind. Typing a
  // different status here would orphan that client, so it is refused outright.
  if (existing.leadStatus === "converted" && input.lead_status) {
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: UPDATE_LEAD_ACTION.actionName,
      inputPayload: { leadId, ...input },
      dataBefore: existing,
      riskLevel: UPDATE_LEAD_ACTION.riskLevel,
      confirmationRequired: UPDATE_LEAD_ACTION.confirmationRequired,
      result: "error",
      errorMessage: "UNSUPPORTED_ACTION",
    });
    return fail(409, "UNSUPPORTED_ACTION", "A converted lead cannot change status; the client record already exists.", {
      clientId: existing.convertedClientId,
    });
  }

  const lead = await prisma.lead.update({
    where: { id: existing.id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.phone !== undefined ? { phone: input.phone } : {}),
      ...(input.email !== undefined ? { email: input.email || null } : {}),
      ...(input.service_requested !== undefined ? { serviceRequested: input.service_requested } : {}),
      ...(input.location !== undefined ? { location: input.location } : {}),
      ...(input.urgency !== undefined ? { urgency: input.urgency } : {}),
      ...(input.lead_status !== undefined ? { leadStatus: input.lead_status } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
    },
  });

  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: UPDATE_LEAD_ACTION.actionName,
    inputPayload: { leadId, ...input },
    dataBefore: existing,
    dataAfter: lead,
    riskLevel: UPDATE_LEAD_ACTION.riskLevel,
    confirmationRequired: UPDATE_LEAD_ACTION.confirmationRequired,
    result: "success",
  });

  return ok(200, lead);
}

// convert_lead_to_client — Action Contract driven.
//
// One transaction under the lead's row lock: the client and the lead's
// converted status are saved together or not at all, two conversions of one
// lead cannot both create a client, and with options.expectedRevision (the
// lead's updatedAt as the caller showed it for approval, e.g. the MCP
// gateway's preview) a lead edited since is refused with LEAD_CHANGED instead
// of being converted with details nobody approved. With options.expectedClient
// (the client the approved preview linked to, or null for a new client) the
// outcome itself is bound too: the matching client is locked and must still
// be that client under that name, or the conversion is refused with
// CONVERSION_CHANGED, since a client's e-mail can change without the lead.
export async function convertLead(
  user: AuthedUser,
  leadId: string,
  options: { expectedRevision?: string; expectedClient?: { id: string; displayName: string } | null; safeModeLocked?: boolean } = {},
): Promise<ServiceResult<unknown>> {
  const outcome = await prisma.$transaction(async (tx) => {
    if (options.safeModeLocked) await assertNotInSafeModeLocked(tx, user.companyId);
    await tx.$queryRaw(Prisma.sql`SELECT id FROM leads WHERE id = ${leadId} AND company_id = ${user.companyId} FOR UPDATE`);
    const lead = await tx.lead.findFirst({ where: { id: leadId, companyId: user.companyId } });
    if (!lead) return { error: "LEAD_NOT_FOUND" as const };
    if (lead.leadStatus === "converted" && lead.convertedClientId) {
      return { error: "UNSUPPORTED_ACTION" as const, lead };
    }
    if (options.expectedRevision && lead.updatedAt.toISOString() !== options.expectedRevision) {
      return { error: "LEAD_CHANGED" as const, lead };
    }
    const matched = lead.email
      ? await tx.client.findFirst({ where: { companyId: user.companyId, emailPrimary: lead.email }, select: { id: true } })
      : null;
    if (matched) await tx.$queryRaw(Prisma.sql`SELECT id FROM clients WHERE id = ${matched.id} AND company_id = ${user.companyId} FOR UPDATE`);
    // Read again under its lock: what is linked is what was just compared.
    const existingClient = matched
      ? await tx.client.findFirst({ where: { id: matched.id, companyId: user.companyId, ...(lead.email ? { emailPrimary: lead.email } : {}) } })
      : null;
    if (options.expectedClient !== undefined) {
      const expected = options.expectedClient;
      const same = expected === null
        ? existingClient === null
        : existingClient !== null && existingClient.id === expected.id && existingClient.displayName === expected.displayName;
      if (!same) return { error: "CONVERSION_CHANGED" as const, lead };
    }
    const client =
      existingClient ??
      (await tx.client.create({
        data: {
          companyId: user.companyId,
          displayName: lead.name,
          emailPrimary: lead.email ?? undefined,
          phonePrimary: lead.phone ?? undefined,
          source: `lead:${lead.id}`,
          createdBy: user.id,
        },
      }));
    const updatedLead = await tx.lead.update({
      where: { id: lead.id },
      data: { leadStatus: "converted", convertedClientId: client.id },
    });
    return { lead: updatedLead, client };
  });

  if ("error" in outcome && outcome.error) {
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: CONVERT_LEAD_ACTION.actionName,
      inputPayload: { leadId: outcome.error === "LEAD_NOT_FOUND" ? leadId : outcome.lead.id },
      riskLevel: CONVERT_LEAD_ACTION.riskLevel,
      confirmationRequired: CONVERT_LEAD_ACTION.confirmationRequired,
      result: "error",
      errorMessage: outcome.error,
    });
    if (outcome.error === "LEAD_NOT_FOUND") return fail(404, "LEAD_NOT_FOUND");
    if (outcome.error === "LEAD_CHANGED") return fail(409, "LEAD_CHANGED", "The lead changed after it was shown. Review it again.");
    if (outcome.error === "CONVERSION_CHANGED") {
      return fail(409, "CONVERSION_CHANGED", "The client this lead would be linked to changed after it was shown. Review it again.");
    }
    return fail(409, "UNSUPPORTED_ACTION", "This lead has already been converted.", {
      clientId: outcome.lead.convertedClientId,
    });
  }
  const { lead: updatedLead, client } = outcome as { lead: Awaited<ReturnType<typeof prisma.lead.update>>; client: Awaited<ReturnType<typeof prisma.client.create>> };

  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: CONVERT_LEAD_ACTION.actionName,
    inputPayload: { leadId: updatedLead.id },
    dataAfter: { lead: updatedLead, client },
    riskLevel: CONVERT_LEAD_ACTION.riskLevel,
    confirmationRequired: CONVERT_LEAD_ACTION.confirmationRequired,
    result: "success",
  });

  return ok(200, { lead: updatedLead, client });
}
