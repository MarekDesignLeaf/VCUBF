import { z } from "zod";
import { prisma } from "../db.js";
import { recordAudit } from "../lib/audit.js";
import { CREATE_CLIENT_ACTION } from "../lib/actionContracts.js";
import type { AuthedUser } from "../middleware/auth.js";
import { fail, ok, type ServiceResult } from "./result.js";

export const createClientSchema = z.object({
  display_name: z.string().min(1, "display_name is required"),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  company_name: z.string().optional(),
  email_primary: z.string().email().optional().or(z.literal("")),
  phone_primary: z.string().optional(),
  client_type: z.string().optional(),
  billing_address_line1: z.string().optional(),
  billing_city: z.string().optional(),
  billing_postcode: z.string().optional(),
  notes: z.string().optional(),
  source: z.string().optional(),
});
export type CreateClientInput = z.infer<typeof createClientSchema>;

export async function listClients(user: AuthedUser) {
  return prisma.client.findMany({
    where: { companyId: user.companyId },
    orderBy: { createdAt: "desc" },
  });
}

export async function searchClients(user: AuthedUser, q: string) {
  if (!q.trim()) return [];
  return prisma.client.findMany({
    where: {
      companyId: user.companyId,
      OR: [
        { displayName: { contains: q, mode: "insensitive" } },
        { emailPrimary: { contains: q, mode: "insensitive" } },
        { phonePrimary: { contains: q, mode: "insensitive" } },
        { companyName: { contains: q, mode: "insensitive" } },
      ],
    },
  });
}

export async function getClient(user: AuthedUser, id: string) {
  return prisma.client.findFirst({ where: { id, companyId: user.companyId } });
}

// create_client — Action Contract driven. Shared by the REST route and the
// Voice/Text Command Layer so the duplicate-check and audit behaviour is
// identical no matter how the request arrived.
export async function createClient(user: AuthedUser, rawInput: unknown): Promise<ServiceResult<unknown>> {
  const parsed = createClientSchema.safeParse(rawInput);
  if (!parsed.success) {
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: CREATE_CLIENT_ACTION.actionName,
      inputPayload: rawInput,
      riskLevel: CREATE_CLIENT_ACTION.riskLevel,
      confirmationRequired: CREATE_CLIENT_ACTION.confirmationRequired,
      result: "error",
      errorMessage: "VALIDATION_FAILED",
    });
    return fail(400, "VALIDATION_FAILED", parsed.error.message);
  }
  const data = parsed.data;

  const duplicate = await prisma.client.findFirst({
    where: {
      companyId: user.companyId,
      OR: [
        data.email_primary ? { emailPrimary: data.email_primary } : undefined,
        data.phone_primary ? { phonePrimary: data.phone_primary, displayName: data.display_name } : undefined,
      ].filter(Boolean) as never,
    },
  });

  if (duplicate) {
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: CREATE_CLIENT_ACTION.actionName,
      inputPayload: data,
      riskLevel: CREATE_CLIENT_ACTION.riskLevel,
      confirmationRequired: true,
      result: "rejected",
      errorMessage: "DUPLICATE_CLIENT_POSSIBLE",
    });
    return fail(409, "DUPLICATE_CLIENT_POSSIBLE", "A client with this email or name+phone already exists.", {
      existingClientId: duplicate.id,
    });
  }

  const client = await prisma.client.create({
    data: {
      companyId: user.companyId,
      displayName: data.display_name,
      firstName: data.first_name,
      lastName: data.last_name,
      companyName: data.company_name,
      emailPrimary: data.email_primary || undefined,
      phonePrimary: data.phone_primary,
      clientType: data.client_type,
      billingLine1: data.billing_address_line1,
      billingCity: data.billing_city,
      billingPostcode: data.billing_postcode,
      notes: data.notes,
      source: data.source ?? "manual",
      createdBy: user.id,
    },
  });

  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: CREATE_CLIENT_ACTION.actionName,
    inputPayload: data,
    dataAfter: client,
    riskLevel: CREATE_CLIENT_ACTION.riskLevel,
    confirmationRequired: CREATE_CLIENT_ACTION.confirmationRequired,
    result: "success",
  });

  return ok(201, client);
}
