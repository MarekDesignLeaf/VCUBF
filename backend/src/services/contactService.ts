import { z } from "zod";
import { prisma } from "../db.js";
import {
  CONTACT_CHANNELS,
  CONTACT_LANGUAGES,
  CONTACT_SOURCES,
  CREATE_CONTACT_ACTION,
  UPDATE_CONTACT_ACTION,
} from "../lib/actionContracts.js";
import { recordAudit } from "../lib/audit.js";
import { normalizeEmail, normalizePhone, phoneNumberSchema } from "../lib/contactNormalization.js";
import type { AuthedUser } from "../middleware/auth.js";
import { fail, ok, type ServiceResult } from "./result.js";

const contactFields = z.object({
  client_id: z.string().uuid().nullable().optional(),
  display_name: z.string().trim().min(1, "display_name is required").max(200),
  job_title: z.string().trim().max(200).optional(),
  department: z.string().trim().max(200).optional(),
  email: z.string().trim().email().max(320).optional(),
  phone: phoneNumberSchema.optional(),
  preferred_channel: z.enum(CONTACT_CHANNELS).optional(),
  preferred_language: z.enum(CONTACT_LANGUAGES).optional(),
  source: z.enum(CONTACT_SOURCES).default("user_input"),
  source_reference: z.string().trim().max(500).optional(),
  notes: z.string().max(5_000).optional(),
});

export const createContactSchema = contactFields.superRefine((data, ctx) => {
  if (!data.email && !data.phone) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "email or phone is required" });
  }
  if (data.source === "communication" && !data.source_reference) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "source_reference is required for communication contacts" });
  }
});

export const updateContactSchema = contactFields
  .partial()
  .extend({
    email: z.string().trim().email().max(320).nullable().optional(),
    phone: phoneNumberSchema.nullable().optional(),
    job_title: z.string().trim().max(200).nullable().optional(),
    department: z.string().trim().max(200).nullable().optional(),
    preferred_channel: z.enum(CONTACT_CHANNELS).nullable().optional(),
    preferred_language: z.enum(CONTACT_LANGUAGES).nullable().optional(),
    source_reference: z.string().trim().max(500).nullable().optional(),
    notes: z.string().max(5_000).nullable().optional(),
    is_active: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, "At least one field is required");

const contactInclude = { client: { select: { id: true, displayName: true } } };

async function auditError(
  user: AuthedUser,
  action: typeof CREATE_CONTACT_ACTION | typeof UPDATE_CONTACT_ACTION,
  inputPayload: unknown,
  errorMessage: string,
  dataBefore?: unknown
) {
  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: action.actionName,
    inputPayload,
    dataBefore,
    riskLevel: action.riskLevel,
    confirmationRequired: action.confirmationRequired,
    result: "error",
    errorMessage,
  });
}

async function findDuplicate(user: AuthedUser, email?: string | null, phone?: string | null, excludeId?: string) {
  const normalizedEmail = normalizeEmail(email);
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedEmail && !normalizedPhone) return null;
  const candidates = await prisma.contact.findMany({
    where: {
      companyId: user.companyId,
      isActive: true,
      ...(excludeId ? { id: { not: excludeId } } : {}),
      OR: [{ email: { not: null } }, { phone: { not: null } }],
    },
    select: { id: true, displayName: true, email: true, phone: true },
  });
  return (
    candidates.find(
      (candidate) =>
        (normalizedEmail && normalizeEmail(candidate.email) === normalizedEmail) ||
        (normalizedPhone && normalizePhone(candidate.phone) === normalizedPhone)
    ) ?? null
  );
}

export interface ContactFilters {
  clientId?: string;
  activeOnly?: boolean;
  search?: string;
}

export async function listContacts(user: AuthedUser, filters: ContactFilters = {}) {
  return prisma.contact.findMany({
    where: {
      companyId: user.companyId,
      ...(filters.clientId ? { clientId: filters.clientId } : {}),
      ...(filters.activeOnly ? { isActive: true } : {}),
      ...(filters.search
        ? {
            OR: [
              { displayName: { contains: filters.search, mode: "insensitive" as const } },
              { email: { contains: filters.search, mode: "insensitive" as const } },
              { phone: { contains: filters.search } },
            ],
          }
        : {}),
    },
    include: contactInclude,
    orderBy: [{ displayName: "asc" }, { createdAt: "desc" }],
  });
}

export async function getContact(user: AuthedUser, id: string) {
  return prisma.contact.findFirst({ where: { id, companyId: user.companyId }, include: contactInclude });
}

export async function createContact(user: AuthedUser, rawInput: unknown): Promise<ServiceResult<unknown>> {
  const parsed = createContactSchema.safeParse(rawInput);
  if (!parsed.success) {
    await auditError(user, CREATE_CONTACT_ACTION, rawInput, "VALIDATION_FAILED");
    return fail(400, "VALIDATION_FAILED", parsed.error.message);
  }
  const input = parsed.data;
  const client = input.client_id
    ? await prisma.client.findFirst({ where: { id: input.client_id, companyId: user.companyId, isActive: true } })
    : null;
  if (input.client_id && !client) {
    await auditError(user, CREATE_CONTACT_ACTION, input, "CLIENT_NOT_FOUND");
    return fail(404, "CLIENT_NOT_FOUND");
  }
  const duplicate = await findDuplicate(user, input.email, input.phone);
  if (duplicate) {
    await auditError(user, CREATE_CONTACT_ACTION, input, "DUPLICATE_CONTACT_POSSIBLE");
    return fail(409, "DUPLICATE_CONTACT_POSSIBLE", "An active contact already uses this email or phone.", {
      possibleDuplicate: duplicate,
    });
  }
  const created = await prisma.contact.create({
    data: {
      companyId: user.companyId,
      clientId: input.client_id,
      displayName: input.display_name,
      jobTitle: input.job_title,
      department: input.department,
      email: input.email,
      phone: input.phone,
      preferredChannel: input.preferred_channel,
      preferredLanguage: input.preferred_language,
      source: input.source,
      sourceReference: input.source_reference,
      notes: input.notes,
      createdBy: user.id,
    },
    include: contactInclude,
  });
  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: CREATE_CONTACT_ACTION.actionName,
    inputPayload: input,
    dataAfter: created,
    riskLevel: CREATE_CONTACT_ACTION.riskLevel,
    confirmationRequired: CREATE_CONTACT_ACTION.confirmationRequired,
    result: "success",
  });
  return ok(201, created);
}

export async function updateContact(user: AuthedUser, id: string, rawInput: unknown): Promise<ServiceResult<unknown>> {
  const parsed = updateContactSchema.safeParse(rawInput);
  if (!parsed.success) {
    await auditError(user, UPDATE_CONTACT_ACTION, { id, input: rawInput }, "VALIDATION_FAILED");
    return fail(400, "VALIDATION_FAILED", parsed.error.message);
  }
  const input = parsed.data;
  const existing = await prisma.contact.findFirst({ where: { id, companyId: user.companyId } });
  if (!existing) {
    await auditError(user, UPDATE_CONTACT_ACTION, { id, ...input }, "CONTACT_NOT_FOUND");
    return fail(404, "CONTACT_NOT_FOUND");
  }
  if (input.client_id) {
    const client = await prisma.client.findFirst({
      where: { id: input.client_id, companyId: user.companyId, isActive: true },
    });
    if (!client) {
      await auditError(user, UPDATE_CONTACT_ACTION, { id, ...input }, "CLIENT_NOT_FOUND", existing);
      return fail(404, "CLIENT_NOT_FOUND");
    }
  }
  const finalEmail = input.email !== undefined ? input.email : existing.email;
  const finalPhone = input.phone !== undefined ? input.phone : existing.phone;
  if (!finalEmail && !finalPhone) {
    await auditError(user, UPDATE_CONTACT_ACTION, { id, ...input }, "VALIDATION_FAILED", existing);
    return fail(400, "VALIDATION_FAILED", "email or phone is required");
  }
  const finalSource = input.source ?? existing.source;
  const finalSourceReference = input.source_reference !== undefined ? input.source_reference : existing.sourceReference;
  if (finalSource === "communication" && !finalSourceReference) {
    await auditError(user, UPDATE_CONTACT_ACTION, { id, ...input }, "VALIDATION_FAILED", existing);
    return fail(400, "VALIDATION_FAILED", "source_reference is required for communication contacts");
  }
  const duplicate = await findDuplicate(user, finalEmail, finalPhone, existing.id);
  if (duplicate) {
    await auditError(user, UPDATE_CONTACT_ACTION, { id, ...input }, "DUPLICATE_CONTACT_POSSIBLE", existing);
    return fail(409, "DUPLICATE_CONTACT_POSSIBLE", "An active contact already uses this email or phone.", {
      possibleDuplicate: duplicate,
    });
  }
  const changes: Record<string, unknown> = {};
  const mapping: Record<string, string> = {
    client_id: "clientId", display_name: "displayName", job_title: "jobTitle", department: "department",
    email: "email", phone: "phone", preferred_channel: "preferredChannel",
    preferred_language: "preferredLanguage", source: "source", source_reference: "sourceReference",
    notes: "notes", is_active: "isActive",
  };
  for (const [inputKey, dbKey] of Object.entries(mapping)) {
    if (Object.prototype.hasOwnProperty.call(input, inputKey)) changes[dbKey] = input[inputKey as keyof typeof input];
  }
  const updated = await prisma.contact.update({ where: { id: existing.id }, data: changes, include: contactInclude });
  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: UPDATE_CONTACT_ACTION.actionName,
    inputPayload: { id, changes },
    dataBefore: existing,
    dataAfter: updated,
    riskLevel: UPDATE_CONTACT_ACTION.riskLevel,
    confirmationRequired: UPDATE_CONTACT_ACTION.confirmationRequired,
    result: "success",
  });
  return ok(200, updated);
}
