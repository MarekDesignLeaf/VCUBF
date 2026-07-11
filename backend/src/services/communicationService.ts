import { z } from "zod";
import { prisma } from "../db.js";
import { recordAudit } from "../lib/audit.js";
import {
  CREATE_CLIENT_FROM_COMMUNICATION_ACTION,
  CREATE_COMMUNICATION_RECORD_ACTION,
  EXTRACT_COMMUNICATION_INTAKE_ACTION,
  LOG_COMMUNICATION_INTAKE_ACTION,
  PREPARE_COMMUNICATION_REPLY_ACTION,
  UPDATE_COMMUNICATION_RECORD_ACTION,
  COMMUNICATION_CHANNELS,
  COMMUNICATION_DIRECTIONS,
} from "../lib/actionContracts.js";
import type { ActionContract } from "../lib/actionContracts.js";
import { normalizeEmail, normalizeName, normalizePhone } from "../lib/contactNormalization.js";
import type { AuthedUser } from "../middleware/auth.js";
import { fail, ok, type ServiceResult } from "./result.js";

// Communication Log Module — the manual-entry foundation of the
// Communication Intelligence Module. Every field is exactly what the user
// typed in: who was contacted, what was discussed or promised, and when it
// happened (not necessarily "now" — a call from yesterday can be logged
// today). There is no email/WhatsApp/SMS connector yet, so nothing here is
// auto-extracted; this table and its CRM linkage (client, optional job) are
// designed so a future automated extraction workflow can write into the
// same structure instead of creating a second, disconnected record type.

export const createCommunicationRecordSchema = z.object({
  client_id: z.string().uuid(),
  job_id: z.string().uuid().optional(),
  channel: z.enum(COMMUNICATION_CHANNELS),
  direction: z.enum(COMMUNICATION_DIRECTIONS),
  summary: z.string().min(1, "summary is required"),
  full_text: z.string().optional(),
  occurred_at: z.string().datetime(),
  follow_up_needed: z.boolean().default(false),
  follow_up_due_at: z.string().datetime().optional(),
});

export const updateCommunicationRecordSchema = z.object({
  channel: z.enum(COMMUNICATION_CHANNELS).optional(),
  direction: z.enum(COMMUNICATION_DIRECTIONS).optional(),
  summary: z.string().min(1).optional(),
  full_text: z.string().optional(),
  occurred_at: z.string().datetime().optional(),
  follow_up_needed: z.boolean().optional(),
  follow_up_due_at: z.string().datetime().nullable().optional(),
});

export const createCommunicationIntakeSchema = z.object({
  channel: z.enum(COMMUNICATION_CHANNELS),
  sender_name: z.string().max(200).optional(),
  sender_email: z.string().email().optional().or(z.literal("")),
  sender_phone: z.string().max(100).optional(),
  message_text: z.string().min(1, "message_text is required"),
  received_at: z.string().datetime(),
  source_reference: z.string().max(2000).optional(),
});

export const convertCommunicationIntakeSchema = z.object({
  client_id: z.string().uuid().optional(),
  confirmed: z.boolean().optional(),
});

type MatchReason = "email_match" | "phone_match" | "name_match";

interface CommunicationExtraction {
  name: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  postcode: string | null;
  serviceMatches: Array<{ id: string; name: string }>;
  existingClientMatches: Array<{ id: string; displayName: string; reasons: MatchReason[] }>;
  identityConfidence: "exact_contact_match" | "new_contact" | "uncertain";
  missingFields: string[];
}

const intakeInclude = {
  client: { select: { id: true, displayName: true } },
  communicationRecord: { select: { id: true, summary: true } },
};

const EMAIL_IN_TEXT = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const PHONE_IN_TEXT = /(?:\+44\s?(?:\(0\)\s?)?|0)(?:\d[\s().-]?){9,10}\d/;
const UK_POSTCODE = /\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/i;
const LABELLED_NAME = /(?:^|\n)\s*name\s*:\s*([A-Z][A-Z' -]{1,79})(?=\r?$|\n)/im;
const LABELLED_ADDRESS = /(?:^|\n)\s*address\s*:\s*([^\r\n]{3,250})/im;

function cleanOptional(value: string | null | undefined): string | null {
  const cleaned = value?.trim();
  return cleaned ? cleaned : null;
}

async function auditIntakeFailure(
  user: AuthedUser,
  action: ActionContract,
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

async function buildExtraction(companyId: string, intake: {
  senderName: string | null;
  senderEmail: string | null;
  senderPhone: string | null;
  messageText: string;
}): Promise<CommunicationExtraction> {
  const [services, clients] = await Promise.all([
    prisma.serviceCatalogueItem.findMany({
      where: { companyId, isActive: true },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    prisma.client.findMany({
      where: { companyId, isActive: true },
      select: { id: true, displayName: true, emailPrimary: true, phonePrimary: true },
      orderBy: { displayName: "asc" },
    }),
  ]);

  const name = cleanOptional(intake.senderName) ?? cleanOptional(intake.messageText.match(LABELLED_NAME)?.[1]);
  const email = cleanOptional(intake.senderEmail) ?? cleanOptional(intake.messageText.match(EMAIL_IN_TEXT)?.[0]);
  const phone = cleanOptional(intake.senderPhone) ?? cleanOptional(intake.messageText.match(PHONE_IN_TEXT)?.[0]);
  const address = cleanOptional(intake.messageText.match(LABELLED_ADDRESS)?.[1]);
  const postcode = cleanOptional(address?.match(UK_POSTCODE)?.[1] ?? intake.messageText.match(UK_POSTCODE)?.[1]);
  const messageLower = intake.messageText.toLowerCase();
  const serviceMatches = services.filter((service) => messageLower.includes(service.name.trim().toLowerCase()));

  const normalEmail = normalizeEmail(email);
  const normalPhone = normalizePhone(phone);
  const normalSenderName = normalizeName(name);
  const existingClientMatches = clients.flatMap((client) => {
    const reasons: MatchReason[] = [];
    if (normalEmail && normalizeEmail(client.emailPrimary) === normalEmail) reasons.push("email_match");
    if (normalPhone && normalizePhone(client.phonePrimary) === normalPhone) reasons.push("phone_match");
    if (normalSenderName && normalizeName(client.displayName) === normalSenderName) reasons.push("name_match");
    return reasons.length > 0 ? [{ id: client.id, displayName: client.displayName, reasons }] : [];
  });

  const exactContactMatches = existingClientMatches.filter((match) =>
    match.reasons.some((reason) => reason === "email_match" || reason === "phone_match")
  );
  const identityConfidence =
    exactContactMatches.length === 1
      ? "exact_contact_match"
      : existingClientMatches.length === 0 && Boolean(name && (email || phone))
        ? "new_contact"
        : "uncertain";
  const missingFields: string[] = [];
  if (!name) missingFields.push("name");
  if (!email && !phone) missingFields.push("email_or_phone");
  if (!address) missingFields.push("address");
  if (serviceMatches.length === 0) missingFields.push("service");

  return {
    name,
    email,
    phone,
    address,
    postcode,
    serviceMatches,
    existingClientMatches,
    identityConfidence,
    missingFields,
  };
}

const communicationRecordInclude = {
  client: { select: { id: true, displayName: true } },
  job: { select: { id: true, jobTitle: true } },
};

export async function listCommunicationRecords(
  user: AuthedUser,
  filters: { clientId?: string; jobId?: string; channel?: string; followUpNeeded?: boolean } = {}
) {
  return prisma.communicationRecord.findMany({
    where: {
      companyId: user.companyId,
      ...(filters.clientId ? { clientId: filters.clientId } : {}),
      ...(filters.jobId ? { jobId: filters.jobId } : {}),
      ...(filters.channel ? { channel: filters.channel } : {}),
      ...(filters.followUpNeeded !== undefined ? { followUpNeeded: filters.followUpNeeded } : {}),
    },
    include: communicationRecordInclude,
    orderBy: { occurredAt: "desc" },
  });
}

export async function getCommunicationRecord(user: AuthedUser, id: string) {
  return prisma.communicationRecord.findFirst({
    where: { id, companyId: user.companyId },
    include: communicationRecordInclude,
  });
}

// Follow-ups due: company-scoped records where follow_up_needed is true and
// either there is no due date yet (so it never silently falls off a list
// just because a date wasn't entered) or the due date has already arrived.
export async function listFollowUpsDue(user: AuthedUser) {
  const now = new Date();
  return prisma.communicationRecord.findMany({
    where: {
      companyId: user.companyId,
      followUpNeeded: true,
      OR: [{ followUpDueAt: null }, { followUpDueAt: { lte: now } }],
    },
    include: communicationRecordInclude,
    orderBy: [{ followUpDueAt: "asc" }, { occurredAt: "desc" }],
  });
}

// log_communication — Action Contract driven.
export async function createCommunicationRecord(user: AuthedUser, rawInput: unknown): Promise<ServiceResult<unknown>> {
  const parsed = createCommunicationRecordSchema.safeParse(rawInput);
  if (!parsed.success) {
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: CREATE_COMMUNICATION_RECORD_ACTION.actionName,
      inputPayload: rawInput,
      riskLevel: CREATE_COMMUNICATION_RECORD_ACTION.riskLevel,
      confirmationRequired: CREATE_COMMUNICATION_RECORD_ACTION.confirmationRequired,
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
      actionName: CREATE_COMMUNICATION_RECORD_ACTION.actionName,
      inputPayload: data,
      riskLevel: CREATE_COMMUNICATION_RECORD_ACTION.riskLevel,
      confirmationRequired: CREATE_COMMUNICATION_RECORD_ACTION.confirmationRequired,
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
        actionName: CREATE_COMMUNICATION_RECORD_ACTION.actionName,
        inputPayload: data,
        riskLevel: CREATE_COMMUNICATION_RECORD_ACTION.riskLevel,
        confirmationRequired: CREATE_COMMUNICATION_RECORD_ACTION.confirmationRequired,
        result: "error",
        errorMessage: "JOB_NOT_FOUND",
      });
      return fail(404, "JOB_NOT_FOUND");
    }
  }

  const created = await prisma.communicationRecord.create({
    data: {
      companyId: user.companyId,
      clientId: data.client_id,
      jobId: data.job_id,
      channel: data.channel,
      direction: data.direction,
      summary: data.summary,
      fullText: data.full_text,
      occurredAt: new Date(data.occurred_at),
      followUpNeeded: data.follow_up_needed,
      followUpDueAt: data.follow_up_due_at ? new Date(data.follow_up_due_at) : undefined,
      createdBy: user.id,
    },
    include: communicationRecordInclude,
  });

  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: CREATE_COMMUNICATION_RECORD_ACTION.actionName,
    inputPayload: data,
    dataAfter: created,
    riskLevel: CREATE_COMMUNICATION_RECORD_ACTION.riskLevel,
    confirmationRequired: CREATE_COMMUNICATION_RECORD_ACTION.confirmationRequired,
    result: "success",
  });

  return ok(201, created);
}

// update_communication_record — Action Contract driven.
export async function updateCommunicationRecord(
  user: AuthedUser,
  id: string,
  rawInput: unknown
): Promise<ServiceResult<unknown>> {
  const parsed = updateCommunicationRecordSchema.safeParse(rawInput);
  if (!parsed.success) {
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: UPDATE_COMMUNICATION_RECORD_ACTION.actionName,
      inputPayload: { id, ...(typeof rawInput === "object" && rawInput ? rawInput : {}) },
      riskLevel: UPDATE_COMMUNICATION_RECORD_ACTION.riskLevel,
      confirmationRequired: UPDATE_COMMUNICATION_RECORD_ACTION.confirmationRequired,
      result: "error",
      errorMessage: "VALIDATION_FAILED",
    });
    return fail(400, "VALIDATION_FAILED", parsed.error.message);
  }
  const data = parsed.data;

  const existing = await prisma.communicationRecord.findFirst({ where: { id, companyId: user.companyId } });
  if (!existing) {
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: UPDATE_COMMUNICATION_RECORD_ACTION.actionName,
      inputPayload: { id, ...data },
      riskLevel: UPDATE_COMMUNICATION_RECORD_ACTION.riskLevel,
      confirmationRequired: UPDATE_COMMUNICATION_RECORD_ACTION.confirmationRequired,
      result: "error",
      errorMessage: "COMMUNICATION_RECORD_NOT_FOUND",
    });
    return fail(404, "COMMUNICATION_RECORD_NOT_FOUND");
  }

  const changes: Record<string, unknown> = {};
  if (data.channel !== undefined) changes.channel = data.channel;
  if (data.direction !== undefined) changes.direction = data.direction;
  if (data.summary !== undefined) changes.summary = data.summary;
  if (data.full_text !== undefined) changes.fullText = data.full_text;
  if (data.occurred_at !== undefined) changes.occurredAt = new Date(data.occurred_at);
  if (data.follow_up_needed !== undefined) changes.followUpNeeded = data.follow_up_needed;
  if (data.follow_up_due_at !== undefined) {
    changes.followUpDueAt = data.follow_up_due_at ? new Date(data.follow_up_due_at) : null;
  }

  const updated = await prisma.communicationRecord.update({
    where: { id: existing.id },
    data: changes,
    include: communicationRecordInclude,
  });

  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: UPDATE_COMMUNICATION_RECORD_ACTION.actionName,
    inputPayload: { id, changes },
    dataBefore: existing,
    dataAfter: updated,
    riskLevel: UPDATE_COMMUNICATION_RECORD_ACTION.riskLevel,
    confirmationRequired: UPDATE_COMMUNICATION_RECORD_ACTION.confirmationRequired,
    result: "success",
  });

  return ok(200, updated);
}

export async function listCommunicationIntakes(user: AuthedUser, status?: string) {
  return prisma.communicationIntake.findMany({
    where: { companyId: user.companyId, ...(status ? { intakeStatus: status } : {}) },
    include: intakeInclude,
    orderBy: { receivedAt: "desc" },
  });
}

export async function getCommunicationIntake(user: AuthedUser, id: string) {
  return prisma.communicationIntake.findFirst({
    where: { id, companyId: user.companyId },
    include: intakeInclude,
  });
}

export async function createCommunicationIntake(
  user: AuthedUser,
  rawInput: unknown
): Promise<ServiceResult<unknown>> {
  const parsed = createCommunicationIntakeSchema.safeParse(rawInput);
  if (!parsed.success) {
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: LOG_COMMUNICATION_INTAKE_ACTION.actionName,
      inputPayload: rawInput,
      riskLevel: LOG_COMMUNICATION_INTAKE_ACTION.riskLevel,
      confirmationRequired: LOG_COMMUNICATION_INTAKE_ACTION.confirmationRequired,
      result: "error",
      errorMessage: "VALIDATION_FAILED",
    });
    return fail(400, "VALIDATION_FAILED", parsed.error.message);
  }
  const data = parsed.data;
  const created = await prisma.communicationIntake.create({
    data: {
      companyId: user.companyId,
      channel: data.channel,
      senderName: cleanOptional(data.sender_name),
      senderEmail: cleanOptional(data.sender_email),
      senderPhone: cleanOptional(data.sender_phone),
      messageText: data.message_text,
      receivedAt: new Date(data.received_at),
      sourceReference: cleanOptional(data.source_reference),
      createdBy: user.id,
    },
    include: intakeInclude,
  });
  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: LOG_COMMUNICATION_INTAKE_ACTION.actionName,
    inputPayload: data,
    dataAfter: created,
    riskLevel: LOG_COMMUNICATION_INTAKE_ACTION.riskLevel,
    confirmationRequired: LOG_COMMUNICATION_INTAKE_ACTION.confirmationRequired,
    result: "success",
  });
  return ok(201, created);
}

export async function extractCommunicationIntake(
  user: AuthedUser,
  id: string
): Promise<ServiceResult<unknown>> {
  const intake = await prisma.communicationIntake.findFirst({ where: { id, companyId: user.companyId } });
  if (!intake) {
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: EXTRACT_COMMUNICATION_INTAKE_ACTION.actionName,
      inputPayload: { id },
      riskLevel: EXTRACT_COMMUNICATION_INTAKE_ACTION.riskLevel,
      result: "error",
      errorMessage: "COMMUNICATION_INTAKE_NOT_FOUND",
    });
    return fail(404, "COMMUNICATION_INTAKE_NOT_FOUND");
  }
  if (intake.intakeStatus === "converted") {
    await auditIntakeFailure(user, EXTRACT_COMMUNICATION_INTAKE_ACTION, { id }, "UNSUPPORTED_ACTION", "rejected");
    return fail(409, "UNSUPPORTED_ACTION", "A converted intake cannot be extracted again.");
  }

  const extraction = await buildExtraction(user.companyId, intake);
  const updated = await prisma.communicationIntake.update({
    where: { id: intake.id },
    data: { intakeStatus: "extracted", extractedData: extraction as never },
    include: intakeInclude,
  });
  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: EXTRACT_COMMUNICATION_INTAKE_ACTION.actionName,
    inputPayload: { id },
    dataBefore: { intakeStatus: intake.intakeStatus, extractedData: intake.extractedData },
    dataAfter: { intakeStatus: updated.intakeStatus, extractedData: extraction },
    riskLevel: EXTRACT_COMMUNICATION_INTAKE_ACTION.riskLevel,
    result: "success",
  });
  return ok(200, updated);
}

function buildCommunicationSummary(intake: { channel: string }, extraction: CommunicationExtraction): string {
  const subject = extraction.serviceMatches.length > 0
    ? extraction.serviceMatches.map((service) => service.name).join(", ")
    : "General";
  return `${subject} enquiry via ${intake.channel.replace(/_/g, " ")}`;
}

export async function convertCommunicationIntake(
  user: AuthedUser,
  id: string,
  rawInput: unknown
): Promise<ServiceResult<unknown>> {
  const parsed = convertCommunicationIntakeSchema.safeParse(rawInput);
  if (!parsed.success) {
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: CREATE_CLIENT_FROM_COMMUNICATION_ACTION.actionName,
      inputPayload: { id, rawInput },
      riskLevel: CREATE_CLIENT_FROM_COMMUNICATION_ACTION.riskLevel,
      confirmationRequired: true,
      result: "error",
      errorMessage: "VALIDATION_FAILED",
    });
    return fail(400, "VALIDATION_FAILED", parsed.error.message);
  }

  const intake = await prisma.communicationIntake.findFirst({
    where: { id, companyId: user.companyId },
    include: intakeInclude,
  });
  if (!intake) {
    await auditIntakeFailure(
      user,
      CREATE_CLIENT_FROM_COMMUNICATION_ACTION,
      { id, ...parsed.data },
      "COMMUNICATION_INTAKE_NOT_FOUND"
    );
    return fail(404, "COMMUNICATION_INTAKE_NOT_FOUND");
  }
  if (intake.intakeStatus === "converted") {
    await auditIntakeFailure(
      user,
      CREATE_CLIENT_FROM_COMMUNICATION_ACTION,
      { id, ...parsed.data },
      "UNSUPPORTED_ACTION",
      "rejected"
    );
    return fail(409, "UNSUPPORTED_ACTION", "This intake is already linked to CRM.", {
      clientId: intake.clientId,
      communicationRecordId: intake.communicationRecordId,
    });
  }
  if (!intake.extractedData) {
    await auditIntakeFailure(user, CREATE_CLIENT_FROM_COMMUNICATION_ACTION, { id, ...parsed.data }, "EXTRACTION_REQUIRED");
    return fail(409, "EXTRACTION_REQUIRED", "Extract the intake before conversion.");
  }

  // Recompute against the current CRM/catalogue so a stale preview cannot
  // silently miss a client or service created after the first extraction.
  const extraction = await buildExtraction(user.companyId, intake);
  const exactContactMatches = extraction.existingClientMatches.filter((match) =>
    match.reasons.some((reason) => reason === "email_match" || reason === "phone_match")
  );
  let selectedClient = parsed.data.client_id
    ? await prisma.client.findFirst({
        where: { id: parsed.data.client_id, companyId: user.companyId, isActive: true },
      })
    : null;
  if (parsed.data.client_id && !selectedClient) {
    await auditIntakeFailure(user, CREATE_CLIENT_FROM_COMMUNICATION_ACTION, { id, ...parsed.data }, "CLIENT_NOT_FOUND");
    return fail(404, "CLIENT_NOT_FOUND");
  }
  if (!selectedClient && exactContactMatches.length === 1) {
    selectedClient = await prisma.client.findFirst({
      where: { id: exactContactMatches[0].id, companyId: user.companyId, isActive: true },
    });
  }

  const selectionRequired = !selectedClient && extraction.existingClientMatches.length > 0;
  if (!selectedClient && !selectionRequired && !extraction.name) {
    await auditIntakeFailure(user, CREATE_CLIENT_FROM_COMMUNICATION_ACTION, { id, ...parsed.data }, "MISSING_DATA");
    return fail(400, "MISSING_DATA", "A real client name is required before creating a CRM client.", {
      missingFields: extraction.missingFields,
    });
  }

  const summary = buildCommunicationSummary(intake, extraction);
  const preview = {
    intakeId: intake.id,
    operation: selectedClient ? "link_existing" : selectionRequired ? "selection_required" : "create_new",
    selectedClient: selectedClient ? { id: selectedClient.id, displayName: selectedClient.displayName } : null,
    possibleClients: extraction.existingClientMatches,
    newClient: selectedClient || selectionRequired
      ? null
      : {
          displayName: extraction.name,
          emailPrimary: extraction.email,
          phonePrimary: extraction.phone,
          billingAddressLine1: extraction.address,
          billingPostcode: extraction.postcode,
          source: `communication:${intake.channel}`,
        },
    communication: {
      channel: intake.channel,
      summary,
      originalSourceReference: intake.sourceReference,
      followUpNeeded: true,
    },
  };

  if (!parsed.data.confirmed) {
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: CREATE_CLIENT_FROM_COMMUNICATION_ACTION.actionName,
      inputPayload: { id, ...parsed.data },
      dataBefore: preview,
      riskLevel: CREATE_CLIENT_FROM_COMMUNICATION_ACTION.riskLevel,
      confirmationRequired: true,
      result: "rejected",
      errorMessage: "CONFIRMATION_REQUIRED",
    });
    return fail(409, "CONFIRMATION_REQUIRED", "Review the preview and resubmit with confirmed: true.", { preview });
  }
  if (selectionRequired) {
    await auditIntakeFailure(
      user,
      CREATE_CLIENT_FROM_COMMUNICATION_ACTION,
      { id, ...parsed.data },
      "CLIENT_SELECTION_REQUIRED"
    );
    return fail(409, "CLIENT_SELECTION_REQUIRED", "Select the matching CRM client before confirming.", { preview });
  }

  const currentIntake = intake;
  async function performConversion() {
    return prisma.$transaction(async (tx) => {
      // Claim the extracted intake inside the same transaction as every CRM
      // write. Two concurrent confirmations cannot both create a client and
      // communication record for the same original message.
      const claimed = await tx.communicationIntake.updateMany({
        where: { id: currentIntake.id, companyId: user.companyId, intakeStatus: "extracted" },
        data: { intakeStatus: "converting" },
      });
      if (claimed.count !== 1) throw new Error("INTAKE_ALREADY_CONVERTED");

      const client = selectedClient ?? await tx.client.create({
        data: {
          companyId: user.companyId,
          displayName: extraction.name!,
          emailPrimary: extraction.email,
          phonePrimary: extraction.phone,
          billingLine1: extraction.address,
          billingPostcode: extraction.postcode,
          source: `communication:${currentIntake.channel}`,
          notes: currentIntake.sourceReference
            ? `Original communication reference: ${currentIntake.sourceReference}`
            : undefined,
          createdBy: user.id,
        },
      });
      const communicationRecord = await tx.communicationRecord.create({
        data: {
          companyId: user.companyId,
          clientId: client.id,
          channel: currentIntake.channel,
          direction: "inbound",
          summary,
          fullText: currentIntake.messageText,
          occurredAt: currentIntake.receivedAt,
          followUpNeeded: true,
          createdBy: user.id,
        },
      });
      const updatedIntake = await tx.communicationIntake.update({
        where: { id: currentIntake.id },
        data: {
          clientId: client.id,
          communicationRecordId: communicationRecord.id,
          intakeStatus: "converted",
          extractedData: extraction as never,
        },
        include: intakeInclude,
      });
      return { client, communicationRecord, intake: updatedIntake };
    });
  }

  let converted: Awaited<ReturnType<typeof performConversion>>;
  try {
    converted = await performConversion();
  } catch (error) {
    if (error instanceof Error && error.message === "INTAKE_ALREADY_CONVERTED") {
      await auditIntakeFailure(
        user,
        CREATE_CLIENT_FROM_COMMUNICATION_ACTION,
        { id, ...parsed.data },
        "UNSUPPORTED_ACTION",
        "rejected"
      );
      return fail(409, "UNSUPPORTED_ACTION", "This intake has already been converted.");
    }
    throw error;
  }

  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: CREATE_CLIENT_FROM_COMMUNICATION_ACTION.actionName,
    inputPayload: { id, ...parsed.data },
    dataBefore: preview,
    dataAfter: converted,
    riskLevel: CREATE_CLIENT_FROM_COMMUNICATION_ACTION.riskLevel,
    confirmationRequired: true,
    confirmed: true,
    result: "success",
  });
  return ok(200, converted);
}

export async function prepareCommunicationReply(
  user: AuthedUser,
  id: string
): Promise<ServiceResult<unknown>> {
  const intake = await prisma.communicationIntake.findFirst({ where: { id, companyId: user.companyId } });
  if (!intake) {
    await auditIntakeFailure(user, PREPARE_COMMUNICATION_REPLY_ACTION, { id }, "COMMUNICATION_INTAKE_NOT_FOUND");
    return fail(404, "COMMUNICATION_INTAKE_NOT_FOUND");
  }
  if (!intake.extractedData) {
    await auditIntakeFailure(user, PREPARE_COMMUNICATION_REPLY_ACTION, { id }, "EXTRACTION_REQUIRED");
    return fail(409, "EXTRACTION_REQUIRED", "Extract the intake before drafting a reply.");
  }

  const extraction = intake.extractedData as unknown as CommunicationExtraction;
  const company = await prisma.company.findUnique({ where: { id: user.companyId }, select: { name: true } });
  const greeting = extraction.name ? `Dear ${extraction.name},` : "Hello,";
  const services = extraction.serviceMatches.map((service) => service.name);
  const thanks = services.length > 0
    ? `Thank you for your enquiry about ${services.join(" and ")}.`
    : "Thank you for your enquiry.";
  const requestedDetails: string[] = [];
  if (services.length === 0) requestedDetails.push("the type of work you need");
  if (!extraction.address) requestedDetails.push("the job address or postcode");
  const detailsParagraph = requestedDetails.length > 0
    ? `To help us review your enquiry, please send ${requestedDetails.join(" and ")}.`
    : "We have recorded the details you provided and will review them before responding with next steps.";
  const replyDraft = [greeting, "", thanks, detailsParagraph, "", "Kind regards,", company!.name].join("\n");

  const updated = await prisma.communicationIntake.update({
    where: { id: intake.id },
    data: { replyDraft },
    include: intakeInclude,
  });
  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: PREPARE_COMMUNICATION_REPLY_ACTION.actionName,
    inputPayload: { id },
    dataBefore: { replyDraft: intake.replyDraft },
    dataAfter: { replyDraft },
    riskLevel: PREPARE_COMMUNICATION_REPLY_ACTION.riskLevel,
    result: "success",
  });
  return ok(200, updated);
}
