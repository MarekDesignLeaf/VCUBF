import { createHash, randomBytes, randomUUID } from "node:crypto";
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
  buildGooglePhotosAuthorizationUrl,
  createGooglePhotosPickerSession,
  deleteGooglePhotosPickerSession,
  exchangeGooglePhotosAuthorizationCode,
  getGooglePhotosPickerSession,
  GooglePhotosAdapterError,
  listGooglePhotosPickerMediaItems,
  refreshGooglePhotosCredential,
  revokeGooglePhotosCredential,
  type GooglePhotosPickedMediaItem,
  type StoredGooglePhotosCredential,
} from "../connectors/googlePhotosAdapter.js";
import {
  COMPLETE_GOOGLE_PHOTOS_OAUTH_ACTION,
  CREATE_GOOGLE_PHOTOS_PICKER_SESSION_ACTION,
  DISCONNECT_GOOGLE_PHOTOS_SOURCE_ACTION,
  REGISTER_GOOGLE_PHOTOS_PHOTO_ACTION,
  STAGE_GOOGLE_PHOTOS_ITEMS_ACTION,
  START_GOOGLE_PHOTOS_OAUTH_ACTION,
  type ActionContract,
} from "../lib/actionContracts.js";
import { recordAudit } from "../lib/audit.js";
import { frontendUrl } from "../lib/frontendUrl.js";
import type { AuthedUser } from "../middleware/auth.js";
import { fail, ok, type ServiceResult } from "./result.js";

const STATE_MS = 600_000;
const REFRESH_MARGIN = 60_000;
const PHOTOS_KEY = "google_photos";
const PHOTOS_SCOPE = "select:user_selected_photos";
const MAX_PICKED_ITEMS = 20;
const callbackSchema = z.object({
  state: z.string().min(20).max(500),
  code: z.string().min(1).max(4096).optional(),
  error: z.string().min(1).max(200).optional(),
}).refine((value) => Boolean(value.code) !== Boolean(value.error));
const sessionIdSchema = z.string().trim().min(1).max(500);
const confirmSchema = z.object({
  confirmed: z.boolean().optional(),
  caption: z.string().trim().max(2000).optional(),
  tags: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
}).strict();
const disconnectSchema = z.object({ confirmed: z.boolean().optional() }).strict();
type Source = Prisma.ConnectorSourceGetPayload<{ include: { credential: true } }>;

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const context = (companyId: string, sourceId: string) => `${companyId}:${sourceId}:${PHOTOS_KEY}`;

function redirect(sourceId: string) {
  const url = frontendUrl("/connectors");
  url.searchParams.set(PHOTOS_KEY, "connected");
  url.searchParams.set("source", sourceId);
  return url.toString();
}

function durationToMilliseconds(value?: string) {
  const seconds = value ? Number(value.replace(/s$/i, "")) : Number.NaN;
  if (!Number.isFinite(seconds) || seconds <= 0) return 3_000;
  return Math.max(1_000, Math.min(30_000, Math.round(seconds * 1000)));
}

function asDate(value?: string) {
  return value && !Number.isNaN(Date.parse(value)) ? new Date(value) : undefined;
}

function providerError(error: unknown): ServiceResult<never> {
  if (error instanceof GooglePhotosAdapterError) {
    const status = error.code === "RATE_LIMITED" ? 429
      : ["PROVIDER_UNAVAILABLE", "CONNECTOR_CONFIGURATION_MISSING"].includes(error.code) ? 503
        : error.code === "PICKER_SESSION_NOT_FOUND" ? 404
          : error.code === "PROVIDER_RESPONSE_INVALID" ? 502
            : 409;
    return fail(status, error.code, error.message);
  }
  if (error instanceof ConnectorCryptoError) return fail(500, error.code);
  return fail(500, "CONNECTOR_INTERNAL_ERROR");
}

async function auditFailure(action: ActionContract, user: { companyId: string; id?: string; userId?: string }, sourceId: string, errorMessage: string) {
  await recordAudit({
    companyId: user.companyId,
    userId: user.id ?? user.userId,
    actionName: action.actionName,
    inputPayload: { sourceId },
    riskLevel: action.riskLevel,
    confirmationRequired: action.confirmationRequired,
    result: "error",
    errorMessage,
  });
}

async function sourceFor(user: AuthedUser, sourceId: string) {
  return prisma.connectorSource.findFirst({
    where: { id: sourceId, companyId: user.companyId, connectorKey: PHOTOS_KEY, isActive: true },
    include: { credential: true },
  });
}

async function usable(source: Source) {
  const encryptionContext = context(source.companyId, source.id);
  let value = decryptConnectorPayload<StoredGooglePhotosCredential>(source.credential!, encryptionContext);
  if (!Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= Date.now() + REFRESH_MARGIN) {
    value = await refreshGooglePhotosCredential(value);
    await prisma.connectorCredential.update({ where: { sourceId: source.id }, data: encryptConnectorPayload(value, encryptionContext) });
  }
  return value;
}

export async function startGooglePhotosOAuth(user: AuthedUser, sourceId: string): Promise<ServiceResult<unknown>> {
  const source = await prisma.connectorSource.findFirst({
    where: { id: sourceId, companyId: user.companyId, connectorKey: PHOTOS_KEY, isActive: true },
  });
  if (!source) return fail(404, "CONNECTOR_SOURCE_NOT_FOUND");
  if (!source.configuredScopes.includes(PHOTOS_SCOPE)) return fail(409, "CONNECTOR_SCOPE_REQUIRED");
  try {
    assertConnectorEncryptionConfigured();
    const state = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + STATE_MS);
    const authorizationUrl = buildGooglePhotosAuthorizationUrl(state);
    await prisma.$transaction([
      prisma.connectorOAuthState.deleteMany({ where: { sourceId } }),
      prisma.connectorOAuthState.create({ data: { sourceId, companyId: user.companyId, userId: user.id, stateHash: hash(state), expiresAt } }),
      prisma.connectorSource.update({ where: { id: sourceId }, data: { isEnabled: false, connectionStatus: "authorizing", lastErrorCode: null } }),
    ]);
    await recordAudit({ companyId: user.companyId, userId: user.id, actionName: START_GOOGLE_PHOTOS_OAUTH_ACTION.actionName, inputPayload: { sourceId }, dataAfter: { expiresAt }, riskLevel: 1, result: "success" });
    return ok(200, { authorizationUrl, expiresAt });
  } catch (error) {
    const result = providerError(error);
    await auditFailure(START_GOOGLE_PHOTOS_OAUTH_ACTION, user, sourceId, result.ok ? "CONNECTOR_INTERNAL_ERROR" : result.error);
    return result;
  }
}

export async function completeGooglePhotosOAuth(raw: unknown): Promise<ServiceResult<{ redirectUrl: string }>> {
  const parsed = callbackSchema.safeParse(raw);
  if (!parsed.success) return fail(400, "OAUTH_CALLBACK_INVALID");
  const state = await prisma.connectorOAuthState.findUnique({
    where: { stateHash: hash(parsed.data.state) },
    include: { source: { include: { credential: true } } },
  });
  if (!state || state.consumedAt) return fail(400, "OAUTH_STATE_INVALID");
  if (state.source.connectorKey !== PHOTOS_KEY || state.expiresAt <= new Date()) return fail(400, "OAUTH_STATE_EXPIRED");
  const user = await prisma.user.findFirst({ where: { id: state.userId, companyId: state.companyId, isActive: true }, select: { permissions: true } });
  if (!user?.permissions.includes("connectors.manage")) return fail(403, "MISSING_PERMISSION");
  const consumed = await prisma.connectorOAuthState.updateMany({ where: { id: state.id, consumedAt: null }, data: { consumedAt: new Date() } });
  if (consumed.count !== 1) return fail(400, "OAUTH_STATE_INVALID");
  if (parsed.data.error) return fail(409, "OAUTH_PROVIDER_REJECTED");
  try {
    const oldRefresh = state.source.credential
      ? decryptConnectorPayload<StoredGooglePhotosCredential>(state.source.credential, context(state.companyId, state.sourceId)).refreshToken
      : undefined;
    const value = await exchangeGooglePhotosAuthorizationCode(parsed.data.code!, oldRefresh);
    const encrypted = encryptConnectorPayload(value, context(state.companyId, state.sourceId));
    await prisma.$transaction([
      prisma.connectorCredential.upsert({
        where: { sourceId: state.sourceId },
        create: { sourceId: state.sourceId, companyId: state.companyId, provider: PHOTOS_KEY, ...encrypted },
        update: { provider: PHOTOS_KEY, ...encrypted },
      }),
      prisma.connectorSource.update({ where: { id: state.sourceId }, data: { connectionStatus: "configured", isEnabled: false, lastErrorCode: null } }),
    ]);
    await recordAudit({ companyId: state.companyId, userId: state.userId, actionName: COMPLETE_GOOGLE_PHOTOS_OAUTH_ACTION.actionName, inputPayload: { sourceId: state.sourceId }, dataAfter: { provider: PHOTOS_KEY, scopeVerified: true, encrypted: true }, riskLevel: 2, result: "success" });
    return ok(200, { redirectUrl: redirect(state.sourceId) });
  } catch (error) {
    return providerError(error);
  }
}

export async function createGooglePhotosSelectionSession(user: AuthedUser, sourceId: string): Promise<ServiceResult<unknown>> {
  const source = await sourceFor(user, sourceId);
  if (!source) return fail(404, "CONNECTOR_SOURCE_NOT_FOUND");
  if (!source.isEnabled) return fail(409, "CONNECTOR_NOT_ENABLED");
  if (!source.credential) return fail(409, "CONNECTOR_AUTHORIZATION_REQUIRED");
  try {
    const credential = await usable(source);
    const session = await createGooglePhotosPickerSession(credential.accessToken, randomUUID(), MAX_PICKED_ITEMS);
    const result = {
      sessionId: session.id!,
      pickerUri: session.pickerUri!,
      expiresAt: session.expireTime ? new Date(session.expireTime) : null,
      pollIntervalMs: durationToMilliseconds(session.pollingConfig?.pollInterval),
    };
    await recordAudit({ companyId: user.companyId, userId: user.id, actionName: CREATE_GOOGLE_PHOTOS_PICKER_SESSION_ACTION.actionName, inputPayload: { sourceId }, dataAfter: { sessionId: result.sessionId, expiresAt: result.expiresAt }, riskLevel: 1, result: "success" });
    return ok(201, result);
  } catch (error) {
    const result = providerError(error);
    await auditFailure(CREATE_GOOGLE_PHOTOS_PICKER_SESSION_ACTION, user, sourceId, result.ok ? "CONNECTOR_INTERNAL_ERROR" : result.error);
    return result;
  }
}

export async function getGooglePhotosSelectionSession(user: AuthedUser, sourceId: string, rawSessionId: unknown): Promise<ServiceResult<unknown>> {
  const sessionId = sessionIdSchema.safeParse(rawSessionId);
  if (!sessionId.success) return fail(400, "VALIDATION_FAILED", sessionId.error.message);
  const source = await sourceFor(user, sourceId);
  if (!source) return fail(404, "CONNECTOR_SOURCE_NOT_FOUND");
  if (!source.isEnabled || !source.credential) return fail(409, "CONNECTOR_NOT_ENABLED");
  try {
    const session = await getGooglePhotosPickerSession((await usable(source)).accessToken, sessionId.data);
    return ok(200, {
      sessionId: session.id,
      mediaItemsSet: Boolean(session.mediaItemsSet),
      expiresAt: session.expireTime ? new Date(session.expireTime) : null,
      pollIntervalMs: durationToMilliseconds(session.pollingConfig?.pollInterval),
    });
  } catch (error) {
    return providerError(error);
  }
}

function usableImage(item: GooglePhotosPickedMediaItem) {
  return item.type === "PHOTO" && item.mediaFile?.mimeType?.startsWith("image/") && item.id;
}

export async function stageGooglePhotosSelection(user: AuthedUser, sourceId: string, rawSessionId: unknown): Promise<ServiceResult<unknown>> {
  const sessionId = sessionIdSchema.safeParse(rawSessionId);
  if (!sessionId.success) return fail(400, "VALIDATION_FAILED", sessionId.error.message);
  const source = await sourceFor(user, sourceId);
  if (!source) return fail(404, "CONNECTOR_SOURCE_NOT_FOUND");
  if (!source.isEnabled || !source.credential) return fail(409, "CONNECTOR_NOT_ENABLED");
  try {
    const credential = await usable(source);
    const session = await getGooglePhotosPickerSession(credential.accessToken, sessionId.data);
    if (!session.mediaItemsSet) return fail(409, "PICKER_SELECTION_PENDING", "Complete photo selection in Google Photos before importing it.");
    const selected = await listGooglePhotosPickerMediaItems(credential.accessToken, sessionId.data);
    if (selected.length > MAX_PICKED_ITEMS) return fail(502, "PROVIDER_RESPONSE_INVALID");
    const images = selected.filter(usableImage);
    if (!images.length) return fail(409, "NOT_AN_IMAGE", "No selected Google Photos items were photos.");
    const items = [];
    for (const item of images) {
      const mediaFile = item.mediaFile!;
      items.push(await prisma.externalGooglePhoto.upsert({
        where: { companyId_connectorSourceId_externalMediaItemId: { companyId: user.companyId, connectorSourceId: sourceId, externalMediaItemId: item.id! } },
        create: {
          companyId: user.companyId,
          connectorSourceId: sourceId,
          pickerSessionId: sessionId.data,
          externalMediaItemId: item.id!,
          name: mediaFile.filename || item.id!,
          mimeType: mediaFile.mimeType!,
          mediaType: item.type ?? "PHOTO",
          width: mediaFile.mediaFileMetadata?.width,
          height: mediaFile.mediaFileMetadata?.height,
          createdTime: asDate(item.createTime),
        },
        update: {
          pickerSessionId: sessionId.data,
          name: mediaFile.filename || item.id!,
          mimeType: mediaFile.mimeType!,
          mediaType: item.type ?? "PHOTO",
          width: mediaFile.mediaFileMetadata?.width,
          height: mediaFile.mediaFileMetadata?.height,
          createdTime: asDate(item.createTime),
          isRemoved: false,
          stagedAt: new Date(),
        },
      }));
    }
    let sessionCleaned = true;
    try { await deleteGooglePhotosPickerSession(credential.accessToken, sessionId.data); }
    catch { sessionCleaned = false; }
    const result = { sourceId, sessionId: sessionId.data, items, skippedNonImageCount: selected.length - images.length, sessionCleaned };
    await recordAudit({ companyId: user.companyId, userId: user.id, actionName: STAGE_GOOGLE_PHOTOS_ITEMS_ACTION.actionName, inputPayload: { sourceId, sessionId: sessionId.data }, dataAfter: { stagedIds: items.map((item) => item.id), skippedNonImageCount: result.skippedNonImageCount, sessionCleaned }, riskLevel: 1, result: "success" });
    return ok(200, result);
  } catch (error) {
    return providerError(error);
  }
}

export async function listGooglePhotosItems(user: AuthedUser, sourceId: string): Promise<ServiceResult<unknown>> {
  const source = await sourceFor(user, sourceId);
  if (!source) return fail(404, "CONNECTOR_SOURCE_NOT_FOUND");
  return ok(200, await prisma.externalGooglePhoto.findMany({
    where: { companyId: user.companyId, connectorSourceId: sourceId, isRemoved: false },
    orderBy: { stagedAt: "desc" },
  }));
}

export async function registerGooglePhotosPortfolioPhoto(user: AuthedUser, sourceId: string, photoId: string, raw: unknown): Promise<ServiceResult<unknown>> {
  const parsed = confirmSchema.safeParse(raw);
  if (!parsed.success) return fail(400, "VALIDATION_FAILED", parsed.error.message);
  const item = await prisma.externalGooglePhoto.findFirst({ where: { id: photoId, companyId: user.companyId, connectorSourceId: sourceId, isRemoved: false } });
  if (!item) return fail(404, "GOOGLE_PHOTOS_ITEM_NOT_FOUND");
  if (item.portfolioPhotoId) return fail(409, "PHOTO_ALREADY_REGISTERED", undefined, { portfolioPhotoId: item.portfolioPhotoId });
  const preview = { photoId, name: item.name, mimeType: item.mimeType, willStoreBytes: false, usableForMarketing: false };
  if (!parsed.data.confirmed) return fail(409, "CONFIRMATION_REQUIRED", undefined, { preview });
  const result = await prisma.$transaction(async (tx) => {
    const current = await tx.externalGooglePhoto.findFirst({ where: { id: item.id, portfolioPhotoId: null } });
    if (!current) throw new Error("PHOTO_ALREADY_REGISTERED");
    const photo = await tx.portfolioPhoto.create({
      data: { companyId: user.companyId, filename: current.name, caption: parsed.data.caption, tags: parsed.data.tags ?? [], source: "google_photos", usableForMarketing: false, createdBy: user.id },
    });
    await tx.externalGooglePhoto.update({ where: { id: current.id }, data: { portfolioPhotoId: photo.id } });
    return photo;
  });
  await recordAudit({ companyId: user.companyId, userId: user.id, actionName: REGISTER_GOOGLE_PHOTOS_PHOTO_ACTION.actionName, inputPayload: { sourceId, photoId, confirmed: true }, dataAfter: { portfolioPhotoId: result.id }, riskLevel: 3, confirmationRequired: true, confirmed: true, result: "success" });
  return ok(201, result);
}

export async function disconnectGooglePhotosSource(user: AuthedUser, sourceId: string, raw: unknown): Promise<ServiceResult<unknown>> {
  const parsed = disconnectSchema.safeParse(raw);
  if (!parsed.success) return fail(400, "VALIDATION_FAILED");
  const source = await sourceFor(user, sourceId);
  if (!source) return fail(404, "CONNECTOR_SOURCE_NOT_FOUND");
  const preview = { sourceId, willKeepStagedAndPortfolioMetadata: true, willRevokeGoogleProjectGrant: Boolean(source.credential) };
  if (!parsed.data.confirmed) return fail(409, "CONFIRMATION_REQUIRED", undefined, { preview });
  await prisma.connectorSource.update({ where: { id: sourceId }, data: { isEnabled: false, connectionStatus: "disconnecting" } });
  try {
    if (source.credential) await revokeGooglePhotosCredential(decryptConnectorPayload<StoredGooglePhotosCredential>(source.credential, context(source.companyId, source.id)).refreshToken);
    const disconnectedAt = new Date();
    await prisma.$transaction([
      prisma.connectorCredential.deleteMany({ where: { sourceId } }),
      prisma.connectorOAuthState.deleteMany({ where: { sourceId } }),
      prisma.connectorSource.update({ where: { id: sourceId }, data: { isEnabled: false, connectionStatus: "disconnected", lastErrorCode: null } }),
    ]);
    const result = { sourceId, provider: PHOTOS_KEY, providerGrantRevoked: Boolean(source.credential), disconnectedAt };
    await recordAudit({ companyId: user.companyId, userId: user.id, actionName: DISCONNECT_GOOGLE_PHOTOS_SOURCE_ACTION.actionName, inputPayload: { sourceId, confirmed: true }, dataAfter: result, riskLevel: 3, confirmationRequired: true, confirmed: true, result: "success" });
    return ok(200, result);
  } catch (error) {
    const result = providerError(error);
    await prisma.connectorSource.update({ where: { id: sourceId }, data: { isEnabled: false, connectionStatus: "disconnect_failed", lastErrorCode: result.ok ? "CONNECTOR_INTERNAL_ERROR" : result.error } });
    return result;
  }
}
