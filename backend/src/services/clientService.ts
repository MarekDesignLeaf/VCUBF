import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../db.js";
import { recordAudit } from "../lib/audit.js";
import { ARCHIVE_CLIENT_ACTION, CREATE_CLIENT_ACTION, UPDATE_CLIENT_ACTION, type ActionContract } from "../lib/actionContracts.js";
import { normalizeEmail, phoneNumberSchema } from "../lib/contactNormalization.js";
import type { AuthedUser } from "../middleware/auth.js";
import { fail, ok, type ServiceResult } from "./result.js";

type FailureResult = Extract<ServiceResult<never>, { ok: false }>;

const displayNameSchema = z.string().trim().min(1, "display_name is required").max(200);
const optionalEmailSchema = z.union([
  z.string().trim().email("Enter a valid email address").max(254).transform((email) => normalizeEmail(email)!),
  z.literal("").transform(() => null),
]).optional();
const optionalPhoneSchema = z.union([phoneNumberSchema, z.literal("").transform(() => null)]).optional();
const optionalText = (max: number) => z.union([
  z.string().trim().min(1).max(max),
  z.literal("").transform(() => null),
]).optional();

export const createClientSchema = z.object({
  display_name: displayNameSchema,
  first_name: optionalText(100),
  last_name: optionalText(100),
  company_name: optionalText(200),
  email_primary: optionalEmailSchema,
  phone_primary: optionalPhoneSchema,
  client_type: optionalText(100),
  billing_address_line1: optionalText(500),
  billing_city: optionalText(200),
  billing_postcode: optionalText(40),
  notes: optionalText(10_000),
  source: optionalText(200),
});
export type CreateClientInput = z.infer<typeof createClientSchema>;

export const updateClientSchema = z.object({
  display_name: displayNameSchema.optional(),
  first_name: optionalText(100),
  last_name: optionalText(100),
  company_name: optionalText(200),
  email_primary: optionalEmailSchema,
  phone_primary: optionalPhoneSchema,
  client_type: optionalText(100),
  billing_address_line1: optionalText(500),
  billing_city: optionalText(200),
  billing_postcode: optionalText(40),
  notes: optionalText(10_000),
}).refine((data) => Object.keys(data).length > 0, "At least one client field is required");

const archiveClientSchema = z.object({ confirmed: z.boolean().optional() });
const pendingArchivePayloadSchema = z.object({ clientId: z.string().uuid(), displayName: z.string().min(1) });
const PENDING_CLIENT_ARCHIVE = "archive_client";
const PENDING_CLIENT_ARCHIVE_LIFETIME_MS = 5 * 60 * 1000;

function canManageClients(user: AuthedUser) {
  return user.permissions.includes("crm.manage");
}

async function auditFailure(
  user: AuthedUser,
  action: Pick<ActionContract, "actionName" | "riskLevel" | "confirmationRequired">,
  inputPayload: unknown,
  errorMessage: string,
  result: "error" | "rejected" = "error"
) {
  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: action.actionName,
    inputPayload,
    riskLevel: action.riskLevel,
    confirmationRequired: action.confirmationRequired,
    result,
    errorMessage,
  });
}

async function findIdentityConflict(
  user: AuthedUser,
  data: { display_name: string; email_primary?: string | null; phone_primary?: string | null },
  excludeClientId?: string
): Promise<FailureResult | null> {
  if (data.email_primary) {
    const matchingUser = await prisma.user.findFirst({
      where: { companyId: user.companyId, isActive: true, email: { equals: data.email_primary, mode: "insensitive" } },
      select: { id: true, displayName: true },
    });
    if (matchingUser) {
      return fail(409, "EMAIL_BELONGS_TO_USER", "This email belongs to an application user and cannot also identify a client.", {
        userId: matchingUser.id,
        userDisplayName: matchingUser.displayName,
      });
    }
  }

  const duplicate = await prisma.client.findFirst({
    where: {
      companyId: user.companyId,
      isActive: true,
      ...(excludeClientId ? { id: { not: excludeClientId } } : {}),
      OR: [
        data.email_primary ? { emailPrimary: { equals: data.email_primary, mode: "insensitive" as const } } : undefined,
        data.phone_primary
          ? { phonePrimary: data.phone_primary, displayName: { equals: data.display_name, mode: "insensitive" as const } }
          : undefined,
      ].filter(Boolean) as never,
    },
    select: { id: true, displayName: true },
  });
  return duplicate
    ? fail(409, "DUPLICATE_CLIENT_POSSIBLE", "An active client with this email or name and phone already exists.", {
        existingClientId: duplicate.id,
        existingClientName: duplicate.displayName,
      })
    : null;
}

export async function listClients(user: AuthedUser) {
  return prisma.client.findMany({
    where: { companyId: user.companyId, isActive: true },
    orderBy: { createdAt: "desc" },
  });
}

export async function searchClients(user: AuthedUser, q: string) {
  if (!q.trim()) return [];
  return prisma.client.findMany({
    where: {
      companyId: user.companyId,
      isActive: true,
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
  return prisma.client.findFirst({ where: { id, companyId: user.companyId, isActive: true } });
}

export async function findClientsByName(user: AuthedUser, name: string) {
  const trimmed = name.trim();
  if (!trimmed) return [];
  const matches = await prisma.client.findMany({
    where: { companyId: user.companyId, isActive: true, displayName: { contains: trimmed, mode: "insensitive" } },
    orderBy: { createdAt: "desc" },
  });
  const exact = matches.filter((client) => client.displayName.localeCompare(trimmed, undefined, { sensitivity: "accent" }) === 0);
  return exact.length === 1 ? exact : matches;
}

// create_client — Action Contract driven. Shared by the REST route and the
// Voice/Text Command Layer so the duplicate-check and audit behaviour is
// identical no matter how the request arrived.
export async function createClient(user: AuthedUser, rawInput: unknown): Promise<ServiceResult<unknown>> {
  if (!canManageClients(user)) {
    await auditFailure(user, CREATE_CLIENT_ACTION, rawInput, "MISSING_PERMISSION");
    return fail(403, "MISSING_PERMISSION", "CRM management permission is required to create clients.");
  }
  const parsed = createClientSchema.safeParse(rawInput);
  if (!parsed.success) {
    await auditFailure(user, CREATE_CLIENT_ACTION, rawInput, "VALIDATION_FAILED");
    return fail(400, "VALIDATION_FAILED", parsed.error.message);
  }
  const data = parsed.data;

  const conflict = await findIdentityConflict(user, data);
  if (conflict) {
    await auditFailure(user, CREATE_CLIENT_ACTION, data, conflict.error, "rejected");
    return conflict;
  }

  const client = await prisma.client.create({
    data: {
      companyId: user.companyId,
      displayName: data.display_name,
      firstName: data.first_name,
      lastName: data.last_name,
      companyName: data.company_name,
      emailPrimary: data.email_primary,
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

export async function updateClient(user: AuthedUser, id: string, rawInput: unknown): Promise<ServiceResult<unknown>> {
  if (!canManageClients(user)) {
    await auditFailure(user, UPDATE_CLIENT_ACTION, { id, input: rawInput }, "MISSING_PERMISSION");
    return fail(403, "MISSING_PERMISSION", "CRM management permission is required to edit clients.");
  }
  const parsed = updateClientSchema.safeParse(rawInput);
  if (!parsed.success) {
    await auditFailure(user, UPDATE_CLIENT_ACTION, { id, input: rawInput }, "VALIDATION_FAILED");
    return fail(400, "VALIDATION_FAILED", parsed.error.message);
  }
  const existing = await prisma.client.findFirst({ where: { id, companyId: user.companyId, isActive: true } });
  if (!existing) {
    await auditFailure(user, UPDATE_CLIENT_ACTION, { id, input: parsed.data }, "CLIENT_NOT_FOUND");
    return fail(404, "CLIENT_NOT_FOUND", "The active client was not found.");
  }

  const data = parsed.data;
  const identity = {
    display_name: data.display_name ?? existing.displayName,
    email_primary: data.email_primary === undefined ? existing.emailPrimary : data.email_primary,
    phone_primary: data.phone_primary === undefined ? existing.phonePrimary : data.phone_primary,
  };
  const conflict = await findIdentityConflict(user, identity, existing.id);
  if (conflict) {
    await auditFailure(user, UPDATE_CLIENT_ACTION, { id, input: data }, conflict.error, "rejected");
    return conflict;
  }

  const updateData: Prisma.ClientUpdateInput = {};
  if (data.display_name !== undefined) updateData.displayName = data.display_name;
  if (data.first_name !== undefined) updateData.firstName = data.first_name;
  if (data.last_name !== undefined) updateData.lastName = data.last_name;
  if (data.company_name !== undefined) updateData.companyName = data.company_name;
  if (data.email_primary !== undefined) updateData.emailPrimary = data.email_primary;
  if (data.phone_primary !== undefined) updateData.phonePrimary = data.phone_primary;
  if (data.client_type !== undefined) updateData.clientType = data.client_type;
  if (data.billing_address_line1 !== undefined) updateData.billingLine1 = data.billing_address_line1;
  if (data.billing_city !== undefined) updateData.billingCity = data.billing_city;
  if (data.billing_postcode !== undefined) updateData.billingPostcode = data.billing_postcode;
  if (data.notes !== undefined) updateData.notes = data.notes;

  const updated = await prisma.client.update({ where: { id: existing.id }, data: updateData });
  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: UPDATE_CLIENT_ACTION.actionName,
    inputPayload: data,
    dataBefore: existing,
    dataAfter: updated,
    riskLevel: UPDATE_CLIENT_ACTION.riskLevel,
    confirmationRequired: false,
    result: "success",
  });
  return ok(200, updated);
}

export async function archiveClient(user: AuthedUser, id: string, rawInput: unknown): Promise<ServiceResult<unknown>> {
  if (!canManageClients(user)) {
    await auditFailure(user, ARCHIVE_CLIENT_ACTION, { id, input: rawInput }, "MISSING_PERMISSION");
    return fail(403, "MISSING_PERMISSION", "CRM management permission is required to archive clients.");
  }
  const parsed = archiveClientSchema.safeParse(rawInput);
  if (!parsed.success) {
    await auditFailure(user, ARCHIVE_CLIENT_ACTION, { id, input: rawInput }, "VALIDATION_FAILED");
    return fail(400, "VALIDATION_FAILED", parsed.error.message);
  }
  const existing = await prisma.client.findFirst({
    where: { id, companyId: user.companyId, isActive: true },
    include: { _count: { select: { jobs: true, quotes: true, invoices: true, communicationRecords: true, contacts: true } } },
  });
  if (!existing) {
    await auditFailure(user, ARCHIVE_CLIENT_ACTION, { id }, "CLIENT_NOT_FOUND");
    return fail(404, "CLIENT_NOT_FOUND", "The active client was not found.");
  }

  const preview = { clientId: existing.id, displayName: existing.displayName, preservedRecords: existing._count };
  if (!parsed.data.confirmed) {
    await auditFailure(user, ARCHIVE_CLIENT_ACTION, { id }, "CONFIRMATION_REQUIRED", "rejected");
    return fail(409, "CONFIRMATION_REQUIRED", "Confirm archiving this client. Related records will be preserved.", { preview });
  }

  const archived = await prisma.client.update({ where: { id: existing.id }, data: { isActive: false } });
  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: ARCHIVE_CLIENT_ACTION.actionName,
    inputPayload: { id },
    dataBefore: existing,
    dataAfter: archived,
    riskLevel: ARCHIVE_CLIENT_ACTION.riskLevel,
    confirmationRequired: true,
    confirmed: true,
    result: "success",
  });
  return ok(200, { client: archived, preservedRecords: existing._count, message: `${existing.displayName} was archived. Related records were preserved.` });
}

async function expirePendingClientArchives(user: AuthedUser, now = new Date()) {
  await prisma.voicePendingAction.updateMany({
    where: { companyId: user.companyId, userId: user.id, actionType: PENDING_CLIENT_ARCHIVE, status: "pending", expiresAt: { lte: now } },
    data: { status: "expired", payload: Prisma.DbNull, resolvedAt: now },
  });
}

export async function prepareVoiceClientArchive(user: AuthedUser, clientName: string): Promise<ServiceResult<unknown>> {
  const matches = await findClientsByName(user, clientName);
  if (matches.length === 0) return fail(404, "CLIENT_NOT_FOUND", `No active client matches "${clientName}".`);
  if (matches.length > 1) {
    return fail(409, "AMBIGUOUS_REFERENCE", `Multiple active clients match "${clientName}". Say the full name.`, {
      matches: matches.map((client) => ({ id: client.id, displayName: client.displayName })),
    });
  }
  const previewResult = await archiveClient(user, matches[0].id, { confirmed: false });
  if (previewResult.ok || previewResult.error !== "CONFIRMATION_REQUIRED") return previewResult;

  const now = new Date();
  const expiresAt = new Date(now.getTime() + PENDING_CLIENT_ARCHIVE_LIFETIME_MS);
  await prisma.$transaction(async (tx) => {
    await tx.voicePendingAction.updateMany({
      where: { companyId: user.companyId, userId: user.id, actionType: PENDING_CLIENT_ARCHIVE, status: "pending" },
      data: { status: "cancelled", payload: Prisma.DbNull, resolvedAt: now },
    });
    await tx.voicePendingAction.create({
      data: {
        companyId: user.companyId,
        userId: user.id,
        actionType: PENDING_CLIENT_ARCHIVE,
        payload: { clientId: matches[0].id, displayName: matches[0].displayName },
        expiresAt,
      },
    });
  });
  return ok(202, {
    confirmationRequired: true,
    expiresAt: expiresAt.toISOString(),
    preview: previewResult.extra?.preview,
    message: `Archive ${matches[0].displayName}? Jobs, quotes, invoices, contacts and communication history will remain stored. Say confirm client deletion or cancel client deletion.`,
  });
}

export async function confirmVoiceClientArchive(user: AuthedUser): Promise<ServiceResult<unknown>> {
  const now = new Date();
  await expirePendingClientArchives(user, now);
  const pending = await prisma.voicePendingAction.findFirst({
    where: { companyId: user.companyId, userId: user.id, actionType: PENDING_CLIENT_ARCHIVE, status: "pending", expiresAt: { gt: now } },
    orderBy: { createdAt: "desc" },
  });
  if (!pending) return fail(409, "NO_PENDING_CLIENT_ARCHIVE", "There is no client deletion waiting for confirmation.");
  const payload = pendingArchivePayloadSchema.safeParse(pending.payload);
  if (!payload.success) {
    await prisma.voicePendingAction.update({ where: { id: pending.id }, data: { status: "failed", payload: Prisma.DbNull, resolvedAt: now } });
    return fail(409, "PENDING_CLIENT_ARCHIVE_INVALID", "The reviewed client deletion is no longer valid. Start it again.");
  }
  const claimed = await prisma.voicePendingAction.updateMany({
    where: { id: pending.id, status: "pending", expiresAt: { gt: now } },
    data: { status: "archiving" },
  });
  if (!claimed.count) return fail(409, "NO_PENDING_CLIENT_ARCHIVE", "That client deletion is no longer awaiting confirmation.");

  const result = await archiveClient(user, payload.data.clientId, { confirmed: true });
  await prisma.voicePendingAction.update({
    where: { id: pending.id },
    data: { status: result.ok ? "completed" : "failed", payload: Prisma.DbNull, resolvedAt: new Date() },
  });
  return result;
}

export async function cancelVoiceClientArchive(user: AuthedUser): Promise<ServiceResult<unknown>> {
  const now = new Date();
  await expirePendingClientArchives(user, now);
  const cancelled = await prisma.voicePendingAction.updateMany({
    where: { companyId: user.companyId, userId: user.id, actionType: PENDING_CLIENT_ARCHIVE, status: "pending" },
    data: { status: "cancelled", payload: Prisma.DbNull, resolvedAt: now },
  });
  return cancelled.count
    ? ok(200, { message: "Client deletion was cancelled. Nothing was changed." })
    : fail(409, "NO_PENDING_CLIENT_ARCHIVE", "There is no client deletion waiting to be cancelled.");
}
