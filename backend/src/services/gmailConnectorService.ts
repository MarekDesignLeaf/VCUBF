import { createHash, randomBytes } from "node:crypto";
import { Prisma, type CommunicationIntake } from "@prisma/client";
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
  GMAIL_MODIFY_SCOPE,
  GMAIL_SEND_SCOPE,
  getGmailAccountEmail,
  getGmailMessage,
  getGmailProfile,
  getGmailReplyHeaders,
  GmailAdapterError,
  listGmailHistory,
  listGmailMessages,
  parseGmailMessage,
  refreshGmailCredential,
  revokeGmailCredential,
  sendGmailMessage,
  trashGmailMessage,
  type StoredGmailCredential,
  type GmailComposeInput,
} from "../connectors/gmailAdapter.js";
import {
  COMPLETE_GMAIL_OAUTH_ACTION,
  CREATE_GMAIL_DRAFT_ACTION,
  DELETE_GMAIL_INTAKE_ACTION,
  DISCONNECT_GMAIL_SOURCE_ACTION,
  REPLY_GMAIL_MESSAGE_ACTION,
  START_GMAIL_OAUTH_ACTION,
  SEND_GMAIL_MESSAGE_ACTION,
  SET_DEFAULT_GMAIL_SENDER_ACTION,
  SYNC_GMAIL_MESSAGES_ACTION,
  type ActionContract,
} from "../lib/actionContracts.js";
import { recordAudit } from "../lib/audit.js";
import { chooseGmailSendingAccount, gmailAccountLabel } from "../lib/gmailAccountChoice.js";
import { frontendUrl } from "../lib/frontendUrl.js";
import type { AuthedUser } from "../middleware/auth.js";
import { fail, ok, type ServiceResult } from "./result.js";
import { TranslationUnavailable, translateOutgoingMessage, type OutgoingTranslation } from "./translationService.js";

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
export const deleteGmailIntakeSchema = z.object({ confirmed: z.boolean().optional() }).strict();

const gmailAddressSchema = z.string().trim().email().max(320).refine((value) => !/[\r\n]/.test(value), "Invalid email address");
const gmailComposeFields = {
  to: z.array(gmailAddressSchema).min(1).max(20),
  cc: z.array(gmailAddressSchema).max(20).default([]),
  bcc: z.array(gmailAddressSchema).max(20).default([]),
  subject: z.string().min(1).max(998).refine((value) => !/[\r\n]/.test(value), "Subject must be one line"),
  body: z.string().min(1).max(100_000),
};
export const createGmailDraftSchema = z.object(gmailComposeFields).strict();
export const replyGmailMessageSchema = z.object({
  /** The exact received email being answered, as bound by a reviewed reply. */
  intake_id: z.string().trim().min(1).max(100).optional(),
  /** Who or what is being answered: a sender's name or address, words from the email, or "last". */
  sender_or_message: z.string().trim().min(1).max(300).optional(),
  body: z.string().trim().min(1).max(100_000),
  send_in: z.string().trim().min(1).max(40).optional(),
  confirmed: z.boolean().optional(),
}).strict();

export const sendGmailMessageSchema = z.object({
  ...gmailComposeFields,
  /** Dictate in one language, send in another: "en-GB", "English", "anglicky". */
  send_in: z.string().trim().min(1).max(40).optional(),
  confirmed: z.boolean().optional(),
}).strict();

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
    // Which Google account was chosen on Google's screen. Read from Google
    // (the Gmail profile, or the account email for a send-only grant), never
    // assumed: a source re-authorised as another account must not keep the
    // old address. If Google does not say, it is stored as unknown.
    const accountEmail = await authorisedAccountEmail(credential);
    if (accountEmail) {
      const twin = await prisma.connectorSource.findFirst({
        where: {
          companyId: oauthState.companyId,
          connectorKey: "gmail",
          isActive: true,
          id: { not: oauthState.sourceId },
          accountEmail: { equals: accountEmail, mode: "insensitive" },
        },
        select: { displayName: true },
      });
      if (twin) {
        // The same mailbox twice would import every message twice.
        await auditFailure(COMPLETE_GMAIL_OAUTH_ACTION, oauthState, oauthState.sourceId, "GMAIL_ACCOUNT_ALREADY_CONNECTED");
        return fail(409, "GMAIL_ACCOUNT_ALREADY_CONNECTED", `${accountEmail} is already connected as ${twin.displayName}. Authorize this source again and choose the other Google account.`);
      }
    }
    const otherDefaults = await prisma.connectorSource.count({
      where: { companyId: oauthState.companyId, connectorKey: "gmail", isActive: true, isDefaultSender: true, id: { not: oauthState.sourceId } },
    });
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
          accountEmail,
          // The first account the company connects sends by default; a later
          // one never takes that over silently.
          ...(otherDefaults === 0 ? { isDefaultSender: true } : {}),
        },
      }),
    ]);
    await recordAudit({
      companyId: oauthState.companyId,
      userId: oauthState.userId,
      actionName: COMPLETE_GMAIL_OAUTH_ACTION.actionName,
      inputPayload: { sourceId: oauthState.sourceId },
      dataAfter: { sourceId: oauthState.sourceId, provider: "gmail", scopeVerified: true, encrypted: true, accountEmail, defaultSender: otherDefaults === 0 },
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

async function authorisedAccountEmail(credential: StoredGmailCredential) {
  try {
    const parsed = gmailAddressSchema.safeParse(await getGmailAccountEmail(credential.accessToken, credential.scopes));
    return parsed.success ? parsed.data.toLowerCase() : null;
  } catch {
    return null;
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
  removedCount: number;
  skippedCount: number;
  importedIntakeIds: string[];
  nextPageToken: string | null;
  resultSizeEstimate: number | null;
  hasMore: boolean;
  cursorAdvanced: boolean;
  syncedAt: Date;
}

async function removeImportedMessageReferences(
  user: AuthedUser,
  source: GmailSource,
  externalMessageIds: string[]
) {
  if (externalMessageIds.length === 0) return 0;
  const intakes = await prisma.communicationIntake.findMany({
    where: {
      companyId: user.companyId,
      connectorSourceId: source.id,
      externalMessageId: { in: [...new Set(externalMessageIds)] },
    },
    select: { id: true },
  });
  if (intakes.length === 0) return 0;
  const intakeIds = intakes.map((intake) => intake.id);
  await prisma.$transaction([
    prisma.notificationAcknowledgement.deleteMany({
      where: {
        companyId: user.companyId,
        notificationKey: { in: intakeIds.map((id) => `unresolved_enquiry:${id}`) },
      },
    }),
    prisma.communicationIntake.deleteMany({
      where: { companyId: user.companyId, connectorSourceId: source.id, id: { in: intakeIds } },
    }),
  ]);
  return intakeIds.length;
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
  const importedIntakeIds: string[] = [];
  const remoteMessageIds = new Set<string>();
  const seenPageTokens = new Set<string>();
  let skippedCount = 0;
  let pageToken = input.page_token;
  let nextPageToken: string | null = null;
  let resultSizeEstimate: number | null = null;
  do {
    const listed = await listGmailMessages(accessToken, {
      maxResults: input.max_results,
      query: input.query,
      pageToken,
    });
    if (listed.messages !== undefined && !Array.isArray(listed.messages)) {
      throw new GmailAdapterError("PROVIDER_RESPONSE_INVALID");
    }
    for (const reference of listed.messages ?? []) {
      if (!reference?.id) throw new GmailAdapterError("PROVIDER_RESPONSE_INVALID");
      remoteMessageIds.add(reference.id);
    }
    const imported = await importMessageReferences(user, source, accessToken, listed.messages ?? []);
    importedIntakeIds.push(...imported.importedIntakeIds);
    skippedCount += imported.skippedCount;
    resultSizeEstimate ??= listed.resultSizeEstimate ?? null;
    nextPageToken = listed.nextPageToken ?? null;
    if (!initializesCursor || !nextPageToken) break;
    if (seenPageTokens.has(nextPageToken)) throw new GmailAdapterError("PROVIDER_RESPONSE_INVALID");
    seenPageTokens.add(nextPageToken);
    pageToken = nextPageToken;
  } while (true);

  let removedCount = 0;
  if (initializesCursor) {
    const localMessages = await prisma.communicationIntake.findMany({
      where: { companyId: user.companyId, connectorSourceId: source.id, externalMessageId: { not: null } },
      select: { externalMessageId: true },
    });
    removedCount = await removeImportedMessageReferences(
      user,
      source,
      localMessages
        .map((message) => message.externalMessageId)
        .filter((id): id is string => typeof id === "string" && !remoteMessageIds.has(id))
    );
  }
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
    importedCount: importedIntakeIds.length,
    removedCount,
    skippedCount,
    importedIntakeIds,
    nextPageToken: initializesCursor ? null : nextPageToken,
    resultSizeEstimate,
    hasMore: initializesCursor ? false : Boolean(nextPageToken),
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
  const removedIds = new Set<string>();
  for (const record of listed.history ?? []) {
    if (record.messagesAdded !== undefined && !Array.isArray(record.messagesAdded)) {
      throw new GmailAdapterError("PROVIDER_RESPONSE_INVALID");
    }
    for (const added of record.messagesAdded ?? []) {
      const id = added.message?.id;
      if (!id) throw new GmailAdapterError("PROVIDER_RESPONSE_INVALID");
      byId.set(id, { id, threadId: added.message?.threadId });
    }
    if (record.messagesDeleted !== undefined && !Array.isArray(record.messagesDeleted)) {
      throw new GmailAdapterError("PROVIDER_RESPONSE_INVALID");
    }
    for (const deleted of record.messagesDeleted ?? []) {
      const id = deleted.message?.id;
      if (!id) throw new GmailAdapterError("PROVIDER_RESPONSE_INVALID");
      removedIds.add(id);
      byId.delete(id);
    }
    if (record.labelsAdded !== undefined && !Array.isArray(record.labelsAdded)) {
      throw new GmailAdapterError("PROVIDER_RESPONSE_INVALID");
    }
    for (const changed of record.labelsAdded ?? []) {
      if (!Array.isArray(changed.labelIds)) throw new GmailAdapterError("PROVIDER_RESPONSE_INVALID");
      const id = changed.message?.id;
      if (!id) throw new GmailAdapterError("PROVIDER_RESPONSE_INVALID");
      if (changed.labelIds.includes(GMAIL_INBOX_LABEL) && !removedIds.has(id)) {
        byId.set(id, { id, threadId: changed.message?.threadId });
      }
    }
    if (record.labelsRemoved !== undefined && !Array.isArray(record.labelsRemoved)) {
      throw new GmailAdapterError("PROVIDER_RESPONSE_INVALID");
    }
    for (const changed of record.labelsRemoved ?? []) {
      if (!Array.isArray(changed.labelIds)) throw new GmailAdapterError("PROVIDER_RESPONSE_INVALID");
      const id = changed.message?.id;
      if (!id) throw new GmailAdapterError("PROVIDER_RESPONSE_INVALID");
      if (changed.labelIds.includes(GMAIL_INBOX_LABEL)) {
        removedIds.add(id);
        byId.delete(id);
      }
    }
  }
  const removedCount = await removeImportedMessageReferences(user, source, [...removedIds]);
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
    removedCount,
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
        removedCount: result.removedCount,
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
    if (!credential.scopes.some((scope) => scope === GMAIL_COMPOSE_SCOPE || scope === GMAIL_MODIFY_SCOPE)) {
      throw new GmailAdapterError("SCOPE_DENIED");
    }
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
  const { confirmed: _confirmed, send_in: sendIn, ...dictated } = parsed.data;
  // Dictated in one language, sent in another. The translation is made now,
  // before approval, so the person approves the words that will actually leave
  // the building. On the confirmed call there is nothing left to translate: the
  // approved text IS the message, and translating again could produce something
  // nobody read (section 41).
  let message = dictated;
  let translation: OutgoingTranslation | undefined;
  if (sendIn) {
    if (parsed.data.confirmed) {
      return fail(400, "TRANSLATION_AFTER_APPROVAL", "Confirm the message that was reviewed; it is already in the language it will be sent in.");
    }
    try {
      translation = await translateOutgoingMessage(dictated, sendIn);
      message = { ...dictated, body: translation.body, subject: translation.subject ?? dictated.subject };
    } catch (error) {
      if (error instanceof TranslationUnavailable) return fail(503, error.reason, error.message);
      throw error;
    }
  }
  const preview = {
    sourceId, provider: "gmail",
    fromAccount: lookup.source.accountEmail ?? lookup.source.displayName,
    ...message,
    ...(translation ? { sentIn: translation.languageLabel, dictated: translation.original } : {}),
  };
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
    return fail(409, "CONFIRMATION_REQUIRED", "Review the final recipients, subject and body, then confirm sending.", {
      preview,
      // What confirmation must send: the reviewed operation, not the sentence
      // that asked for it.
      confirmInput: message,
    });
  }
  try {
    const credential = await usableCredential({ credential: lookup.source.credential! });
    if (!credential.scopes.some((scope) => scope === GMAIL_COMPOSE_SCOPE || scope === GMAIL_SEND_SCOPE || scope === GMAIL_MODIFY_SCOPE)) {
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

export type SendableGmailSource = { id: string; displayName: string; accountEmail: string | null };

/**
 * Resolve the Gmail source a message may be sent from. With an explicit
 * sourceId the source must be enabled with send:messages and authorised.
 * Without one, the account the user named ("from the business account",
 * an address) is used; failing a name, the only sendable account, else the
 * company's default sender. Otherwise the caller must choose.
 */
export async function resolveSendableGmailSource(user: AuthedUser, sourceId?: string, from?: string): Promise<ServiceResult<SendableGmailSource>> {
  if (sourceId) {
    const lookup = await gmailWriteSource(user, sourceId, "send:messages");
    return lookup.ok ? ok(200, { id: lookup.source.id, displayName: lookup.source.displayName, accountEmail: lookup.source.accountEmail }) : lookup.failure;
  }
  const sources = await prisma.connectorSource.findMany({
    where: { companyId: user.companyId, connectorKey: "gmail", isActive: true },
    include: { credential: { select: { sourceId: true } } },
    orderBy: { displayName: "asc" },
  });
  if (sources.length === 0) return fail(409, "GMAIL_NOT_CONFIGURED", "Gmail is not connected. Open Connectors first.");
  const enabled = sources.filter((source) => source.isEnabled);
  if (enabled.length === 0) return fail(409, "CONNECTOR_NOT_ENABLED", "Gmail is connected but not enabled.");
  const canSend = enabled.filter((source) => source.configuredScopes.includes("send:messages"));
  if (canSend.length === 0) return fail(409, "CONNECTOR_SCOPE_REQUIRED", "No enabled Gmail source has permission to send email.");
  const authorised = canSend.filter((source) => Boolean(source.credential));
  if (authorised.length === 0) return fail(409, "CONNECTOR_AUTHORIZATION_REQUIRED", "Gmail needs to be authorized again before sending.");
  const choice = chooseGmailSendingAccount(authorised, from, user.voiceLanguage);
  if (!choice.ok) {
    const accounts = choice.candidates.map(gmailAccountLabel);
    return fail(409, choice.error, choice.error === "GMAIL_ACCOUNT_NOT_FOUND"
      ? `No connected Gmail account matches “${from}”. Connected: ${accounts.join(", ")}.`
      : "More than one Gmail account can send email; name one, or choose a default sender in Connectors.", {
      accounts,
      sourceNames: choice.candidates.map((source) => source.displayName),
      sourceIds: choice.candidates.map((source) => source.id),
    });
  }
  return ok(200, { id: choice.source.id, displayName: choice.source.displayName, accountEmail: choice.source.accountEmail });
}

/**
 * Make one connected Gmail account the company's default sender: the account
 * used when nobody names another. Internal setting, audited, no external
 * effect; the previous default is recorded so the change can be reversed.
 */
export async function setDefaultGmailSender(user: AuthedUser, sourceId: string): Promise<ServiceResult<SendableGmailSource & { previousDefaultSourceId: string | null }>> {
  if (!user.permissions.includes(SET_DEFAULT_GMAIL_SENDER_ACTION.requiredPermission)) {
    await auditFailure(SET_DEFAULT_GMAIL_SENDER_ACTION, user, sourceId, "MISSING_PERMISSION");
    return fail(403, "MISSING_PERMISSION");
  }
  const source = await prisma.connectorSource.findFirst({
    where: { id: sourceId, companyId: user.companyId, connectorKey: "gmail", isActive: true },
    select: { id: true, displayName: true, accountEmail: true, configuredScopes: true, isEnabled: true, credential: { select: { sourceId: true } } },
  });
  if (!source) {
    await auditFailure(SET_DEFAULT_GMAIL_SENDER_ACTION, user, sourceId, "CONNECTOR_SOURCE_NOT_FOUND");
    return fail(404, "CONNECTOR_SOURCE_NOT_FOUND");
  }
  // Only an account that can send right now may become the default: a
  // disabled or unauthorised default would be skipped when sending, and two
  // usable accounts would be left with no default at all.
  if (!source.configuredScopes.includes("send:messages")) {
    await auditFailure(SET_DEFAULT_GMAIL_SENDER_ACTION, user, sourceId, "CONNECTOR_SCOPE_REQUIRED");
    return fail(409, "CONNECTOR_SCOPE_REQUIRED", "This Gmail source is not allowed to send email. Add Send email to its scopes first.");
  }
  if (!source.credential) {
    await auditFailure(SET_DEFAULT_GMAIL_SENDER_ACTION, user, sourceId, "CONNECTOR_AUTHORIZATION_REQUIRED");
    return fail(409, "CONNECTOR_AUTHORIZATION_REQUIRED", "Authorize this Gmail account before making it the default sender.");
  }
  if (!source.isEnabled) {
    await auditFailure(SET_DEFAULT_GMAIL_SENDER_ACTION, user, sourceId, "CONNECTOR_NOT_ENABLED");
    return fail(409, "CONNECTOR_NOT_ENABLED", "Enable this Gmail account before making it the default sender.");
  }
  const previous = await prisma.$transaction(async (tx) => {
    const before = await tx.connectorSource.findFirst({
      where: { companyId: user.companyId, connectorKey: "gmail", isDefaultSender: true, id: { not: source.id } },
      select: { id: true },
    });
    await tx.connectorSource.updateMany({
      where: { companyId: user.companyId, connectorKey: "gmail", isDefaultSender: true, id: { not: source.id } },
      data: { isDefaultSender: false },
    });
    await tx.connectorSource.update({ where: { id: source.id }, data: { isDefaultSender: true } });
    return before?.id ?? null;
  });
  const result = { id: source.id, displayName: source.displayName, accountEmail: source.accountEmail, previousDefaultSourceId: previous };
  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: SET_DEFAULT_GMAIL_SENDER_ACTION.actionName,
    inputPayload: { sourceId },
    dataBefore: { defaultSourceId: previous },
    dataAfter: { defaultSourceId: source.id, accountEmail: source.accountEmail },
    riskLevel: SET_DEFAULT_GMAIL_SENDER_ACTION.riskLevel,
    result: "success",
  });
  return ok(200, result);
}

/**
 * Send a composed message (optionally with attachments) through an already
 * resolved, sendable Gmail source. Performs no audit of its own: the calling
 * business action (send_quote_pdf, send_invoice_pdf, …) owns the audit record,
 * the confirmation gate and any CRM side effects. Returns provider ids only.
 */
export async function sendThroughGmailSource(user: AuthedUser, sourceId: string, message: GmailComposeInput): Promise<ServiceResult<{ sourceId: string; messageId: string; threadId: string | null; sentAt: Date }>> {
  const lookup = await gmailWriteSource(user, sourceId, "send:messages");
  if (!lookup.ok) return lookup.failure;
  try {
    const credential = await usableCredential({ credential: lookup.source.credential! });
    if (!credential.scopes.some((scope) => scope === GMAIL_COMPOSE_SCOPE || scope === GMAIL_SEND_SCOPE || scope === GMAIL_MODIFY_SCOPE)) {
      throw new GmailAdapterError("SCOPE_DENIED");
    }
    const sent = await sendGmailMessage(credential.accessToken, message);
    if (!sent.id) throw new GmailAdapterError("PROVIDER_RESPONSE_INVALID");
    return ok(200, { sourceId, messageId: sent.id, threadId: sent.threadId ?? null, sentAt: new Date() });
  } catch (error) {
    return providerErrorResult(error);
  }
}

// --- replying to a received email ---------------------------------------------

// Replies leave in English unless another language is named: the owner
// dictates in Czech, his customers read English.
const DEFAULT_REPLY_LANGUAGE = "en-GB";
// "last" is what the model is told to write; the user's own word for it is
// accepted too, since the reference reaches here only in the language that is on.
const LATEST_WORDS = new Set(["last", "latest", "newest", "recent", "posledni", "nejnovejsi", "ostatni", "ostatnia", "najnowszy", "najnowsza"]);

type EmailReplyTarget = CommunicationIntake & { connectorSourceId: string; externalMessageId: string; senderEmail: string };

function replyableEmail(intake: CommunicationIntake): intake is EmailReplyTarget {
  return Boolean(intake.connectorSourceId && intake.externalMessageId && intake.senderEmail);
}

// The sender's address comes from the email's own From line, which its sender
// wrote. A reply goes there only if it is exactly one valid address: a From
// line listing two addresses would otherwise copy the reply to the second.
function singleValidAddress(address: string) {
  return gmailAddressSchema.safeParse(address).success && !/[,;\s]/.test(address);
}

function plainWords(value: unknown) {
  return String(value ?? "").normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase("en").replace(/\s+/g, " ").trim();
}

/** The subject the email was imported with ("Subject: …" leads the stored text). */
function importedSubject(intake: CommunicationIntake) {
  return intake.messageText.match(/^Subject: ([^\n]*)/)?.[1]?.trim() ?? "";
}

function importedBody(intake: CommunicationIntake) {
  return intake.messageText.replace(/^Subject: [^\n]*\n\n?/, "").trim();
}

function replySubject(original: string) {
  if (!original) return "Re:";
  return /^re:/i.test(original) ? original : `Re: ${original}`;
}

/**
 * Finds the received email being answered. A sender's name or address picks
 * that sender's most recent email; "last" the most recent email from anyone;
 * otherwise words from the email itself are matched. A reference that fits more
 * than one sender is refused rather than guessed.
 */
async function emailReplyTarget(
  user: AuthedUser,
  input: { intake_id?: string; sender_or_message?: string }
): Promise<ServiceResult<EmailReplyTarget>> {
  if (input.intake_id) {
    const intake = await prisma.communicationIntake.findFirst({
      where: { id: input.intake_id, companyId: user.companyId, channel: "email" },
    });
    return intake && replyableEmail(intake) ? ok(200, intake) : fail(404, "EMAIL_MESSAGE_NOT_FOUND", "That email was not found.");
  }
  // Only what the choice needs is read: an email body can be long, and this
  // runs on every spoken reply.
  const received = (await prisma.communicationIntake.findMany({
    where: { companyId: user.companyId, channel: "email", connectorSourceId: { not: null }, externalMessageId: { not: null }, senderEmail: { not: null } },
    orderBy: { receivedAt: "desc" },
    take: 300,
    select: { id: true, senderName: true, senderEmail: true, messageText: true },
  })).filter((intake): intake is typeof intake & { senderEmail: string } => Boolean(intake.senderEmail));
  if (!received.length) return fail(404, "EMAIL_MESSAGE_NOT_FOUND", "There is no received email to reply to.");

  const needle = plainWords(input.sender_or_message);
  const needleWords = needle.split(" ").filter(Boolean);
  const wantsLatest = !needle || needleWords.some((word) => LATEST_WORDS.has(word));
  const named = needleWords.filter((word) => !LATEST_WORDS.has(word)).join(" ");
  const namedWords = named.split(" ").filter(Boolean);
  // A sender is named by address, by the part before the @ or its pieces
  // (petra.dvorakova), or by display name.
  const bySender = named ? received.filter((intake) => {
    const address = intake.senderEmail.toLowerCase();
    if (named.includes("@")) return address === named;
    const local = address.split("@")[0];
    if (local === named || local.split(/[._+-]/).some((piece) => piece.length >= 3 && namedWords.includes(piece))) return true;
    const name = plainWords(intake.senderName);
    if (!name) return false;
    if (name === named || (named.length >= 2 && name.includes(named))) return true;
    return name.split(" ").some((word) => word.length >= 3 && namedWords.includes(word));
  }) : [];
  const byText = named.length >= 4 ? received.filter((intake) => plainWords(intake.messageText).includes(named)) : [];
  // "the last one from Petra" is Petra's latest; "last" alone is the newest from anyone.
  const matches = bySender.length ? bySender : named ? byText : wantsLatest ? [received[0]] : [];
  if (!matches.length) return fail(404, "EMAIL_MESSAGE_NOT_FOUND", `No received email matches '${input.sender_or_message}'.`);
  const senders = [...new Set(matches.map((intake) => intake.senderEmail.toLowerCase()))];
  if (senders.length > 1) {
    const names = [...new Set(matches.map((intake) => intake.senderName ? `${intake.senderName} (${intake.senderEmail})` : intake.senderEmail))].slice(0, 5);
    return fail(409, "AMBIGUOUS_REFERENCE", `More than one sender matches '${input.sender_or_message}': ${names.join(", ")}.`, { candidates: names });
  }
  const chosen = await prisma.communicationIntake.findFirst({ where: { id: matches[0].id, companyId: user.companyId } });
  return chosen && replyableEmail(chosen) ? ok(200, chosen) : fail(404, "EMAIL_MESSAGE_NOT_FOUND", "That email was not found.");
}

/**
 * Reply to one received email. The recipient is that email's sender, the
 * account is the mailbox it arrived in, and the reply stays in the same
 * conversation; nothing spoken can change any of the three. The text is
 * translated (English unless another language is named) before the review, so
 * the yes approves the words that will be sent, and the confirmed call sends
 * exactly the reviewed text once.
 */
export async function replyToGmailMessage(user: AuthedUser, rawInput: unknown): Promise<ServiceResult<unknown>> {
  const parsed = replyGmailMessageSchema.safeParse(rawInput);
  if (!parsed.success) return fail(400, "VALIDATION_FAILED", parsed.error.message);
  if (parsed.data.confirmed && !parsed.data.intake_id) {
    return fail(400, "VALIDATION_FAILED", "Confirm the reviewed reply; it names the exact email being answered.");
  }
  if (parsed.data.confirmed && parsed.data.send_in) {
    return fail(400, "TRANSLATION_AFTER_APPROVAL", "Confirm the reply that was reviewed; it is already in the language it will be sent in.");
  }
  const target = await emailReplyTarget(user, parsed.data);
  if (!target.ok) return target;
  const intake = target.data;
  const sourceId = intake.connectorSourceId;
  const auditInput = (confirmed: boolean) => ({ sourceId, intakeId: intake.id, confirmed, bodyLength: parsed.data.body.length });
  const audit = (confirmed: boolean, result: "success" | "rejected" | "error", extra: { errorMessage?: string; dataAfter?: Record<string, unknown> } = {}) => recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: REPLY_GMAIL_MESSAGE_ACTION.actionName,
    inputPayload: auditInput(confirmed),
    riskLevel: REPLY_GMAIL_MESSAGE_ACTION.riskLevel,
    confirmationRequired: true,
    ...(confirmed ? { confirmed: true } : {}),
    result,
    ...extra,
  });

  if (!singleValidAddress(intake.senderEmail)) {
    await audit(Boolean(parsed.data.confirmed), "rejected", { errorMessage: "EMAIL_SENDER_ADDRESS_INVALID" });
    return fail(409, "EMAIL_SENDER_ADDRESS_INVALID", "The sender's address on this email is not one valid address, so it cannot be answered from here. Reply from Gmail instead.");
  }

  // The mailbox the email arrived in sends the reply. If it cannot send, the
  // owner is told so; the reply never silently leaves from another account.
  const lookup = await gmailWriteSource(user, sourceId, "send:messages");
  if (!lookup.ok) {
    await audit(Boolean(parsed.data.confirmed), "rejected", { errorMessage: lookup.failure.error });
    return lookup.failure;
  }
  const fromAccount = lookup.source.accountEmail ?? lookup.source.displayName;
  const originalSubject = importedSubject(intake);
  const subject = replySubject(originalSubject);

  if (!parsed.data.confirmed) {
    let translation: OutgoingTranslation;
    try {
      translation = await translateOutgoingMessage({ body: parsed.data.body }, parsed.data.send_in ?? DEFAULT_REPLY_LANGUAGE);
    } catch (error) {
      if (error instanceof TranslationUnavailable) return fail(503, error.reason, error.message);
      throw error;
    }
    const preview = {
      sourceId,
      provider: "gmail",
      intakeId: intake.id,
      fromAccount,
      to: [intake.senderEmail],
      recipientName: intake.senderName,
      inReplyTo: { receivedAt: intake.receivedAt, subject: originalSubject, text: importedBody(intake).slice(0, 500) },
      subject,
      body: translation.body,
      sentIn: translation.languageLabel,
      dictated: translation.original.body,
    };
    await audit(false, "rejected", { errorMessage: "CONFIRMATION_REQUIRED" });
    return fail(409, "CONFIRMATION_REQUIRED", "Review who the reply goes to, the account it leaves from, the email it answers and the final text, then confirm sending.", {
      preview,
      // Confirmation sends exactly this: the reviewed text, to the sender of
      // this one email, from the account it arrived in.
      confirmInput: { intake_id: intake.id, body: translation.body },
    });
  }

  let sent: { id: string; threadId?: string };
  try {
    const credential = await usableCredential({ credential: lookup.source.credential! });
    if (!credential.scopes.some((scope) => scope === GMAIL_COMPOSE_SCOPE || scope === GMAIL_SEND_SCOPE || scope === GMAIL_MODIFY_SCOPE)) {
      throw new GmailAdapterError("SCOPE_DENIED");
    }
    // The original's Message-ID keeps the reply in the customer's conversation
    // too. Without it (the account may not be allowed to read, or the email
    // was deleted) the reply still goes, to the same person and thread.
    let headers: Awaited<ReturnType<typeof getGmailReplyHeaders>> | undefined;
    try {
      headers = await getGmailReplyHeaders(credential.accessToken, intake.externalMessageId);
    } catch {
      headers = undefined;
    }
    sent = await sendGmailMessage(credential.accessToken, {
      to: [intake.senderEmail],
      subject,
      body: parsed.data.body,
      reply: { threadId: intake.externalThreadId ?? headers?.threadId, messageId: headers?.messageId, references: headers?.references },
    });
    if (!sent.id) throw new GmailAdapterError("PROVIDER_RESPONSE_INVALID");
  } catch (error) {
    const result = providerErrorResult(error);
    await audit(true, "error", { errorMessage: result.ok ? "CONNECTOR_INTERNAL_ERROR" : result.error });
    return result;
  }

  // Sent. Nothing after this point may report the reply as failed, or the
  // owner would be invited to send it a second time.
  const sentAt = new Date();
  const metadata = intake.sourceMetadata && typeof intake.sourceMetadata === "object" && !Array.isArray(intake.sourceMetadata)
    ? intake.sourceMetadata as Record<string, unknown>
    : {};
  const replies = Array.isArray(metadata.replies) ? metadata.replies : [];
  try {
    await prisma.communicationIntake.update({
      where: { id: intake.id },
      data: {
        sourceMetadata: {
          ...metadata,
          replies: [...replies, { messageId: sent.id, threadId: sent.threadId ?? null, sentAt: sentAt.toISOString(), sentBy: user.id, body: parsed.data.body }],
        } as Prisma.InputJsonValue,
      },
    });
  } catch {
    // The reply has already left. A failed note on the email must not make a
    // sent reply look unsent and invite a second send; the audit records it.
  }
  const recorded = { sourceId, intakeId: intake.id, messageId: sent.id, threadId: sent.threadId ?? null, sentAt };
  try {
    await audit(true, "success", { dataAfter: recorded });
  } catch (error) {
    console.error("reply_gmail_message sent but its audit record failed", error instanceof Error ? error.message : error);
  }
  return ok(200, { ...recorded, fromAccount, to: [intake.senderEmail] });
}

export async function deleteGmailIntake(
  user: AuthedUser,
  intakeId: string,
  rawInput: unknown
): Promise<ServiceResult<unknown>> {
  const parsed = deleteGmailIntakeSchema.safeParse(rawInput);
  if (!parsed.success) {
    await auditFailure(DELETE_GMAIL_INTAKE_ACTION, user, intakeId, "VALIDATION_FAILED");
    return fail(400, "VALIDATION_FAILED", parsed.error.message);
  }
  if (!user.permissions.includes("crm.manage")) {
    await auditFailure(DELETE_GMAIL_INTAKE_ACTION, user, intakeId, "MISSING_PERMISSION");
    return fail(403, "MISSING_PERMISSION", "CRM management permission is required to delete a local email copy.");
  }

  const intake = await prisma.communicationIntake.findFirst({
    where: { id: intakeId, companyId: user.companyId },
    include: { connectorSource: { include: { credential: true } } },
  });
  if (!intake) {
    await auditFailure(DELETE_GMAIL_INTAKE_ACTION, user, intakeId, "COMMUNICATION_INTAKE_NOT_FOUND");
    return fail(404, "COMMUNICATION_INTAKE_NOT_FOUND");
  }
  const source = intake.connectorSource;
  if (intake.channel !== "email" || !intake.externalMessageId || !source || source.connectorKey !== "gmail") {
    await auditFailure(DELETE_GMAIL_INTAKE_ACTION, user, intakeId, "GMAIL_SOURCE_REQUIRED");
    return fail(409, "GMAIL_SOURCE_REQUIRED", "Only an email imported from Gmail can be removed from both Secretary and its source mailbox.");
  }

  const subject = intake.messageText.match(/^Subject:\s*(.+)$/im)?.[1]?.trim() ?? null;
  const preview = {
    intakeId: intake.id,
    sourceId: source.id,
    sender: intake.senderName || intake.senderEmail || "Unknown sender",
    subject,
    receivedAt: intake.receivedAt,
    providerAction: "move_to_gmail_trash",
    localAction: "delete_communication_intake",
    linkedCommunicationRecordPreserved: Boolean(intake.communicationRecordId),
    reversibleAtProvider: true,
  };
  if (!parsed.data.confirmed) {
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: DELETE_GMAIL_INTAKE_ACTION.actionName,
      inputPayload: { intakeId, sourceId: source.id, confirmed: false },
      dataBefore: { externalMessageId: intake.externalMessageId, receivedAt: intake.receivedAt },
      riskLevel: DELETE_GMAIL_INTAKE_ACTION.riskLevel,
      confirmationRequired: true,
      result: "rejected",
      errorMessage: "CONFIRMATION_REQUIRED",
    });
    return fail(409, "CONFIRMATION_REQUIRED", "Confirm moving this message to Gmail Trash and deleting its local Secretary copy.", { preview });
  }
  if (!source.isEnabled) return fail(409, "CONNECTOR_NOT_ENABLED", "Enable the Gmail source before deleting mail.");
  if (!source.configuredScopes.includes("delete:messages")) {
    return fail(409, "CONNECTOR_SCOPE_REQUIRED", "Enable email deletion in Connectors and reauthorize Gmail first.");
  }
  if (!source.credential) return fail(409, "CONNECTOR_AUTHORIZATION_REQUIRED", "Reauthorize Gmail before deleting mail.");

  let sourceAlreadyMissing = false;
  try {
    const credential = await usableCredential({ credential: source.credential });
    if (!credential.scopes.includes(GMAIL_MODIFY_SCOPE)) throw new GmailAdapterError("SCOPE_DENIED");
    const trashed = await trashGmailMessage(credential.accessToken, intake.externalMessageId);
    if (!trashed.id) throw new GmailAdapterError("PROVIDER_RESPONSE_INVALID");
  } catch (error) {
    if (error instanceof GmailAdapterError && error.code === "MESSAGE_NOT_FOUND") {
      sourceAlreadyMissing = true;
    } else {
      const result = providerErrorResult(error);
      await auditFailure(DELETE_GMAIL_INTAKE_ACTION, user, source.id, result.ok ? "CONNECTOR_INTERNAL_ERROR" : result.error);
      return result;
    }
  }

  try {
    await prisma.$transaction([
      prisma.notificationAcknowledgement.deleteMany({
        where: { companyId: user.companyId, notificationKey: `unresolved_enquiry:${intake.id}` },
      }),
      prisma.communicationIntake.delete({ where: { id: intake.id } }),
    ]);
  } catch {
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: DELETE_GMAIL_INTAKE_ACTION.actionName,
      inputPayload: { intakeId, sourceId: source.id, confirmed: true },
      dataAfter: { providerTrashed: !sourceAlreadyMissing, sourceAlreadyMissing, localDeleted: false },
      riskLevel: DELETE_GMAIL_INTAKE_ACTION.riskLevel,
      confirmationRequired: true,
      confirmed: true,
      result: "error",
      errorMessage: "LOCAL_DELETE_FAILED",
    });
    return fail(500, "LOCAL_DELETE_FAILED", "The source message is in Gmail Trash, but the local copy could not be removed. Retry the deletion.");
  }

  const result = {
    intakeId,
    sourceId: source.id,
    movedToGmailTrash: !sourceAlreadyMissing,
    sourceAlreadyMissing,
    localDeleted: true,
    linkedCommunicationRecordPreserved: Boolean(intake.communicationRecordId),
    message: sourceAlreadyMissing
      ? "The source message was already absent. Its local Secretary copy was deleted."
      : "The email was moved to Gmail Trash and its local Secretary copy was deleted.",
  };
  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: DELETE_GMAIL_INTAKE_ACTION.actionName,
    inputPayload: { intakeId, sourceId: source.id, confirmed: true },
    dataBefore: { externalMessageId: intake.externalMessageId, receivedAt: intake.receivedAt },
    dataAfter: result,
    riskLevel: DELETE_GMAIL_INTAKE_ACTION.riskLevel,
    confirmationRequired: true,
    confirmed: true,
    result: "success",
  });
  return ok(200, result);
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
