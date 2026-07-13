import { Prisma } from "@prisma/client";
import { createGmailDraftSchema, sendGmailMessageNow } from "./gmailConnectorService.js";
import { prisma } from "../db.js";
import {
  CANCEL_VOICE_GMAIL_MESSAGE_ACTION,
  CONFIRM_VOICE_GMAIL_MESSAGE_ACTION,
  PREPARE_VOICE_GMAIL_MESSAGE_ACTION,
  type ActionContract,
} from "../lib/actionContracts.js";
import { recordAudit } from "../lib/audit.js";
import type { AuthedUser } from "../middleware/auth.js";
import { fail, ok, type ServiceResult } from "./result.js";

const PENDING_GMAIL_ACTION = "send_gmail_message";
const PENDING_GMAIL_LIFETIME_MS = 5 * 60 * 1000;

type GmailMessage = {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
};

function canManageConnectors(user: AuthedUser) {
  return user.permissions.includes("connectors.manage");
}

function messageSummary(message: GmailMessage) {
  return {
    toCount: message.to.length,
    ccCount: message.cc.length,
    bccCount: message.bcc.length,
    subjectLength: message.subject.length,
    bodyLength: message.body.length,
  };
}

async function recordFailure(user: AuthedUser, action: Pick<ActionContract, "actionName" | "riskLevel" | "confirmationRequired">, errorMessage: string) {
  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: action.actionName,
    inputPayload: {},
    riskLevel: action.riskLevel,
    confirmationRequired: action.confirmationRequired,
    result: "error",
    errorMessage,
  });
}

async function expirePendingMessages(user: AuthedUser, now = new Date()) {
  await prisma.voicePendingAction.updateMany({
    where: {
      companyId: user.companyId,
      userId: user.id,
      actionType: PENDING_GMAIL_ACTION,
      status: "pending",
      expiresAt: { lte: now },
    },
    data: { status: "expired", payload: Prisma.DbNull, resolvedAt: now },
  });
}

async function eligibleGmailSource(user: AuthedUser) {
  const sources = await prisma.connectorSource.findMany({
    where: { companyId: user.companyId, connectorKey: "gmail", isActive: true },
    include: { credential: { select: { sourceId: true } } },
    orderBy: { displayName: "asc" },
  });
  if (sources.length === 0) {
    return fail(409, "GMAIL_NOT_CONFIGURED", "Gmail is not connected. Say ‘set up Gmail’ or open Connectors first.");
  }
  const enabled = sources.filter((source) => source.isEnabled);
  if (enabled.length === 0) {
    return fail(409, "CONNECTOR_NOT_ENABLED", "Gmail is connected but not enabled. Open Connectors and enable Gmail first.");
  }
  const canSend = enabled.filter((source) => source.configuredScopes.includes("send:messages"));
  if (canSend.length === 0) {
    return fail(409, "CONNECTOR_SCOPE_REQUIRED", "Gmail is connected without permission to send email. Reauthorize it in Connectors with Send email enabled.");
  }
  const authorised = canSend.filter((source) => Boolean(source.credential));
  if (authorised.length === 0) {
    return fail(409, "CONNECTOR_AUTHORIZATION_REQUIRED", "Gmail needs to be authorized again before Emma can send email.");
  }
  if (authorised.length > 1) {
    return fail(409, "AMBIGUOUS_GMAIL_SOURCE", "More than one Gmail account can send email. Leave one enabled in Connectors before sending through Emma.", {
      sourceNames: authorised.map((source) => source.displayName),
    });
  }
  return ok(200, authorised[0]);
}

function messageFromPayload(payload: unknown): GmailMessage | undefined {
  const parsed = createGmailDraftSchema.safeParse(payload);
  return parsed.success ? parsed.data : undefined;
}

export async function hasPendingVoiceGmailMessage(user: AuthedUser) {
  const now = new Date();
  await expirePendingMessages(user, now);
  return Boolean(
    await prisma.voicePendingAction.findFirst({
      where: {
        companyId: user.companyId,
        userId: user.id,
        actionType: PENDING_GMAIL_ACTION,
        status: "pending",
        expiresAt: { gt: now },
      },
      select: { id: true },
    })
  );
}

export async function prepareVoiceGmailMessage(user: AuthedUser, rawInput: unknown): Promise<ServiceResult<unknown>> {
  if (!canManageConnectors(user)) {
    await recordFailure(user, PREPARE_VOICE_GMAIL_MESSAGE_ACTION, "MISSING_PERMISSION");
    return fail(403, "MISSING_PERMISSION", "Connector management permission is required to send email.");
  }
  const parsed = createGmailDraftSchema.safeParse(rawInput);
  if (!parsed.success) {
    await recordFailure(user, PREPARE_VOICE_GMAIL_MESSAGE_ACTION, "VALIDATION_FAILED");
    return fail(400, "VALIDATION_FAILED", "I need a valid recipient email address, a one-line subject and a message body.");
  }

  const sourceResult = await eligibleGmailSource(user);
  if (!sourceResult.ok) {
    await recordFailure(user, PREPARE_VOICE_GMAIL_MESSAGE_ACTION, sourceResult.error);
    return sourceResult;
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + PENDING_GMAIL_LIFETIME_MS);
  await prisma.$transaction(async (tx) => {
    await tx.voicePendingAction.updateMany({
      where: { companyId: user.companyId, userId: user.id, actionType: PENDING_GMAIL_ACTION, status: "pending" },
      data: { status: "cancelled", payload: Prisma.DbNull, resolvedAt: now },
    });
    await tx.voicePendingAction.create({
      data: {
        companyId: user.companyId,
        userId: user.id,
        actionType: PENDING_GMAIL_ACTION,
        sourceId: sourceResult.data.id,
        payload: parsed.data as Prisma.InputJsonValue,
        expiresAt,
      },
    });
  });

  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: PREPARE_VOICE_GMAIL_MESSAGE_ACTION.actionName,
    inputPayload: { sourceId: sourceResult.data.id, ...messageSummary(parsed.data) },
    dataAfter: { expiresAt },
    riskLevel: PREPARE_VOICE_GMAIL_MESSAGE_ACTION.riskLevel,
    confirmationRequired: true,
    result: "success",
  });
  return ok(202, {
    confirmationRequired: true,
    expiresAt: expiresAt.toISOString(),
    preview: parsed.data,
    message: "I prepared the email for review. I will send it only after your explicit confirmation.",
  });
}

export async function confirmVoiceGmailMessage(user: AuthedUser): Promise<ServiceResult<unknown>> {
  if (!canManageConnectors(user)) {
    await recordFailure(user, CONFIRM_VOICE_GMAIL_MESSAGE_ACTION, "MISSING_PERMISSION");
    return fail(403, "MISSING_PERMISSION", "Connector management permission is required to send email.");
  }

  const now = new Date();
  await expirePendingMessages(user, now);
  const pending = await prisma.voicePendingAction.findFirst({
    where: {
      companyId: user.companyId,
      userId: user.id,
      actionType: PENDING_GMAIL_ACTION,
      status: "pending",
      expiresAt: { gt: now },
    },
    orderBy: { createdAt: "desc" },
  });
  if (!pending) {
    await recordFailure(user, CONFIRM_VOICE_GMAIL_MESSAGE_ACTION, "NO_PENDING_GMAIL_MESSAGE");
    return fail(409, "NO_PENDING_GMAIL_MESSAGE", "There is no email waiting for confirmation. Please ask me to prepare it again.");
  }

  const claimed = await prisma.voicePendingAction.updateMany({
    where: { id: pending.id, status: "pending", expiresAt: { gt: now } },
    data: { status: "sending" },
  });
  if (!claimed.count) {
    await recordFailure(user, CONFIRM_VOICE_GMAIL_MESSAGE_ACTION, "NO_PENDING_GMAIL_MESSAGE");
    return fail(409, "NO_PENDING_GMAIL_MESSAGE", "That email is no longer waiting for confirmation.");
  }

  const message = messageFromPayload(pending.payload);
  if (!message || !pending.sourceId) {
    await prisma.voicePendingAction.update({
      where: { id: pending.id },
      data: { status: "failed", payload: Prisma.DbNull, resolvedAt: new Date() },
    });
    await recordFailure(user, CONFIRM_VOICE_GMAIL_MESSAGE_ACTION, "PENDING_GMAIL_MESSAGE_INVALID");
    return fail(409, "PENDING_GMAIL_MESSAGE_INVALID", "The reviewed email is no longer valid. Please prepare it again.");
  }

  const result = await sendGmailMessageNow(user, pending.sourceId, { ...message, confirmed: true });
  const resolvedAt = new Date();
  if (!result.ok) {
    await prisma.voicePendingAction.update({
      where: { id: pending.id },
      data: { status: "failed", payload: Prisma.DbNull, resolvedAt },
    });
    await recordFailure(user, CONFIRM_VOICE_GMAIL_MESSAGE_ACTION, result.error);
    return result;
  }

  await prisma.voicePendingAction.update({
    where: { id: pending.id },
    data: { status: "sent", payload: Prisma.DbNull, resolvedAt },
  });
  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: CONFIRM_VOICE_GMAIL_MESSAGE_ACTION.actionName,
    inputPayload: { sourceId: pending.sourceId, ...messageSummary(message) },
    dataAfter: { sentAt: resolvedAt },
    riskLevel: CONFIRM_VOICE_GMAIL_MESSAGE_ACTION.riskLevel,
    confirmationRequired: true,
    confirmed: true,
    result: "success",
  });
  return ok(result.httpStatus, { ...(result.data as Record<string, unknown>), message: "Email sent." });
}

export async function cancelVoiceGmailMessage(user: AuthedUser): Promise<ServiceResult<unknown>> {
  if (!canManageConnectors(user)) {
    await recordFailure(user, CANCEL_VOICE_GMAIL_MESSAGE_ACTION, "MISSING_PERMISSION");
    return fail(403, "MISSING_PERMISSION", "Connector management permission is required to cancel a prepared email.");
  }

  const now = new Date();
  await expirePendingMessages(user, now);
  const cancelled = await prisma.voicePendingAction.updateMany({
    where: { companyId: user.companyId, userId: user.id, actionType: PENDING_GMAIL_ACTION, status: "pending" },
    data: { status: "cancelled", payload: Prisma.DbNull, resolvedAt: now },
  });
  if (!cancelled.count) {
    await recordFailure(user, CANCEL_VOICE_GMAIL_MESSAGE_ACTION, "NO_PENDING_GMAIL_MESSAGE");
    return fail(409, "NO_PENDING_GMAIL_MESSAGE", "There is no email waiting to be cancelled.");
  }
  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: CANCEL_VOICE_GMAIL_MESSAGE_ACTION.actionName,
    inputPayload: {},
    riskLevel: CANCEL_VOICE_GMAIL_MESSAGE_ACTION.riskLevel,
    confirmationRequired: false,
    result: "success",
  });
  return ok(200, { message: "The pending email was cancelled and its message content was removed." });
}
