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
  createGmailDraft,
  exchangeGmailAuthorizationCode,
  GMAIL_INBOX_LABEL,
  GMAIL_COMPOSE_SCOPE,
  GMAIL_SEND_SCOPE,
  getGmailMessage,
  getGmailProfile,
  GmailAdapterError,
  listGmailHistory,
  listGmailMessages,
  parseGmailMessage,
  refreshGmailCredential,
  revokeGmailCredential,
  sendGmailMessage,
  type StoredGmailCredential,
} from "../connectors/gmailAdapter.js";
import {
  COMPLETE_GMAIL_OAUTH_ACTION,
  CREATE_GMAIL_DRAFT_ACTION,
  DISCONNECT_GMAIL_SOURCE_ACTION,
  START_GMAIL_OAUTH_ACTION,
  SEND_GMAIL_MESSAGE_ACTION,
  SYNC_GMAIL_MESSAGES_ACTION,
  type ActionContract,
} from "../lib/actionContracts.js";
import { recordAudit } from "../lib/audit.js";
import { frontendUrl } from "../lib/frontendUrl.js";
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
    full_sync: z.boolean().default(false),
  })
  .strict()
  .refine((value) => !(value.full_sync && (value.query || value.page_token)), {
    message: "full_sync cannot be combined with query or page_token",
  });

export const disconnectGmailSchema = z.object({ confirmed: z.boolean().optional() }).strict();

const gmailAddressSchema = z.string().trim().email().max(320).refine((value) => !/[\r\n]/.test(value), "Invalid email address");
const gmailComposeFields = {
  to: z.array(gmailAddressSchema).min(1).max(20),
  cc: z.array(gmailAddressSchema).max(20).default([]),
  bcc: z.array(gmailAddressSchema).max(20).default([]),
  subject: z.string().min(1).max(998).refine((value) => !/[\r\n]/.test(value), "Subject must be one line"),
  body: z.string().min(1).max(100_000),
};
export const createGmailDraftSchema = z.object(gmailComposeFields).strict();
export const sendGmailMessageSchema = z.object({ ...gmailComposeFields, confirmed: z.boolean().optional() }).strict();

function stateHash(state: string) {
  return createHash("sha256").update(state).digest("hex");
}

function credentialContext(companyId: string, sourceId: string) {
  return `${companyId}:${sourceId}:gmail`;
}

function safeRedirect(sourceId: string) {
  const url = frontendUrl("/connectors");
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
          : error.code === "MESSAGE_NOT_FOUND"
            ? 404
          : error.code === "HISTORY_CURSOR_EXPIRED"
            ? 409
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
  if (source.configuredScopes.length === 0) {
    await auditFailure(START_GMAIL_OAUTH_ACTION, user, sourceId, "CONNECTOR_SCOPE_REQUIRED");
    return fail(409, "CONNECTOR_SCOPE_REQUIRED", "Configure at least one Gmail logical scope first.");
  }

  try {
    assertConnectorEncryptionConfigured();
    const state = randomBytes(32).toString("base64url");
    const authorizationUrl = buildGmailAuthorizationUrl(state, source.configuredScopes);
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
    const credential = await exchangeGmailAuthorizationCode(
      input.code!,
      oauthState.source.configuredScopes,
      existingRefreshToken
    );
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
        data: {
          connectionStatus: "configured",
          isEnabled: false,
          lastErrorCode: null,
          syncCursor: null,
          syncPageToken: null,
          lastFullSyncAt: null,
        },
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

/**
 * Deliver a security notice from a company's already authorised Gmail source.
 * This is intentionally narrow: it only sends a supplied plain-text message
 * to one recipient and never exposes connector credentials to auth routes.
 */
export async function deliverGmailSecurityMessage(input: {
  companyId: string;
  recipient: string;
  subject: string;
  body: string;
  fallbackToConnectedMailbox?: boolean;
}) {
  const sources = await prisma.connectorSource.findMany({
    where: {
      companyId: input.companyId,
      connectorKey: "gmail",
      isActive: true,
      isEnabled: true,
      configuredScopes: { has: "send:messages" },
    },
    include: { credential: true },
    orderBy: { updatedAt: "desc" },
  });

  for (const source of sources) {
    if (!source.credential) continue;
    try {
      const credential = await usableCredential({ credential: source.credential });
      if (!credential.scopes.some((scope) => scope === GMAIL_COMPOSE_SCOPE || scope === GMAIL_SEND_SCOPE)) continue;
      let recipient = input.recipient;
      // The bootstrap administrator is deliberately a placeholder address.
      // Its real recovery mailbox is the account that authorised Gmail.
      if (input.fallbackToConnectedMailbox) {
        const profile = await getGmailProfile(credential.accessToken);
        const parsed = gmailAddressSchema.safeParse(profile.emailAddress);
        if (parsed.success) recipient = parsed.data;
      }
      const sent = await sendGmailMessage(credential.accessToken, {
        to: [recipient],
        cc: [],
        bcc: [],
        subject: input.subject,
        body: input.body,
      });
      if (!sent.id) throw new GmailAdapterError("PROVIDER_RESPONSE_INVALID");
      return { delivered: true as const, sourceId: source.id, recipient };
    } catch {
      // A second configured Gmail source can still provide the recovery path.
    }
  }
  return { delivered: false as const };
}

type GmailSource = Prisma.ConnectorSourceGetPayload<{ include: { credential: true } }>;

interface GmailSyncResult {
  sourceId: string;
  mode: "full" | "incremental";
  fallbackFromExpiredHistory: boolean;
  importedCount: number;
  skippedCount: number;
  importedIntakeIds: string[];
  nextPageToken: string | null;
  resultSizeEstimate: number | null;
  hasMore: boolean;
  cursorAdvanced: boolean;
  syncedAt: Date;
}

async function importMessageReferences(
  user: AuthedUser,
  source: GmailSource,
  accessToken: string,
  references: Array<{ id?: string; threadId?: string }>
) {
  const importedIntakeIds: string[] = [];
  let skippedCount = 0;
  for (const reference of references) {
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
    let rawMessage;
    try {
      rawMessage = await getGmailMessage(accessToken, reference.id);
    } catch (error) {
      if (error instanceof GmailAdapterError && error.code === "MESSAGE_NOT_FOUND") {
        skippedCount += 1;
        continue;
      }
      throw error;
    }
    if (!Array.isArray(rawMessage.labelIds) || !rawMessage.labelIds.includes(GMAIL_INBOX_LABEL)) {
      skippedCount += 1;
      continue;
    }
    const message = parseGmailMessage(rawMessage);
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
          sourceMetadata: { provider: "gmail", labelIds: rawMessage.labelIds },
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
  return { importedIntakeIds, skippedCount };
}

async function performFullSync(
  user: AuthedUser,
  source: GmailSource,
  accessToken: string,
  input: z.infer<typeof syncGmailSchema>,
  fallbackFromExpiredHistory: boolean
): Promise<GmailSyncResult> {
  const initializesCursor = input.full_sync || (!source.syncCursor && !input.query && !input.page_token);
  const profile = initializesCursor ? await getGmailProfile(accessToken) : null;
  if (profile && (!profile.historyId || !/^\d+$/.test(profile.historyId))) {
    throw new GmailAdapterError("PROVIDER_RESPONSE_INVALID");
  }
  const listed = await listGmailMessages(accessToken, {
    maxResults: input.max_results,
    query: input.query,
    pageToken: input.page_token,
  });
  if (listed.messages !== undefined && !Array.isArray(listed.messages)) {
    throw new GmailAdapterError("PROVIDER_RESPONSE_INVALID");
  }
  const imported = await importMessageReferences(user, source, accessToken, listed.messages ?? []);
  const syncedAt = new Date();
  await prisma.connectorSource.update({
    where: { id: source.id },
    data: {
      lastSyncAt: syncedAt,
      lastSyncStatus: "success",
      lastErrorCode: null,
      ...(initializesCursor
        ? { syncCursor: profile!.historyId!, syncPageToken: null, lastFullSyncAt: syncedAt }
        : {}),
    },
  });
  return {
    sourceId: source.id,
    mode: "full",
    fallbackFromExpiredHistory,
    importedCount: imported.importedIntakeIds.length,
    skippedCount: imported.skippedCount,
    importedIntakeIds: imported.importedIntakeIds,
    nextPageToken: listed.nextPageToken ?? null,
    resultSizeEstimate: listed.resultSizeEstimate ?? null,
    hasMore: Boolean(listed.nextPageToken),
    cursorAdvanced: initializesCursor,
    syncedAt,
  };
}

async function performIncrementalSync(
  user: AuthedUser,
  source: GmailSource,
  accessToken: string,
  maxResults: number
): Promise<GmailSyncResult> {
  const listed = await listGmailHistory(accessToken, {
    startHistoryId: source.syncCursor!,
    maxResults,
    pageToken: source.syncPageToken ?? undefined,
  });
  if (listed.history !== undefined && !Array.isArray(listed.history)) {
    throw new GmailAdapterError("PROVIDER_RESPONSE_INVALID");
  }
  const byId = new Map<string, { id: string; threadId?: string }>();
  for (const record of listed.history ?? []) {
    if (record.messagesAdded !== undefined && !Array.isArray(record.messagesAdded)) {
      throw new GmailAdapterError("PROVIDER_RESPONSE_INVALID");
    }
    for (const added of record.messagesAdded ?? []) {
      const id = added.message?.id;
      if (!id) throw new GmailAdapterError("PROVIDER_RESPONSE_INVALID");
      byId.set(id, { id, threadId: added.message?.threadId });
    }
  }
  const imported = await importMessageReferences(user, source, accessToken, [...byId.values()]);
  const hasMore = Boolean(listed.nextPageToken);
  if (!hasMore && (!listed.historyId || !/^\d+$/.test(listed.historyId))) {
    throw new GmailAdapterError("PROVIDER_RESPONSE_INVALID");
  }
  const syncedAt = new Date();
  await prisma.connectorSource.update({
    where: { id: source.id },
    data: {
      lastSyncAt: syncedAt,
      lastSyncStatus: "success",
      lastErrorCode: null,
      syncPageToken: listed.nextPageToken ?? null,
      ...(!hasMore ? { syncCursor: listed.historyId! } : {}),
    },
  });
  return {
    sourceId: source.id,
    mode: "incremental",
    fallbackFromExpiredHistory: false,
    importedCount: imported.importedIntakeIds.length,
    skippedCount: imported.skippedCount,
    importedIntakeIds: imported.importedIntakeIds,
    nextPageToken: null,
    resultSizeEstimate: byId.size,
    hasMore,
    cursorAdvanced: !hasMore,
    syncedAt,
  };
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
    let result: GmailSyncResult;
    const incremental = Boolean(source.syncCursor && !parsed.data.full_sync && !parsed.data.query && !parsed.data.page_token);
    if (incremental) {
      try {
        result = await performIncrementalSync(user, source, credential.accessToken, parsed.data.max_results);
      } catch (error) {
        if (!(error instanceof GmailAdapterError) || error.code !== "HISTORY_CURSOR_EXPIRED") throw error;
        result = await performFullSync(
          user,
          { ...source, syncCursor: null, syncPageToken: null },
          credential.accessToken,
          { max_results: parsed.data.max_results, full_sync: true },
          true
        );
      }
    } else {
      result = await performFullSync(user, source, credential.accessToken, parsed.data, false);
    }
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: SYNC_GMAIL_MESSAGES_ACTION.actionName,
      inputPayload: {
        sourceId,
        maxResults: parsed.data.max_results,
        queryProvided: Boolean(parsed.data.query),
        pageTokenProvided: Boolean(parsed.data.page_token),
        fullSyncRequested: parsed.data.full_sync,
      },
      dataAfter: {
        sourceId,
        mode: result.mode,
        fallbackFromExpiredHistory: result.fallbackFromExpiredHistory,
        importedCount: result.importedCount,
        skippedCount: result.skippedCount,
        importedIntakeIds: result.importedIntakeIds,
        hasMore: result.hasMore,
        cursorAdvanced: result.cursorAdvanced,
        syncedAt: result.syncedAt,
      },
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

function composeAuditSummary(input: z.infer<typeof createGmailDraftSchema>) {
  return {
    toCount: input.to.length,
    ccCount: input.cc.length,
    bccCount: input.bcc.length,
    subjectLength: input.subject.length,
    bodyLength: input.body.length,
  };
}

type ServiceFailure = Extract<ServiceResult<never>, { ok: false }>;
type GmailWriteLookup = { ok: true; source: GmailSource } | { ok: false; failure: ServiceFailure };

async function gmailWriteSource(
  user: AuthedUser,
  sourceId: string,
  logicalScope: "write:drafts" | "send:messages"
): Promise<GmailWriteLookup> {
  const source = await prisma.connectorSource.findFirst({
    where: { id: sourceId, companyId: user.companyId, connectorKey: "gmail", isActive: true },
    include: { credential: true },
  });
  if (!source) return { ok: false, failure: fail(404, "CONNECTOR_SOURCE_NOT_FOUND") as ServiceFailure };
  if (!source.isEnabled) return { ok: false, failure: fail(409, "CONNECTOR_NOT_ENABLED") as ServiceFailure };
  if (!source.configuredScopes.includes(logicalScope)) {
    return { ok: false, failure: fail(409, "CONNECTOR_SCOPE_REQUIRED", `Configure and authorize ${logicalScope} first.`) as ServiceFailure };
  }
  if (!source.credential) return { ok: false, failure: fail(409, "CONNECTOR_AUTHORIZATION_REQUIRED") as ServiceFailure };
  return { ok: true, source };
}

export async function createGmailDraftMessage(
  user: AuthedUser,
  sourceId: string,
  rawInput: unknown
): Promise<ServiceResult<unknown>> {
  const parsed = createGmailDraftSchema.safeParse(rawInput);
  if (!parsed.success) {
    await auditFailure(CREATE_GMAIL_DRAFT_ACTION, user, sourceId, "VALIDATION_FAILED");
    return fail(400, "VALIDATION_FAILED", parsed.error.message);
  }
  const lookup = await gmailWriteSource(user, sourceId, "write:drafts");
  if (!lookup.ok) {
    await auditFailure(CREATE_GMAIL_DRAFT_ACTION, user, sourceId, lookup.failure.error);
    return lookup.failure;
  }
  try {
    const credential = await usableCredential({ credential: lookup.source.credential! });
    if (!credential.scopes.includes(GMAIL_COMPOSE_SCOPE)) throw new GmailAdapterError("SCOPE_DENIED");
    const draft = await createGmailDraft(credential.accessToken, parsed.data);
    if (!draft.id) throw new GmailAdapterError("PROVIDER_RESPONSE_INVALID");
    const result = { sourceId, draftId: draft.id, messageId: draft.message?.id ?? null, threadId: draft.message?.threadId ?? null };
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: CREATE_GMAIL_DRAFT_ACTION.actionName,
      inputPayload: { sourceId, ...composeAuditSummary(parsed.data) },
      dataAfter: result,
      riskLevel: CREATE_GMAIL_DRAFT_ACTION.riskLevel,
      result: "success",
    });
    return ok(201, result);
  } catch (error) {
    const result = providerErrorResult(error);
    await auditFailure(CREATE_GMAIL_DRAFT_ACTION, user, sourceId, result.ok ? "CONNECTOR_INTERNAL_ERROR" : result.error);
    return result;
  }
}

export async function sendGmailMessageNow(
  user: AuthedUser,
  sourceId: string,
  rawInput: unknown
): Promise<ServiceResult<unknown>> {
  const parsed = sendGmailMessageSchema.safeParse(rawInput);
  if (!parsed.success) {
    await auditFailure(SEND_GMAIL_MESSAGE_ACTION, user, sourceId, "VALIDATION_FAILED");
    return fail(400, "VALIDATION_FAILED", parsed.error.message);
  }
  const lookup = await gmailWriteSource(user, sourceId, "send:messages");
  if (!lookup.ok) {
    await auditFailure(SEND_GMAIL_MESSAGE_ACTION, user, sourceId, lookup.failure.error);
    return lookup.failure;
  }
  const { confirmed: _confirmed, ...message } = parsed.data;
  const preview = { sourceId, provider: "gmail", ...message };
  if (!parsed.data.confirmed) {
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: SEND_GMAIL_MESSAGE_ACTION.actionName,
      inputPayload: { sourceId, confirmed: false, ...composeAuditSummary(message) },
      riskLevel: SEND_GMAIL_MESSAGE_ACTION.riskLevel,
      confirmationRequired: true,
      result: "rejected",
      errorMessage: "CONFIRMATION_REQUIRED",
    });
    return fail(409, "CONFIRMATION_REQUIRED", "Review the final recipients, subject and body, then confirm sending.", { preview });
  }
  try {
    const credential = await usableCredential({ credential: lookup.source.credential! });
    if (!credential.scopes.some((scope) => scope === GMAIL_COMPOSE_SCOPE || scope === GMAIL_SEND_SCOPE)) {
      throw new GmailAdapterError("SCOPE_DENIED");
    }
    const sent = await sendGmailMessage(credential.accessToken, message);
    if (!sent.id) throw new GmailAdapterError("PROVIDER_RESPONSE_INVALID");
    const result = { sourceId, messageId: sent.id, threadId: sent.threadId ?? null, sentAt: new Date() };
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: SEND_GMAIL_MESSAGE_ACTION.actionName,
      inputPayload: { sourceId, confirmed: true, ...composeAuditSummary(message) },
      dataAfter: result,
      riskLevel: SEND_GMAIL_MESSAGE_ACTION.riskLevel,
      confirmationRequired: true,
      confirmed: true,
      result: "success",
    });
    return ok(200, result);
  } catch (error) {
    const result = providerErrorResult(error);
    await auditFailure(SEND_GMAIL_MESSAGE_ACTION, user, sourceId, result.ok ? "CONNECTOR_INTERNAL_ERROR" : result.error);
    return result;
  }
}

export async function disconnectGmailSource(
  user: AuthedUser,
  sourceId: string,
  rawInput: unknown
): Promise<ServiceResult<unknown>> {
  const parsed = disconnectGmailSchema.safeParse(rawInput);
  if (!parsed.success) {
    await auditFailure(DISCONNECT_GMAIL_SOURCE_ACTION, user, sourceId, "VALIDATION_FAILED");
    return fail(400, "VALIDATION_FAILED", parsed.error.message);
  }
  const source = await prisma.connectorSource.findFirst({
    where: { id: sourceId, companyId: user.companyId, connectorKey: "gmail", isActive: true },
    include: { credential: true },
  });
  if (!source) {
    await auditFailure(DISCONNECT_GMAIL_SOURCE_ACTION, user, sourceId, "CONNECTOR_SOURCE_NOT_FOUND");
    return fail(404, "CONNECTOR_SOURCE_NOT_FOUND");
  }
  const preview = {
    sourceId,
    provider: "gmail",
    willDisableSource: true,
    willDeleteEncryptedCredential: Boolean(source.credential),
    willRevokeGoogleProjectGrant: Boolean(source.credential),
    warning: "Google revocation can remove every OAuth scope granted to this Google Cloud project for the account.",
  };
  if (!parsed.data.confirmed) {
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: DISCONNECT_GMAIL_SOURCE_ACTION.actionName,
      inputPayload: { sourceId, confirmed: false },
      dataBefore: preview,
      riskLevel: DISCONNECT_GMAIL_SOURCE_ACTION.riskLevel,
      confirmationRequired: true,
      result: "rejected",
      errorMessage: "CONFIRMATION_REQUIRED",
    });
    return fail(409, "CONFIRMATION_REQUIRED", "Review the revoke impact and resubmit with confirmed: true.", { preview });
  }

  await prisma.connectorSource.update({
    where: { id: source.id },
    data: { isEnabled: false, connectionStatus: "disconnecting" },
  });
  try {
    if (source.credential) {
      const credential = decryptConnectorPayload<StoredGmailCredential>(
        source.credential,
        credentialContext(source.companyId, source.id)
      );
      await revokeGmailCredential(credential.refreshToken);
    }
    const disconnectedAt = new Date();
    await prisma.$transaction([
      prisma.connectorCredential.deleteMany({ where: { sourceId: source.id } }),
      prisma.connectorOAuthState.deleteMany({ where: { sourceId: source.id } }),
      prisma.connectorSource.update({
        where: { id: source.id },
        data: {
          isEnabled: false,
          connectionStatus: "disconnected",
          lastErrorCode: null,
          syncCursor: null,
          syncPageToken: null,
          lastFullSyncAt: null,
        },
      }),
    ]);
    const result = { sourceId, provider: "gmail", disconnectedAt, providerGrantRevoked: Boolean(source.credential) };
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: DISCONNECT_GMAIL_SOURCE_ACTION.actionName,
      inputPayload: { sourceId, confirmed: true },
      dataBefore: preview,
      dataAfter: result,
      riskLevel: DISCONNECT_GMAIL_SOURCE_ACTION.riskLevel,
      confirmationRequired: true,
      confirmed: true,
      result: "success",
    });
    return ok(200, result);
  } catch (error) {
    const result = providerErrorResult(error);
    const errorCode = result.ok ? "CONNECTOR_INTERNAL_ERROR" : result.error;
    await prisma.connectorSource.update({
      where: { id: source.id },
      data: { isEnabled: false, connectionStatus: "disconnect_failed", lastErrorCode: errorCode },
    });
    await auditFailure(DISCONNECT_GMAIL_SOURCE_ACTION, user, sourceId, errorCode);
    return result;
  }
}
