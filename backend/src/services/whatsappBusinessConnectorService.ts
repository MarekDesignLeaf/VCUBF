import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../db.js";
import {
  configuredWhatsAppPhoneNumberId,
  parseWhatsAppWebhook,
  sendWhatsAppText,
  verifyWhatsAppWebhookChallenge,
  verifyWhatsAppWebhookSignature,
  WhatsAppBusinessAdapterError,
  type WhatsAppInboundMessage,
} from "../connectors/whatsappBusinessAdapter.js";
import {
  DISCONNECT_WHATSAPP_SOURCE_ACTION,
  RECEIVE_WHATSAPP_MESSAGE_ACTION,
  SEND_WHATSAPP_MESSAGE_ACTION,
  SYNC_WHATSAPP_CONTACTS_ACTION,
} from "../lib/actionContracts.js";
import { recordAudit } from "../lib/audit.js";
import { isValidPhoneNumberFormat, normalizePhone, phoneNumberSchema } from "../lib/contactNormalization.js";
import type { AuthedUser } from "../middleware/auth.js";
import { fail, ok, type ServiceResult } from "./result.js";

export const sendWhatsAppMessageSchema = z.object({
  to: phoneNumberSchema,
  body: z.string().trim().min(1).max(4096),
  confirmed: z.boolean().optional(),
}).strict();
export const disconnectWhatsAppSchema = z.object({ confirmed: z.boolean().optional() }).strict();
const externalContactQuerySchema = z.object({
  active_only: z.enum(["true", "false"]).optional(),
  importable_only: z.enum(["true", "false"]).optional(),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();

type WhatsAppContactSyncOutcome = "created" | "linked" | "already_synced" | "needs_review" | "invalid";
type WhatsAppContactSource = { id: string; companyId: string; createdBy: string | null };
interface WhatsAppContactSyncCounts {
  createdCount: number;
  linkedCount: number;
  alreadySyncedCount: number;
  awaitingReviewCount: number;
  skippedInvalidCount: number;
}

function emptyContactSyncCounts(): WhatsAppContactSyncCounts {
  return { createdCount: 0, linkedCount: 0, alreadySyncedCount: 0, awaitingReviewCount: 0, skippedInvalidCount: 0 };
}

function addContactSyncOutcome(counts: WhatsAppContactSyncCounts, outcome: WhatsAppContactSyncOutcome) {
  if (outcome === "created") counts.createdCount += 1;
  else if (outcome === "linked") counts.linkedCount += 1;
  else if (outcome === "already_synced") counts.alreadySyncedCount += 1;
  else if (outcome === "needs_review") counts.awaitingReviewCount += 1;
  else counts.skippedInvalidCount += 1;
}

function whatsappExternalResourceName(from: string) {
  const waId = from.replace(/\D/g, "");
  return waId.length > 0 && waId.length <= 40 ? "wa_id:" + waId : null;
}

async function syncInboundWhatsAppContact(
  source: WhatsAppContactSource,
  message: WhatsAppInboundMessage
): Promise<WhatsAppContactSyncOutcome> {
  const externalResourceName = whatsappExternalResourceName(message.from);
  if (!externalResourceName) return "invalid";

  const senderPhone = normalizePhone(message.from);
  const sourceReference = "whatsapp:" + source.id + ":" + externalResourceName;
  const syncedAt = new Date();
  let lastError: unknown;

  // The CRM has no global phone uniqueness constraint because legitimate
  // shared office numbers exist. Serializable retries keep concurrent webhook
  // deliveries from creating duplicate contacts for the same new sender.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.$transaction(async (tx) => {
        const external = await tx.externalContact.upsert({
          where: {
            companyId_connectorSourceId_externalResourceName: {
              companyId: source.companyId,
              connectorSourceId: source.id,
              externalResourceName,
            },
          },
          update: {
            sourceEtag: message.id,
            ...(message.senderName ? { displayName: message.senderName } : {}),
            ...(senderPhone ? { phone: senderPhone } : {}),
            isDeleted: false,
            syncedAt,
          },
          create: {
            companyId: source.companyId,
            connectorSourceId: source.id,
            externalResourceName,
            sourceEtag: message.id,
            displayName: message.senderName,
            phone: senderPhone ?? message.from,
            syncedAt,
          },
        });

        // Preserve the source evidence even if Meta's sender number cannot be
        // validated as a real phone number. Such a record never becomes CRM data.
        if (!senderPhone) return "invalid";

        if (external.importedContactId) {
          const linkedContact = await tx.contact.findFirst({
            where: { id: external.importedContactId, companyId: source.companyId, isActive: true },
            select: { id: true },
          });
          if (linkedContact) return "already_synced";
          await tx.externalContact.update({ where: { id: external.id }, data: { importedContactId: null } });
        }

        const candidates = await tx.contact.findMany({
          where: {
            companyId: source.companyId,
            isActive: true,
            OR: [{ sourceReference }, { phone: { not: null } }],
          },
          select: { id: true, phone: true, sourceReference: true },
        });
        const matches = candidates.filter((contact) =>
          contact.sourceReference === sourceReference || normalizePhone(contact.phone) === senderPhone
        );

        // Linking exactly one existing contact is safe. More than one match is
        // deliberately left for a human to resolve; existing CRM data is never
        // overwritten with provider profile data.
        if (matches.length === 1) {
          await tx.externalContact.update({ where: { id: external.id }, data: { importedContactId: matches[0].id } });
          return "linked";
        }
        if (matches.length > 1) return "needs_review";

        const created = await tx.contact.create({
          data: {
            companyId: source.companyId,
            displayName: message.senderName ?? "WhatsApp " + senderPhone,
            phone: senderPhone,
            preferredChannel: "whatsapp",
            source: "whatsapp_business",
            sourceReference,
            createdBy: source.createdBy,
          },
        });
        await tx.externalContact.update({ where: { id: external.id }, data: { importedContactId: created.id } });
        return "created";
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      lastError = error;
      const retryable = error instanceof Prisma.PrismaClientKnownRequestError
        && (error.code === "P2034" || error.code === "P2002");
      if (!retryable || attempt === 2) throw error;
    }
  }
  throw lastError ?? new Error("WHATSAPP_CONTACT_SYNC_FAILED");
}

function providerResult(error: unknown): ServiceResult<never> {
  if (error instanceof WhatsAppBusinessAdapterError) {
    const status = error.code === "RATE_LIMITED"
      ? 429
      : error.code === "CONNECTOR_CONFIGURATION_MISSING" || error.code === "PROVIDER_UNAVAILABLE"
        ? 503
        : error.code === "WEBHOOK_SIGNATURE_INVALID"
          ? 401
          : error.code === "WEBHOOK_VERIFICATION_FAILED"
            ? 403
            : error.code === "PROVIDER_RESPONSE_INVALID"
              ? 502
              : 409;
    return fail(status, error.code, error.message);
  }
  return fail(500, "CONNECTOR_INTERNAL_ERROR");
}

export function verifyWebhookChallenge(query: unknown): ServiceResult<string> {
  const values = query && typeof query === "object" ? query as Record<string, unknown> : {};
  try {
    const challenge = verifyWhatsAppWebhookChallenge({
      mode: typeof values["hub.mode"] === "string" ? values["hub.mode"] : undefined,
      token: typeof values["hub.verify_token"] === "string" ? values["hub.verify_token"] : undefined,
      challenge: typeof values["hub.challenge"] === "string" ? values["hub.challenge"] : undefined,
    });
    return ok(200, challenge);
  } catch (error) {
    return providerResult(error);
  }
}

export async function receiveWebhook(
  rawBody: Buffer | undefined,
  signature: string | undefined,
  payload: unknown
): Promise<ServiceResult<unknown>> {
  try {
    if (!rawBody) throw new WhatsAppBusinessAdapterError("WEBHOOK_SIGNATURE_INVALID");
    verifyWhatsAppWebhookSignature(rawBody, signature);
    const parsed = parseWhatsAppWebhook(payload);
    const phoneNumberId = configuredWhatsAppPhoneNumberId();
    const messages = parsed.messages.filter((message) => message.phoneNumberId === phoneNumberId);
    const source = await prisma.connectorSource.findFirst({
      where: { connectorKey: "whatsapp_business", isEnabled: true, isActive: true },
      orderBy: { createdAt: "asc" },
    });
    if (!source) {
      return ok(200, {
        accepted: true,
        importedCount: 0,
        duplicateCount: 0,
        statusCount: parsed.statuses.length,
        contactSync: emptyContactSyncCounts(),
      });
    }

    const importedIntakeIds: string[] = [];
    let duplicateCount = 0;
    const contactSync = emptyContactSyncCounts();
    for (const message of messages) {
      const senderPhone = normalizePhone(message.from);
      addContactSyncOutcome(contactSync, await syncInboundWhatsAppContact(source, message));
      if (!senderPhone) continue;
      const existing = await prisma.communicationIntake.findUnique({
        where: {
          companyId_connectorSourceId_externalMessageId: {
            companyId: source.companyId,
            connectorSourceId: source.id,
            externalMessageId: message.id,
          },
        },
        select: { id: true },
      });
      if (existing) {
        duplicateCount += 1;
        continue;
      }
      const intake = await prisma.communicationIntake.upsert({
        where: {
          companyId_connectorSourceId_externalMessageId: {
            companyId: source.companyId,
            connectorSourceId: source.id,
            externalMessageId: message.id,
          },
        },
        update: {},
        create: {
          companyId: source.companyId,
          connectorSourceId: source.id,
          externalMessageId: message.id,
          channel: "whatsapp",
          senderName: message.senderName,
          senderPhone,
          messageText: message.messageText,
          receivedAt: message.receivedAt,
          sourceReference: `whatsapp:${phoneNumberId}:${message.id}`,
          createdBy: source.createdBy,
        },
      });
      importedIntakeIds.push(intake.id);
    }
    await prisma.connectorSource.update({
      where: { id: source.id },
      data: { lastSyncAt: new Date(), lastSyncStatus: "success", lastErrorCode: null },
    });
    await recordAudit({
      companyId: source.companyId,
      userId: source.createdBy,
      actionName: RECEIVE_WHATSAPP_MESSAGE_ACTION.actionName,
      inputPayload: { sourceId: source.id, signedWebhook: true, messageCount: messages.length, statusCount: parsed.statuses.length },
      dataAfter: { importedCount: importedIntakeIds.length, duplicateCount, importedIntakeIds, contactSync },
      riskLevel: RECEIVE_WHATSAPP_MESSAGE_ACTION.riskLevel,
      result: "success",
    });
    if (messages.length > 0) {
      await recordAudit({
        companyId: source.companyId,
        userId: source.createdBy,
        actionName: SYNC_WHATSAPP_CONTACTS_ACTION.actionName,
        inputPayload: { sourceId: source.id, signedWebhook: true, messageCount: messages.length },
        dataAfter: contactSync,
        riskLevel: SYNC_WHATSAPP_CONTACTS_ACTION.riskLevel,
        result: "success",
      });
    }
    return ok(200, {
      accepted: true,
      importedCount: importedIntakeIds.length,
      duplicateCount,
      statusCount: parsed.statuses.length,
      contactSync,
    });
  } catch (error) {
    return providerResult(error);
  }
}

export async function listWhatsAppContacts(
  user: AuthedUser,
  sourceId: string,
  rawQuery: unknown
): Promise<ServiceResult<unknown>> {
  const parsed = externalContactQuerySchema.safeParse(rawQuery);
  if (!parsed.success) return fail(400, "VALIDATION_FAILED", parsed.error.message);
  const source = await prisma.connectorSource.findFirst({
    where: { id: sourceId, companyId: user.companyId, connectorKey: "whatsapp_business" },
  });
  if (!source) return fail(404, "CONNECTOR_SOURCE_NOT_FOUND");

  const where: Prisma.ExternalContactWhereInput = {
    companyId: user.companyId,
    connectorSourceId: source.id,
    ...(parsed.data.active_only === "true" ? { isDeleted: false } : {}),
    ...(parsed.data.importable_only === "true" ? { isDeleted: false, phone: { not: null } } : {}),
  };
  const [items, total] = await prisma.$transaction([
    prisma.externalContact.findMany({
      where,
      orderBy: [{ displayName: "asc" }, { createdAt: "asc" }],
      skip: parsed.data.offset,
      take: parsed.data.limit,
    }),
    prisma.externalContact.count({ where }),
  ]);
  return ok(200, {
    items: items.map((item) => {
      const phoneValid = !item.phone || isValidPhoneNumberFormat(item.phone);
      return { ...item, phoneValid, importable: !item.isDeleted && Boolean(item.phone) && phoneValid };
    }),
    total,
    offset: parsed.data.offset,
    limit: parsed.data.limit,
  });
}

export async function sendWhatsAppMessage(
  user: AuthedUser,
  sourceId: string,
  rawInput: unknown
): Promise<ServiceResult<unknown>> {
  const parsed = sendWhatsAppMessageSchema.safeParse(rawInput);
  if (!parsed.success) return fail(400, "VALIDATION_FAILED", parsed.error.message);
  const source = await prisma.connectorSource.findFirst({
    where: { id: sourceId, companyId: user.companyId, connectorKey: "whatsapp_business", isActive: true },
  });
  if (!source) return fail(404, "CONNECTOR_SOURCE_NOT_FOUND");
  if (!source.isEnabled) return fail(409, "CONNECTOR_NOT_ENABLED");
  if (!source.configuredScopes.includes("send:messages")) return fail(409, "CONNECTOR_SCOPE_REQUIRED");
  const preview = { sourceId, provider: "whatsapp_business", to: parsed.data.to, body: parsed.data.body };
  if (!parsed.data.confirmed) {
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: SEND_WHATSAPP_MESSAGE_ACTION.actionName,
      inputPayload: { sourceId, confirmed: false, recipientLength: parsed.data.to.length, bodyLength: parsed.data.body.length },
      riskLevel: SEND_WHATSAPP_MESSAGE_ACTION.riskLevel,
      confirmationRequired: true,
      result: "rejected",
      errorMessage: "CONFIRMATION_REQUIRED",
    });
    return fail(409, "CONFIRMATION_REQUIRED", "Review the final WhatsApp recipient and message, then confirm sending.", { preview });
  }
  try {
    const sent = await sendWhatsAppText({ to: parsed.data.to, body: parsed.data.body });
    const result = { sourceId, messageId: sent.messageId, sentAt: new Date() };
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: SEND_WHATSAPP_MESSAGE_ACTION.actionName,
      inputPayload: { sourceId, confirmed: true, recipientLength: parsed.data.to.length, bodyLength: parsed.data.body.length },
      dataAfter: result,
      riskLevel: SEND_WHATSAPP_MESSAGE_ACTION.riskLevel,
      confirmationRequired: true,
      confirmed: true,
      result: "success",
    });
    return ok(200, result);
  } catch (error) {
    const result = providerResult(error);
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: SEND_WHATSAPP_MESSAGE_ACTION.actionName,
      inputPayload: { sourceId, confirmed: true, recipientLength: parsed.data.to.length, bodyLength: parsed.data.body.length },
      riskLevel: SEND_WHATSAPP_MESSAGE_ACTION.riskLevel,
      confirmationRequired: true,
      confirmed: true,
      result: "error",
      errorMessage: result.ok ? "CONNECTOR_INTERNAL_ERROR" : result.error,
    });
    return result;
  }
}

export async function disconnectWhatsAppSource(
  user: AuthedUser,
  sourceId: string,
  rawInput: unknown
): Promise<ServiceResult<unknown>> {
  const parsed = disconnectWhatsAppSchema.safeParse(rawInput);
  if (!parsed.success) return fail(400, "VALIDATION_FAILED", parsed.error.message);
  const source = await prisma.connectorSource.findFirst({
    where: { id: sourceId, companyId: user.companyId, connectorKey: "whatsapp_business", isActive: true },
  });
  if (!source) return fail(404, "CONNECTOR_SOURCE_NOT_FOUND");
  const preview = { sourceId, willDisableSource: true, deploymentSecretsRemainConfigured: true };
  if (!parsed.data.confirmed) return fail(409, "CONFIRMATION_REQUIRED", "Confirm local WhatsApp disconnection.", { preview });
  const updated = await prisma.connectorSource.update({
    where: { id: source.id },
    data: { isEnabled: false, connectionStatus: "disconnected", lastErrorCode: null },
  });
  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: DISCONNECT_WHATSAPP_SOURCE_ACTION.actionName,
    inputPayload: { sourceId, confirmed: true },
    dataBefore: { sourceId, isEnabled: source.isEnabled },
    dataAfter: { sourceId, isEnabled: updated.isEnabled, connectionStatus: updated.connectionStatus },
    riskLevel: DISCONNECT_WHATSAPP_SOURCE_ACTION.riskLevel,
    confirmationRequired: true,
    confirmed: true,
    result: "success",
  });
  return ok(200, { sourceId, provider: "whatsapp_business", disconnectedAt: new Date(), providerGrantRevoked: false });
}
