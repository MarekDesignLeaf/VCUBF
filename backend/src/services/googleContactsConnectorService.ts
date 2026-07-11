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
  buildGoogleContactsAuthorizationUrl,
  exchangeGoogleContactsAuthorizationCode,
  GoogleContactsAdapterError,
  listGoogleConnections,
  parseGooglePerson,
  refreshGoogleContactsCredential,
  revokeGoogleContactsCredential,
  type StoredGoogleContactsCredential,
} from "../connectors/googleContactsAdapter.js";
import {
  COMPLETE_GOOGLE_CONTACTS_OAUTH_ACTION,
  DISCONNECT_GOOGLE_CONTACTS_SOURCE_ACTION,
  IMPORT_GOOGLE_CONTACT_ACTION,
  START_GOOGLE_CONTACTS_OAUTH_ACTION,
  SYNC_GOOGLE_CONTACTS_ACTION,
  type ActionContract,
} from "../lib/actionContracts.js";
import { recordAudit } from "../lib/audit.js";
import { normalizeEmail, normalizePhone } from "../lib/contactNormalization.js";
import type { AuthedUser } from "../middleware/auth.js";
import { fail, ok, type ServiceResult } from "./result.js";

const OAUTH_STATE_LIFETIME_MS = 10 * 60 * 1000;
const TOKEN_REFRESH_MARGIN_MS = 60 * 1000;

const callbackSchema = z.object({
  state: z.string().min(20).max(500),
  code: z.string().min(1).max(4096).optional(),
  error: z.string().min(1).max(200).optional(),
}).refine((value) => Boolean(value.code) !== Boolean(value.error), "Exactly one of code or error is required");

const disconnectSchema = z.object({ confirmed: z.boolean().optional() }).strict();
const importSchema = z.object({ confirmed: z.boolean().optional() }).strict();
export const externalContactQuerySchema = z.object({
  active_only: z.enum(["true", "false"]).optional(),
  importable_only: z.enum(["true", "false"]).optional(),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();

function stateHash(state: string) { return createHash("sha256").update(state).digest("hex"); }
function credentialContext(companyId: string, sourceId: string) { return `${companyId}:${sourceId}:google_contacts`; }

function safeRedirect(sourceId: string) {
  let base: URL;
  try {
    base = new URL(process.env.FRONTEND_URL?.trim() || "http://localhost:5173");
    if (!["http:", "https:"].includes(base.protocol)) throw new Error("Invalid protocol");
  } catch { base = new URL("http://localhost:5173"); }
  const url = new URL("/connectors", base);
  url.searchParams.set("google_contacts", "connected");
  url.searchParams.set("source", sourceId);
  return url.toString();
}

async function auditFailure(action: ActionContract, identity: { companyId: string; userId?: string; id?: string }, sourceId: string, errorMessage: string) {
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
  if (error instanceof GoogleContactsAdapterError) {
    const status = error.code === "RATE_LIMITED" ? 429
      : ["PROVIDER_UNAVAILABLE", "CONNECTOR_CONFIGURATION_MISSING"].includes(error.code) ? 503
        : error.code === "PROVIDER_RESPONSE_INVALID" ? 502 : 409;
    return fail(status, error.code, error.message);
  }
  if (error instanceof ConnectorCryptoError) return fail(500, error.code);
  return fail(500, "CONNECTOR_INTERNAL_ERROR");
}

export async function startGoogleContactsOAuth(user: AuthedUser, sourceId: string): Promise<ServiceResult<unknown>> {
  const source = await prisma.connectorSource.findFirst({ where: { id: sourceId, companyId: user.companyId, isActive: true } });
  if (!source || source.connectorKey !== "google_contacts") {
    await auditFailure(START_GOOGLE_CONTACTS_OAUTH_ACTION, user, sourceId, "CONNECTOR_SOURCE_NOT_FOUND");
    return fail(404, "CONNECTOR_SOURCE_NOT_FOUND");
  }
  if (!source.configuredScopes.includes("read:contacts")) {
    await auditFailure(START_GOOGLE_CONTACTS_OAUTH_ACTION, user, sourceId, "CONNECTOR_SCOPE_REQUIRED");
    return fail(409, "CONNECTOR_SCOPE_REQUIRED");
  }
  try {
    assertConnectorEncryptionConfigured();
    const state = randomBytes(32).toString("base64url");
    const authorizationUrl = buildGoogleContactsAuthorizationUrl(state);
    const expiresAt = new Date(Date.now() + OAUTH_STATE_LIFETIME_MS);
    await prisma.$transaction([
      prisma.connectorOAuthState.deleteMany({ where: { sourceId } }),
      prisma.connectorOAuthState.create({ data: { sourceId, companyId: user.companyId, userId: user.id, stateHash: stateHash(state), expiresAt } }),
      prisma.connectorSource.update({ where: { id: sourceId }, data: { isEnabled: false, connectionStatus: "authorizing", lastErrorCode: null } }),
    ]);
    await recordAudit({
      companyId: user.companyId, userId: user.id, actionName: START_GOOGLE_CONTACTS_OAUTH_ACTION.actionName,
      inputPayload: { sourceId }, dataAfter: { sourceId, expiresAt }, riskLevel: 1, result: "success",
    });
    return ok(200, { authorizationUrl, expiresAt });
  } catch (error) {
    const result = providerErrorResult(error);
    await auditFailure(START_GOOGLE_CONTACTS_OAUTH_ACTION, user, sourceId, result.ok ? "CONNECTOR_INTERNAL_ERROR" : result.error);
    return result;
  }
}

export async function completeGoogleContactsOAuth(rawInput: unknown): Promise<ServiceResult<{ redirectUrl: string }>> {
  const parsed = callbackSchema.safeParse(rawInput);
  if (!parsed.success) return fail(400, "OAUTH_CALLBACK_INVALID");
  const oauthState = await prisma.connectorOAuthState.findUnique({
    where: { stateHash: stateHash(parsed.data.state) },
    include: { source: { include: { credential: true } } },
  });
  if (!oauthState || oauthState.consumedAt) return fail(400, "OAUTH_STATE_INVALID");
  if (!oauthState.source.isActive || oauthState.source.connectorKey !== "google_contacts") {
    await prisma.connectorOAuthState.update({ where: { id: oauthState.id }, data: { consumedAt: new Date() } });
    return fail(404, "CONNECTOR_SOURCE_NOT_FOUND");
  }
  const initiatingUser = await prisma.user.findFirst({
    where: { id: oauthState.userId, companyId: oauthState.companyId, isActive: true },
    select: { id: true, permissions: true },
  });
  if (!initiatingUser?.permissions.includes(COMPLETE_GOOGLE_CONTACTS_OAUTH_ACTION.requiredPermission)) {
    await prisma.connectorOAuthState.update({ where: { id: oauthState.id }, data: { consumedAt: new Date() } });
    await auditFailure(COMPLETE_GOOGLE_CONTACTS_OAUTH_ACTION, oauthState, oauthState.sourceId, "MISSING_PERMISSION");
    return fail(403, "MISSING_PERMISSION");
  }
  if (oauthState.expiresAt <= new Date()) {
    await prisma.connectorOAuthState.update({ where: { id: oauthState.id }, data: { consumedAt: new Date() } });
    await auditFailure(COMPLETE_GOOGLE_CONTACTS_OAUTH_ACTION, oauthState, oauthState.sourceId, "OAUTH_STATE_EXPIRED");
    return fail(400, "OAUTH_STATE_EXPIRED");
  }
  const consumed = await prisma.connectorOAuthState.updateMany({
    where: { id: oauthState.id, consumedAt: null, expiresAt: { gt: new Date() } }, data: { consumedAt: new Date() },
  });
  if (consumed.count !== 1) return fail(400, "OAUTH_STATE_INVALID");
  if (parsed.data.error) {
    await auditFailure(COMPLETE_GOOGLE_CONTACTS_OAUTH_ACTION, oauthState, oauthState.sourceId, "OAUTH_PROVIDER_REJECTED");
    return fail(409, "OAUTH_PROVIDER_REJECTED");
  }
  try {
    let existingRefreshToken: string | undefined;
    if (oauthState.source.credential) {
      existingRefreshToken = decryptConnectorPayload<StoredGoogleContactsCredential>(
        oauthState.source.credential, credentialContext(oauthState.companyId, oauthState.sourceId)
      ).refreshToken;
    }
    const credential = await exchangeGoogleContactsAuthorizationCode(parsed.data.code!, existingRefreshToken);
    const encrypted = encryptConnectorPayload(credential, credentialContext(oauthState.companyId, oauthState.sourceId));
    await prisma.$transaction([
      prisma.connectorCredential.upsert({
        where: { sourceId: oauthState.sourceId },
        create: { sourceId: oauthState.sourceId, companyId: oauthState.companyId, provider: "google_contacts", ...encrypted },
        update: { provider: "google_contacts", ...encrypted },
      }),
      prisma.connectorSource.update({ where: { id: oauthState.sourceId }, data: {
        connectionStatus: "configured", isEnabled: false, lastErrorCode: null,
        syncCursor: null, syncPageToken: null, lastFullSyncAt: null,
      } }),
    ]);
    await recordAudit({
      companyId: oauthState.companyId, userId: oauthState.userId,
      actionName: COMPLETE_GOOGLE_CONTACTS_OAUTH_ACTION.actionName,
      inputPayload: { sourceId: oauthState.sourceId },
      dataAfter: { sourceId: oauthState.sourceId, provider: "google_contacts", scopeVerified: true, encrypted: true },
      riskLevel: 2, result: "success",
    });
    return ok(200, { redirectUrl: safeRedirect(oauthState.sourceId) });
  } catch (error) {
    const result = providerErrorResult(error);
    await auditFailure(COMPLETE_GOOGLE_CONTACTS_OAUTH_ACTION, oauthState, oauthState.sourceId, result.ok ? "CONNECTOR_INTERNAL_ERROR" : result.error);
    return result;
  }
}

type ContactsSource = Prisma.ConnectorSourceGetPayload<{ include: { credential: true } }>;

async function usableCredential(source: ContactsSource) {
  const context = credentialContext(source.companyId, source.id);
  let credential = decryptConnectorPayload<StoredGoogleContactsCredential>(source.credential!, context);
  const expiresAt = Date.parse(credential.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() + TOKEN_REFRESH_MARGIN_MS) {
    credential = await refreshGoogleContactsCredential(credential);
    await prisma.connectorCredential.update({ where: { sourceId: source.id }, data: encryptConnectorPayload(credential, context) });
  }
  return credential;
}

async function applyConnections(source: ContactsSource, connections: Awaited<ReturnType<typeof listGoogleConnections>>["connections"] = []) {
  let upsertedCount = 0;
  let deletedCount = 0;
  for (const person of connections) {
    const parsed = parseGooglePerson(person);
    if (parsed.isDeleted) {
      await prisma.externalContact.updateMany({
        where: { companyId: source.companyId, connectorSourceId: source.id, externalResourceName: parsed.externalResourceName },
        data: { isDeleted: true, sourceEtag: parsed.sourceEtag, syncedAt: new Date() },
      });
      deletedCount += 1;
      continue;
    }
    await prisma.externalContact.upsert({
      where: { companyId_connectorSourceId_externalResourceName: {
        companyId: source.companyId, connectorSourceId: source.id, externalResourceName: parsed.externalResourceName,
      } },
      create: { companyId: source.companyId, connectorSourceId: source.id, ...parsed, syncedAt: new Date() },
      update: { ...parsed, syncedAt: new Date() },
    });
    upsertedCount += 1;
  }
  return { upsertedCount, deletedCount };
}

async function performSync(source: ContactsSource, accessToken: string, fallbackFromExpiredSyncToken = false) {
  const mode = source.syncCursor ? "incremental" as const : "full" as const;
  const response = await listGoogleConnections(accessToken, {
    syncToken: source.syncCursor ?? undefined,
    pageToken: source.syncPageToken ?? undefined,
  });
  const counts = await applyConnections(source, response.connections);
  const syncedAt = new Date();
  const hasMore = Boolean(response.nextPageToken);
  const cursorAdvanced = !hasMore && Boolean(response.nextSyncToken);
  await prisma.connectorSource.update({ where: { id: source.id }, data: {
    lastSyncAt: syncedAt, lastSyncStatus: "success", lastErrorCode: null,
    syncPageToken: response.nextPageToken ?? null,
    ...(cursorAdvanced ? { syncCursor: response.nextSyncToken, ...(mode === "full" ? { lastFullSyncAt: syncedAt } : {}) } : {}),
  } });
  return {
    sourceId: source.id, mode, fallbackFromExpiredSyncToken, ...counts,
    totalItems: response.totalItems ?? null, hasMore, cursorAdvanced, syncedAt,
  };
}

export async function syncGoogleContacts(user: AuthedUser, sourceId: string): Promise<ServiceResult<unknown>> {
  let source = await prisma.connectorSource.findFirst({
    where: { id: sourceId, companyId: user.companyId, connectorKey: "google_contacts", isActive: true },
    include: { credential: true },
  });
  if (!source) return fail(404, "CONNECTOR_SOURCE_NOT_FOUND");
  if (!source.isEnabled) return fail(409, "CONNECTOR_NOT_ENABLED");
  if (!source.credential) return fail(409, "CONNECTOR_AUTHORIZATION_REQUIRED");
  try {
    const credential = await usableCredential(source);
    let result;
    try {
      result = await performSync(source, credential.accessToken);
    } catch (error) {
      if (!(error instanceof GoogleContactsAdapterError) || error.code !== "SYNC_TOKEN_EXPIRED") throw error;
      source = await prisma.connectorSource.update({
        where: { id: source.id }, data: { syncCursor: null, syncPageToken: null }, include: { credential: true },
      });
      result = await performSync(source, credential.accessToken, true);
    }
    await recordAudit({
      companyId: user.companyId, userId: user.id, actionName: SYNC_GOOGLE_CONTACTS_ACTION.actionName,
      inputPayload: { sourceId }, dataAfter: result, riskLevel: 2, result: "success",
    });
    return ok(200, result);
  } catch (error) {
    const result = providerErrorResult(error);
    const errorCode = result.ok ? "CONNECTOR_INTERNAL_ERROR" : result.error;
    await prisma.connectorSource.update({ where: { id: source.id }, data: { lastSyncAt: new Date(), lastSyncStatus: "error", lastErrorCode: errorCode } });
    await auditFailure(SYNC_GOOGLE_CONTACTS_ACTION, user, sourceId, errorCode);
    return result;
  }
}

export async function listExternalContacts(user: AuthedUser, sourceId: string, rawQuery: unknown): Promise<ServiceResult<unknown>> {
  const parsed = externalContactQuerySchema.safeParse(rawQuery);
  if (!parsed.success) return fail(400, "VALIDATION_FAILED", parsed.error.message);
  const source = await prisma.connectorSource.findFirst({ where: { id: sourceId, companyId: user.companyId, connectorKey: "google_contacts" } });
  if (!source) return fail(404, "CONNECTOR_SOURCE_NOT_FOUND");
  const where: Prisma.ExternalContactWhereInput = {
    companyId: user.companyId, connectorSourceId: source.id,
    ...(parsed.data.active_only === "true" ? { isDeleted: false } : {}),
    ...(parsed.data.importable_only === "true" ? { isDeleted: false, OR: [{ email: { not: null } }, { phone: { not: null } }] } : {}),
  };
  const [items, total] = await prisma.$transaction([
    prisma.externalContact.findMany({ where, orderBy: [{ displayName: "asc" }, { createdAt: "asc" }], skip: parsed.data.offset, take: parsed.data.limit }),
    prisma.externalContact.count({ where }),
  ]);
  return ok(200, { items: items.map((item) => ({ ...item, importable: !item.isDeleted && Boolean(item.email || item.phone) })), total, offset: parsed.data.offset, limit: parsed.data.limit });
}

export async function importGoogleContact(user: AuthedUser, sourceId: string, externalContactId: string, rawInput: unknown): Promise<ServiceResult<unknown>> {
  const parsed = importSchema.safeParse(rawInput);
  if (!parsed.success) return fail(400, "VALIDATION_FAILED", parsed.error.message);
  const external = await prisma.externalContact.findFirst({ where: {
    id: externalContactId, companyId: user.companyId, connectorSourceId: sourceId,
    connectorSource: { connectorKey: "google_contacts" },
  } });
  if (!external) return fail(404, "EXTERNAL_CONTACT_NOT_FOUND");
  if (external.importedContactId) return fail(409, "CONTACT_ALREADY_IMPORTED", undefined, { contactId: external.importedContactId });
  if (external.isDeleted || (!external.email && !external.phone)) return fail(409, "EXTERNAL_CONTACT_NOT_IMPORTABLE");
  const preview = {
    externalContactId: external.id, sourceId, displayName: external.displayName ?? external.email ?? external.phone,
    email: external.email, phone: external.phone, organisation: external.organisation, jobTitle: external.jobTitle,
  };
  if (!parsed.data.confirmed) {
    await recordAudit({
      companyId: user.companyId, userId: user.id, actionName: IMPORT_GOOGLE_CONTACT_ACTION.actionName,
      inputPayload: { sourceId, externalContactId, confirmed: false }, dataBefore: preview,
      riskLevel: 3, confirmationRequired: true, result: "rejected", errorMessage: "CONFIRMATION_REQUIRED",
    });
    return fail(409, "CONFIRMATION_REQUIRED", "Review the contact and resubmit with confirmed: true.", { preview });
  }
  try {
    const created = await prisma.$transaction(async (tx) => {
      const current = await tx.externalContact.findFirst({ where: { id: external.id, companyId: user.companyId, importedContactId: null, isDeleted: false } });
      if (!current) throw new Error("CONTACT_ALREADY_IMPORTED");
      const candidates = await tx.contact.findMany({
        where: { companyId: user.companyId, isActive: true, OR: [{ email: { not: null } }, { phone: { not: null } }] },
        select: { id: true, displayName: true, email: true, phone: true },
      });
      const email = normalizeEmail(current.email);
      const phone = normalizePhone(current.phone);
      const duplicate = candidates.find((item) =>
        (email && normalizeEmail(item.email) === email) || (phone && normalizePhone(item.phone) === phone)
      );
      if (duplicate) throw Object.assign(new Error("DUPLICATE_CONTACT_POSSIBLE"), { duplicate });
      const contact = await tx.contact.create({ data: {
        companyId: user.companyId,
        displayName: current.displayName ?? current.email ?? current.phone!,
        jobTitle: current.jobTitle,
        department: current.department,
        email: current.email,
        phone: current.phone,
        source: "google_contacts",
        sourceReference: `google-contacts:${sourceId}:${current.externalResourceName}`,
        notes: current.organisation ? `Organisation: ${current.organisation}` : undefined,
        createdBy: user.id,
      } });
      await tx.externalContact.update({ where: { id: current.id }, data: { importedContactId: contact.id } });
      return contact;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    await recordAudit({
      companyId: user.companyId, userId: user.id, actionName: IMPORT_GOOGLE_CONTACT_ACTION.actionName,
      inputPayload: { sourceId, externalContactId, confirmed: true }, dataBefore: { externalContactId },
      dataAfter: { contactId: created.id }, riskLevel: 3, confirmationRequired: true, confirmed: true, result: "success",
    });
    return ok(201, created);
  } catch (error) {
    const duplicate = (error as { duplicate?: unknown }).duplicate;
    if (duplicate) return fail(409, "DUPLICATE_CONTACT_POSSIBLE", "An active CRM contact already uses this email or phone.", { possibleDuplicate: duplicate });
    if (error instanceof Error && error.message === "CONTACT_ALREADY_IMPORTED") return fail(409, "CONTACT_ALREADY_IMPORTED");
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") return fail(409, "CONTACT_IMPORT_CONFLICT");
    return fail(500, "CONNECTOR_INTERNAL_ERROR");
  }
}

export async function disconnectGoogleContactsSource(user: AuthedUser, sourceId: string, rawInput: unknown): Promise<ServiceResult<unknown>> {
  const parsed = disconnectSchema.safeParse(rawInput);
  if (!parsed.success) return fail(400, "VALIDATION_FAILED", parsed.error.message);
  const source = await prisma.connectorSource.findFirst({
    where: { id: sourceId, companyId: user.companyId, connectorKey: "google_contacts", isActive: true }, include: { credential: true },
  });
  if (!source) return fail(404, "CONNECTOR_SOURCE_NOT_FOUND");
  const preview = {
    sourceId, provider: "google_contacts", willDisableSource: true,
    willDeleteEncryptedCredential: Boolean(source.credential), willRevokeGoogleProjectGrant: Boolean(source.credential),
    willKeepStagedAndImportedContacts: true,
    warning: "Google revocation can remove every OAuth scope granted to this Google Cloud project for the account.",
  };
  if (!parsed.data.confirmed) return fail(409, "CONFIRMATION_REQUIRED", "Review the revoke impact and resubmit with confirmed: true.", { preview });
  await prisma.connectorSource.update({ where: { id: source.id }, data: { isEnabled: false, connectionStatus: "disconnecting" } });
  try {
    if (source.credential) {
      const credential = decryptConnectorPayload<StoredGoogleContactsCredential>(source.credential, credentialContext(source.companyId, source.id));
      await revokeGoogleContactsCredential(credential.refreshToken);
    }
    const disconnectedAt = new Date();
    await prisma.$transaction([
      prisma.connectorCredential.deleteMany({ where: { sourceId: source.id } }),
      prisma.connectorOAuthState.deleteMany({ where: { sourceId: source.id } }),
      prisma.connectorSource.update({ where: { id: source.id }, data: {
        isEnabled: false, connectionStatus: "disconnected", lastErrorCode: null,
        syncCursor: null, syncPageToken: null, lastFullSyncAt: null,
      } }),
    ]);
    const result = { sourceId, provider: "google_contacts", disconnectedAt, providerGrantRevoked: Boolean(source.credential) };
    await recordAudit({
      companyId: user.companyId, userId: user.id, actionName: DISCONNECT_GOOGLE_CONTACTS_SOURCE_ACTION.actionName,
      inputPayload: { sourceId, confirmed: true }, dataBefore: preview, dataAfter: result,
      riskLevel: 3, confirmationRequired: true, confirmed: true, result: "success",
    });
    return ok(200, result);
  } catch (error) {
    const result = providerErrorResult(error);
    const errorCode = result.ok ? "CONNECTOR_INTERNAL_ERROR" : result.error;
    await prisma.connectorSource.update({ where: { id: source.id }, data: { isEnabled: false, connectionStatus: "disconnect_failed", lastErrorCode: errorCode } });
    return result;
  }
}
