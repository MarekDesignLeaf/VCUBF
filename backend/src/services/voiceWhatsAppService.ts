import { Prisma } from "@prisma/client";
import { SEND_WHATSAPP_MESSAGE_ACTION } from "../lib/actionContracts.js";
import { recordAudit } from "../lib/audit.js";
import { validateWhatsAppConfiguration, WhatsAppBusinessAdapterError } from "../connectors/whatsappBusinessAdapter.js";
import type { AuthedUser } from "../middleware/auth.js";
import { prisma } from "../db.js";
import { sendWhatsAppMessage, sendWhatsAppMessageSchema } from "./whatsappBusinessConnectorService.js";
import { fail, ok, type ServiceResult } from "./result.js";

const PENDING_WHATSAPP_ACTION = "send_whatsapp_message";
const PENDING_WHATSAPP_LIFETIME_MS = 5 * 60 * 1000;

type WhatsAppMessage = { to: string; body: string };

function canManageConnectors(user: AuthedUser) {
  return user.permissions.includes("connectors.manage");
}

async function expirePendingMessages(user: AuthedUser, now = new Date()) {
  await prisma.voicePendingAction.updateMany({
    where: {
      companyId: user.companyId,
      userId: user.id,
      actionType: PENDING_WHATSAPP_ACTION,
      status: "pending",
      expiresAt: { lte: now },
    },
    data: { status: "expired", payload: Prisma.DbNull, resolvedAt: now },
  });
}

async function eligibleSource(user: AuthedUser): Promise<ServiceResult<{ id: string; displayName: string }>> {
  const sources = await prisma.connectorSource.findMany({
    where: { companyId: user.companyId, connectorKey: "whatsapp_business", isActive: true },
    select: { id: true, displayName: true, isEnabled: true, configuredScopes: true },
    orderBy: { displayName: "asc" },
  });
  if (!sources.length) return fail(409, "WHATSAPP_NOT_CONFIGURED", "WhatsApp Business is not configured.");
  const enabled = sources.filter((source) => source.isEnabled && source.configuredScopes.includes("send:messages"));
  if (!enabled.length) return fail(409, "CONNECTOR_NOT_ENABLED", "WhatsApp Business is not enabled for sending messages.");
  if (enabled.length > 1) return fail(409, "AMBIGUOUS_WHATSAPP_SOURCE", "More than one WhatsApp Business source can send messages. Leave one enabled.");
  try {
    await validateWhatsAppConfiguration();
  } catch (error) {
    if (error instanceof WhatsAppBusinessAdapterError) return fail(
      error.code === "PROVIDER_UNAVAILABLE" ? 503 : 409,
      error.code,
      error.code === "CONNECTOR_AUTHORIZATION_REQUIRED"
        ? "The WhatsApp access token is invalid or expired. Replace it in the deployment configuration before sending."
        : error.message
    );
    return fail(500, "CONNECTOR_INTERNAL_ERROR");
  }
  return ok(200, enabled[0]);
}

function messageFromPayload(payload: unknown): WhatsAppMessage | undefined {
  const parsed = sendWhatsAppMessageSchema.safeParse(payload);
  return parsed.success ? { to: parsed.data.to, body: parsed.data.body } : undefined;
}

export async function hasPendingVoiceWhatsAppMessage(user: AuthedUser) {
  const now = new Date();
  await expirePendingMessages(user, now);
  return Boolean(await prisma.voicePendingAction.findFirst({
    where: {
      companyId: user.companyId,
      userId: user.id,
      actionType: PENDING_WHATSAPP_ACTION,
      status: "pending",
      expiresAt: { gt: now },
    },
    select: { id: true },
  }));
}

export async function prepareVoiceWhatsAppMessage(user: AuthedUser, rawInput: unknown): Promise<ServiceResult<unknown>> {
  if (!canManageConnectors(user)) return fail(403, "MISSING_PERMISSION", "Connector management permission is required to send WhatsApp messages.");
  const parsed = sendWhatsAppMessageSchema.safeParse(rawInput);
  if (!parsed.success) return fail(400, "VALIDATION_FAILED", "I need a valid international phone number and a message.");
  const source = await eligibleSource(user);
  if (!source.ok) return source;

  const now = new Date();
  const expiresAt = new Date(now.getTime() + PENDING_WHATSAPP_LIFETIME_MS);
  const payload: WhatsAppMessage = { to: parsed.data.to, body: parsed.data.body };
  await prisma.$transaction(async (tx) => {
    await tx.voicePendingAction.updateMany({
      where: { companyId: user.companyId, userId: user.id, actionType: PENDING_WHATSAPP_ACTION, status: "pending" },
      data: { status: "cancelled", payload: Prisma.DbNull, resolvedAt: now },
    });
    await tx.voicePendingAction.create({
      data: {
        companyId: user.companyId,
        userId: user.id,
        sourceId: source.data.id,
        actionType: PENDING_WHATSAPP_ACTION,
        payload: payload as Prisma.InputJsonValue,
        expiresAt,
      },
    });
  });
  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: SEND_WHATSAPP_MESSAGE_ACTION.actionName,
    inputPayload: { sourceId: source.data.id, confirmed: false, recipientLength: payload.to.length, bodyLength: payload.body.length },
    dataAfter: { pending: true, expiresAt },
    riskLevel: SEND_WHATSAPP_MESSAGE_ACTION.riskLevel,
    confirmationRequired: true,
    result: "success",
  });
  return ok(202, {
    confirmationRequired: true,
    expiresAt: expiresAt.toISOString(),
    preview: payload,
    message: "I prepared the WhatsApp message for review. I will send it only after your explicit confirmation.",
  });
}

export async function confirmVoiceWhatsAppMessage(user: AuthedUser): Promise<ServiceResult<unknown>> {
  if (!canManageConnectors(user)) return fail(403, "MISSING_PERMISSION", "Connector management permission is required to send WhatsApp messages.");
  const now = new Date();
  await expirePendingMessages(user, now);
  const pending = await prisma.voicePendingAction.findFirst({
    where: { companyId: user.companyId, userId: user.id, actionType: PENDING_WHATSAPP_ACTION, status: "pending", expiresAt: { gt: now } },
    orderBy: { createdAt: "desc" },
  });
  if (!pending) return fail(409, "NO_PENDING_WHATSAPP_MESSAGE", "There is no WhatsApp message waiting for confirmation.");
  const claimed = await prisma.voicePendingAction.updateMany({
    where: { id: pending.id, status: "pending", expiresAt: { gt: now } },
    data: { status: "sending" },
  });
  if (!claimed.count) return fail(409, "NO_PENDING_WHATSAPP_MESSAGE", "That WhatsApp message is no longer waiting for confirmation.");

  const message = messageFromPayload(pending.payload);
  if (!message || !pending.sourceId) {
    await prisma.voicePendingAction.update({ where: { id: pending.id }, data: { status: "failed", payload: Prisma.DbNull, resolvedAt: new Date() } });
    return fail(409, "PENDING_WHATSAPP_MESSAGE_INVALID", "The reviewed WhatsApp message is no longer valid.");
  }
  const result = await sendWhatsAppMessage(user, pending.sourceId, { ...message, confirmed: true });
  const resolvedAt = new Date();
  await prisma.voicePendingAction.update({
    where: { id: pending.id },
    data: { status: result.ok ? "sent" : "failed", payload: Prisma.DbNull, resolvedAt },
  });
  if (!result.ok) return result;
  return ok(result.httpStatus, { ...(result.data as Record<string, unknown>), message: "WhatsApp message sent." });
}

export async function cancelVoiceWhatsAppMessage(user: AuthedUser): Promise<ServiceResult<unknown>> {
  if (!canManageConnectors(user)) return fail(403, "MISSING_PERMISSION", "Connector management permission is required to cancel a WhatsApp message.");
  const now = new Date();
  await expirePendingMessages(user, now);
  const cancelled = await prisma.voicePendingAction.updateMany({
    where: { companyId: user.companyId, userId: user.id, actionType: PENDING_WHATSAPP_ACTION, status: "pending" },
    data: { status: "cancelled", payload: Prisma.DbNull, resolvedAt: now },
  });
  return cancelled.count
    ? ok(200, { message: "The pending WhatsApp message was cancelled and removed." })
    : fail(409, "NO_PENDING_WHATSAPP_MESSAGE", "There is no WhatsApp message waiting to be cancelled.");
}
