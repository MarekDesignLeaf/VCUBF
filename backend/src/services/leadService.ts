import { z } from "zod";
import { prisma } from "../db.js";
import { recordAudit } from "../lib/audit.js";
import { CONVERT_LEAD_ACTION, CREATE_LEAD_ACTION } from "../lib/actionContracts.js";
import type { AuthedUser } from "../middleware/auth.js";
import { fail, ok, type ServiceResult } from "./result.js";

export const createLeadSchema = z.object({
  name: z.string().min(1, "name is required"),
  phone: z.string().optional(),
  email: z.string().email().optional().or(z.literal("")),
  service_requested: z.string().optional(),
  location: z.string().optional(),
  source: z.string().optional(),
  urgency: z.string().optional(),
  notes: z.string().optional(),
});

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

// convert_lead_to_client — Action Contract driven.
export async function convertLead(user: AuthedUser, leadId: string): Promise<ServiceResult<unknown>> {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, companyId: user.companyId } });
  if (!lead) {
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: CONVERT_LEAD_ACTION.actionName,
      inputPayload: { leadId },
      riskLevel: CONVERT_LEAD_ACTION.riskLevel,
      confirmationRequired: CONVERT_LEAD_ACTION.confirmationRequired,
      result: "error",
      errorMessage: "LEAD_NOT_FOUND",
    });
    return fail(404, "LEAD_NOT_FOUND");
  }

  if (lead.leadStatus === "converted" && lead.convertedClientId) {
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: CONVERT_LEAD_ACTION.actionName,
      inputPayload: { leadId: lead.id },
      riskLevel: CONVERT_LEAD_ACTION.riskLevel,
      confirmationRequired: CONVERT_LEAD_ACTION.confirmationRequired,
      result: "error",
      errorMessage: "UNSUPPORTED_ACTION",
    });
    return fail(409, "UNSUPPORTED_ACTION", "This lead has already been converted.", {
      clientId: lead.convertedClientId,
    });
  }

  const existingClient = lead.email
    ? await prisma.client.findFirst({ where: { companyId: user.companyId, emailPrimary: lead.email } })
    : null;

  const client =
    existingClient ??
    (await prisma.client.create({
      data: {
        companyId: user.companyId,
        displayName: lead.name,
        emailPrimary: lead.email ?? undefined,
        phonePrimary: lead.phone ?? undefined,
        source: `lead:${lead.id}`,
        createdBy: user.id,
      },
    }));

  const updatedLead = await prisma.lead.update({
    where: { id: lead.id },
    data: { leadStatus: "converted", convertedClientId: client.id },
  });

  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: CONVERT_LEAD_ACTION.actionName,
    inputPayload: { leadId: lead.id },
    dataAfter: { lead: updatedLead, client },
    riskLevel: CONVERT_LEAD_ACTION.riskLevel,
    confirmationRequired: CONVERT_LEAD_ACTION.confirmationRequired,
    result: "success",
  });

  return ok(200, { lead: updatedLead, client });
}
