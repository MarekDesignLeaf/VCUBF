import { z } from "zod";
import { prisma } from "../db.js";
import {
  configuredWhatsAppPhoneNumberId,
  parseWhatsAppWebhook,
  sendWhatsAppText,
  verifyWhatsAppWebhookChallenge,
  verifyWhatsAppWebhookSignature,
  WhatsAppBusinessAdapterError,
} from "../connectors/whatsappBusinessAdapter.js";
import {
  DISCONNECT_WHATSAPP_SOURCE_ACTION,
  RECEIVE_WHATSAPP_MESSAGE_ACTION,
  SEND_WHATSAPP_MESSAGE_ACTION,
} from "../lib/actionContracts.js";
import { recordAudit } from "../lib/audit.js";
import { normalizePhone, phoneNumberSchema } from "../lib/contactNormalization.js";
import type { AuthedUser } from "../middleware/auth.js";
import { fail, ok, type ServiceResult } from "./result.js";

export const sendWhatsAppMessageSchema = z.object({
  to: phoneNumberSchema,
  body: z.string().trim().min(1).max(4096),
  confirmed: z.boolean().optional(),
}).strict();
export const disconnectWhatsAppSchema = z.object({ confirmed: z.boolean().optional() }).strict();

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
    if (!source) return ok(200, { accepted: true, importedCount: 0, duplicateCount: 0, statusCount: parsed.statuses.length });

    const importedIntakeIds: string[] = [];
    let duplicateCount = 0;
    for (const message of messages) {
      const senderPhone = normalizePhone(message.from);
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
      dataAfter: { importedCount: importedIntakeIds.length, duplicateCount, importedIntakeIds },
      riskLevel: RECEIVE_WHATSAPP_MESSAGE_ACTION.riskLevel,
      result: "success",
    });
    return ok(200, { accepted: true, importedCount: importedIntakeIds.length, duplicateCount, statusCount: parsed.statuses.length });
  } catch (error) {
    return providerResult(error);
  }
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
