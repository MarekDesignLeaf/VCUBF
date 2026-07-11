import { createHash, randomBytes } from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../db.js";
import {
  assertConnectorEncryptionConfigured,
  ConnectorCryptoError,
  decryptConnectorPayload,
  encryptConnectorPayload,
} from "../connectors/connectorCrypto.js";
import {
  buildGmailAuthorizationUrl,
  exchangeGmailAuthorizationCode,
  getGmailMessage,
  GmailAdapterError,
  listGmailMessages,
  parseGmailMessage,
  refreshGmailCredential,
  type StoredGmailCredential,
} from "../connectors/gmailAdapter.js";
import {
  COMPLETE_GMAIL_OAUTH_ACTION,
  START_GMAIL_OAUTH_ACTION,
  SYNC_GMAIL_MESSAGES_ACTION,
  type ActionContract,
} from "../lib/actionContracts.js";
import { recordAudit } from "../lib/audit.js";
import type { AuthedUser } from "../middleware/auth.js";
import { fail, ok, type ServiceResult } from "./result.js";

const OAUTH_STATE_LIFETIME_MS = 10 * 60 * 1000;
const TOKEN_REFRESH_MARGIN_MS = 60 * 1000;

const callbackSchema = z
  .object({
    state: z.string().min(20).max(500),
    code: z.string().min(1).max(4096).optional(),
    error: z.string().min(1).max(200).optional(),
  })
  .refine((value) => Boolean(value.code) !== Boolean(value.error), "Exactly one of code or error is required");

export const syncGmailSchema = z
  .object({
    max_results: z.number().int().min(1).max(50).default(25),
    query: z.string().trim().min(1).max(500).optional(),
    page_token: z.string().trim().min(1).max(2000).optional(),
  })
  .strict();

function stateHash(state: string) {
  return createHash("sha256").update(state).digest("hex");
}

function credentialContext(companyId: string, sourceId: string) {
  return `${companyId}:${sourceId}:gmail`;
}

function safeRedirect(sourceId: string) {
  const configured = process.env.FRONTEND_URL?.trim() || "http://localhost:5173";
  let base: URL;
  try {
    base = new URL(configured);
    if (!["http:", "https:"].includes(base.protocol)) throw new Error("Invalid protocol");
  } catch {
    base = new URL("http://localhost:5173");
  }
  const url = new URL("/connectors", base);
  url.searchParams.set("gmail", "connected");
  url.searchParams.set("source", sourceId);
  return url.toString();
}

async function auditFailure(
  action: ActionContract,
  identity: { companyId: string; userId?: string; id?: string },
  sourceId: string,
  errorMessage: string
) {
  await recordAudit({
    companyId: identity.companyId,
    userId: identity.userId ?? identity.id,
    actionName: action.actionName,
    inputPayload: { sourceId },
    riskLevel: action.riskLevel,
    confirmationRequired: action.confirmationRequired,
    result: "error",
    errorMessage,
  });
}

function providerErrorResult(error: unknown): ServiceResult<never> {
  if (error instanceof GmailAdapterError) {
    const status = error.code === "RATE_LIMITED"
      ? 429
      : ["PROVIDER_UNAVAILABLE", "CONNECTOR_CONFIGURATION_MISSING"].includes(error.code)
        ? 503
        : error.code === "PROVIDER_RESPONSE_INVALID"
          ? 502
          : 409;
    return fail(status, error.code, error.message);
  }
  if (error instanceof ConnectorCryptoError) return fail(500, error.code);
  return fail(500, "CONNECTOR_INTERNAL_ERROR");
}

export async function startGmailOAuth(user: AuthedUser, sourceId: string): Promise<ServiceResult<unknown>> {
  const source = await prisma.connectorSource.findFirst({
    where: { id: sourceId, companyId: user.companyId, isActive: true },
  });
  if (!source || source.connectorKey !== "gmail") {
    await auditFailure(START_GMAIL_OAUTH_ACTION, user, sourceId, "CONNECTOR_SOURCE_NOT_FOUND");
    return fail(404, "CONNECTOR_SOURCE_NOT_FOUND");
  }
  if (!source.configuredScopes.includes("read:messages")) {
    await auditFailure(START_GMAIL_OAUTH_ACTION, user, sourceId, "CONNECTOR_SCOPE_REQUIRED");
    return fail(409, "CONNECTOR_SCOPE_REQUIRED", "Configure the read:messages logical scope first.");
  }

  try {
    assertConnectorEncryptionConfigured();
    const state = randomBytes(32).toString("base64url");
    const authorizationUrl = buildGmailAuthorizationUrl(state);
    const expiresAt = new Date(Date.now() + OAUTH_STATE_LIFETIME_MS);
    await prisma.$transaction([
      prisma.connectorOAuthState.deleteMany({ where: { sourceId } }),
      prisma.connectorOAuthState.create({
        data: {
          sourceId,
          companyId: user.companyId,
          userId: user.id,
          stateHash: stateHash(state),
          expiresAt,
        },
      }),
      prisma.connectorSource.update({
        where: { id: sourceId },
        data: { isEnabled: false, connectionStatus: "authorizing", lastErrorCode: null },
      }),
    ]);
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: START_GMAIL_OAUTH_ACTION.actionName,
      inputPayload: { sourceId },
      dataAfter: { sourceId, expiresAt },
      riskLevel: START_GMAIL_OAUTH_ACTION.riskLevel,
      result: "success",
    });
    return ok(200, { authorizationUrl, expiresAt });
  } catch (error) {
    const result = providerErrorResult(error);
    await auditFailure(START_GMAIL_OAUTH_ACTION, user, sourceId, result.ok ? "CONNECTOR_INTERNAL_ERROR" : result.error);
    return result;
  }
}

export async function completeGmailOAuth(rawInput: unknown): Promise<ServiceResult<{ redirectUrl: string }>> {
  const parsed = callbackSchema.safeParse(rawInput);
  if (!parsed.success) return fail(400, "OAUTH_CALLBACK_INVALID");
  const input = parsed.data;
  const oauthState = await prisma.connectorOAuthState.findUnique({
    where: { stateHash: stateHash(input.state) },
    include: { source: { include: { credential: true } } },
  });
  if (!oauthState || oauthState.consumedAt) return fail(400, "OAUTH_STATE_INVALID");
  if (!oauthState.source.isActive || oauthState.source.connectorKey !== "gmail") {
    await prisma.connectorOAuthState.update({ where: { id: oauthState.id }, data: { consumedAt: new Date() } });
    await auditFailure(COMPLETE_GMAIL_OAUTH_ACTION, oauthState, oauthState.sourceId, "CONNECTOR_SOURCE_NOT_FOUND");
    return fail(404, "CONNECTOR_SOURCE_NOT_FOUND");
  }
  const initiatingUser = await prisma.user.findFirst({
    where: { id: oauthState.userId, companyId: oauthState.companyId, isActive: true },
    select: { id: true, permissions: true },
  });
  if (!initiatingUser?.permissions.includes(COMPLETE_GMAIL_OAUTH_ACTION.requiredPermission)) {
    await prisma.connectorOAuthState.update({ where: { id: oauthState.id }, data: { consumedAt: new Date() } });
    await auditFailure(
      COMPLETE_GMAIL_OAUTH_ACTION,
      { companyId: oauthState.companyId, userId: initiatingUser?.id },
      oauthState.sourceId,
      "MISSING_PERMISSION"
    );
    return fail(403, "MISSING_PERMISSION");
  }
  if (oauthState.expiresAt <= new Date()) {
    await prisma.connectorOAuthState.update({ where: { id: oauthState.id }, data: { consumedAt: new Date() } });
    await auditFailure(COMPLETE_GMAIL_OAUTH_ACTION, oauthState, oauthState.sourceId, "OAUTH_STATE_EXPIRED");
    return fail(400, "OAUTH_STATE_EXPIRED");
  }
  const consumed = await prisma.connectorOAuthState.updateMany({
    where: { id: oauthState.id, consumedAt: null, expiresAt: { gt: new Date() } },
    data: { consumedAt: new Date() },
  });
  if (consumed.count !== 1) return fail(400, "OAUTH_STATE_INVALID");
  if (input.error) {
    await auditFailure(COMPLETE_GMAIL_OAUTH_ACTION, oauthState, oauthState.sourceId, "OAUTH_PROVIDER_REJECTED");
    return fail(409, "OAUTH_PROVIDER_REJECTED", "Google authorization was not granted.");
  }

  try {
    let existingRefreshToken: string | undefined;
    if (oauthState.source.credential) {
      existingRefreshToken = decryptConnectorPayload<StoredGmailCredential>(
        oauthState.source.credential,
        credentialContext(oauthState.companyId, oauthState.sourceId)
      ).refreshToken;
    }
    const credential = await exchangeGmailAuthorizationCode(input.code!, existingRefreshToken);
    const encrypted = encryptConnectorPayload(credential, credentialContext(oauthState.companyId, oauthState.sourceId));
    await prisma.$transaction([
      prisma.connectorCredential.upsert({
        where: { sourceId: oauthState.sourceId },
        create: {
          sourceId: oauthState.sourceId,
          companyId: oauthState.companyId,
          provider: "gmail",
          ...encrypted,
        },
        update: { provider: "gmail", ...encrypted },
      }),
      prisma.connectorSource.update({
        where: { id: oauthState.sourceId },
        data: { connectionStatus: "configured", isEnabled: false, lastErrorCode: null },
      }),
    ]);
    await recordAudit({
      companyId: oauthState.companyId,
      userId: oauthState.userId,
      actionName: COMPLETE_GMAIL_OAUTH_ACTION.actionName,
      inputPayload: { sourceId: oauthState.sourceId },
      dataAfter: { sourceId: oauthState.sourceId, provider: "gmail", scopeVerified: true, encrypted: true },
      riskLevel: COMPLETE_GMAIL_OAUTH_ACTION.riskLevel,
      result: "success",
    });
    return ok(200, { redirectUrl: safeRedirect(oauthState.sourceId) });
  } catch (error) {
    const result = providerErrorResult(error);
    await auditFailure(
      COMPLETE_GMAIL_OAUTH_ACTION,
      oauthState,
      oauthState.sourceId,
      result.ok ? "CONNECTOR_INTERNAL_ERROR" : result.error
    );
    return result;
  }
}

async function usableCredential(source: { credential: Prisma.ConnectorCredentialGetPayload<Record<string, never>> }) {
  const context = credentialContext(source.credential.companyId, source.credential.sourceId);
  let credential = decryptConnectorPayload<StoredGmailCredential>(source.credential, context);
  const expiresAt = Date.parse(credential.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() + TOKEN_REFRESH_MARGIN_MS) {
    credential = await refreshGmailCredential(credential);
    const encrypted = encryptConnectorPayload(credential, context);
    await prisma.connectorCredential.update({ where: { sourceId: source.credential.sourceId }, data: encrypted });
  }
  return credential;
}

export async function syncGmailMessages(
  user: AuthedUser,
  sourceId: string,
  rawInput: unknown
): Promise<ServiceResult<unknown>> {
  const parsed = syncGmailSchema.safeParse(rawInput);
  if (!parsed.success) {
    await auditFailure(SYNC_GMAIL_MESSAGES_ACTION, user, sourceId, "VALIDATION_FAILED");
    return fail(400, "VALIDATION_FAILED", parsed.error.message);
  }
  const source = await prisma.connectorSource.findFirst({
    where: { id: sourceId, companyId: user.companyId, connectorKey: "gmail", isActive: true },
    include: { credential: true },
  });
  if (!source) {
    await auditFailure(SYNC_GMAIL_MESSAGES_ACTION, user, sourceId, "CONNECTOR_SOURCE_NOT_FOUND");
    return fail(404, "CONNECTOR_SOURCE_NOT_FOUND");
  }
  if (!source.isEnabled) {
    await auditFailure(SYNC_GMAIL_MESSAGES_ACTION, user, sourceId, "CONNECTOR_NOT_ENABLED");
    return fail(409, "CONNECTOR_NOT_ENABLED");
  }
  if (!source.credential) {
    await auditFailure(SYNC_GMAIL_MESSAGES_ACTION, user, sourceId, "CONNECTOR_AUTHORIZATION_REQUIRED");
    return fail(409, "CONNECTOR_AUTHORIZATION_REQUIRED");
  }

  try {
    const credential = await usableCredential({ credential: source.credential });
    const listed = await listGmailMessages(credential.accessToken, {
      maxResults: parsed.data.max_results,
      query: parsed.data.query,
      pageToken: parsed.data.page_token,
    });
    if (listed.messages !== undefined && !Array.isArray(listed.messages)) {
      throw new GmailAdapterError("PROVIDER_RESPONSE_INVALID");
    }
    const messageRefs = listed.messages ?? [];
    const importedIntakeIds: string[] = [];
    let skippedCount = 0;

    for (const reference of messageRefs) {
      if (!reference?.id) throw new GmailAdapterError("PROVIDER_RESPONSE_INVALID");
      const existing = await prisma.communicationIntake.findUnique({
        where: {
          companyId_connectorSourceId_externalMessageId: {
            companyId: user.companyId,
            connectorSourceId: source.id,
            externalMessageId: reference.id,
          },
        },
        select: { id: true },
      });
      if (existing) {
        skippedCount += 1;
        continue;
      }
      const message = parseGmailMessage(await getGmailMessage(credential.accessToken, reference.id));
      if (message.externalMessageId !== reference.id) throw new GmailAdapterError("PROVIDER_RESPONSE_INVALID");
      try {
        const intake = await prisma.communicationIntake.create({
          data: {
            companyId: user.companyId,
            connectorSourceId: source.id,
            externalMessageId: message.externalMessageId,
            externalThreadId: message.externalThreadId,
            channel: "email",
            senderName: message.senderName,
            senderEmail: message.senderEmail,
            messageText: message.messageText,
            receivedAt: message.receivedAt,
            sourceReference: `gmail:${source.id}:${message.externalMessageId}`,
            createdBy: user.id,
          },
        });
        importedIntakeIds.push(intake.id);
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          skippedCount += 1;
          continue;
        }
        throw error;
      }
    }

    const syncedAt = new Date();
    await prisma.connectorSource.update({
      where: { id: source.id },
      data: { lastSyncAt: syncedAt, lastSyncStatus: "success", lastErrorCode: null },
    });
    const result = {
      sourceId: source.id,
      importedCount: importedIntakeIds.length,
      skippedCount,
      importedIntakeIds,
      nextPageToken: listed.nextPageToken ?? null,
      resultSizeEstimate: listed.resultSizeEstimate ?? null,
      syncedAt,
    };
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: SYNC_GMAIL_MESSAGES_ACTION.actionName,
      inputPayload: {
        sourceId,
        maxResults: parsed.data.max_results,
        queryProvided: Boolean(parsed.data.query),
        pageTokenProvided: Boolean(parsed.data.page_token),
      },
      dataAfter: result,
      riskLevel: SYNC_GMAIL_MESSAGES_ACTION.riskLevel,
      result: "success",
    });
    return ok(200, result);
  } catch (error) {
    const result = providerErrorResult(error);
    const errorCode = result.ok ? "CONNECTOR_INTERNAL_ERROR" : result.error;
    await prisma.connectorSource.update({
      where: { id: source.id },
      data: { lastSyncAt: new Date(), lastSyncStatus: "error", lastErrorCode: errorCode },
    });
    await auditFailure(SYNC_GMAIL_MESSAGES_ACTION, user, sourceId, errorCode);
    return result;
  }
}
