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
  buildGoogleDriveAuthorizationUrl,
  exchangeGoogleDriveAuthorizationCode,
  getGoogleDriveImage,
  GoogleDriveAdapterError,
  refreshGoogleDriveCredential,
  revokeGoogleDriveCredential,
  type StoredGoogleDriveCredential,
} from "../connectors/googleDriveAdapter.js";
import {
  COMPLETE_GOOGLE_DRIVE_OAUTH_ACTION,
  DISCONNECT_GOOGLE_DRIVE_SOURCE_ACTION,
  REGISTER_GOOGLE_DRIVE_PHOTO_ACTION,
  STAGE_GOOGLE_DRIVE_IMAGES_ACTION,
  START_GOOGLE_DRIVE_OAUTH_ACTION,
  type ActionContract,
} from "../lib/actionContracts.js";
import { recordAudit } from "../lib/audit.js";
import { frontendUrl } from "../lib/frontendUrl.js";
import type { AuthedUser } from "../middleware/auth.js";
import { fail, ok, type ServiceResult } from "./result.js";

const STATE_MS = 600_000;
const REFRESH_MARGIN = 60_000;
const DRIVE_KEY = "google_drive";
const callbackSchema = z.object({
  state: z.string().min(20).max(500),
  code: z.string().min(1).max(4096).optional(),
  error: z.string().min(1).max(200).optional(),
}).refine((value) => Boolean(value.code) !== Boolean(value.error));
const stageSchema = z.object({ file_ids: z.array(z.string().trim().min(1).max(1000)).min(1).max(20) }).strict();
const confirmSchema = z.object({
  confirmed: z.boolean().optional(),
  caption: z.string().trim().max(2000).optional(),
  tags: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
}).strict();
const disconnectSchema = z.object({ confirmed: z.boolean().optional() }).strict();
type Source = Prisma.ConnectorSourceGetPayload<{ include: { credential: true } }>;

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const context = (companyId: string, sourceId: string) => `${companyId}:${sourceId}:${DRIVE_KEY}`;
const legacyContext = (companyId: string, sourceId: string) => `${companyId}:${sourceId}:google_drive_photos`;

function redirect(sourceId: string) {
  const url = frontendUrl("/connectors");
  url.searchParams.set(DRIVE_KEY, "connected");
  url.searchParams.set("source", sourceId);
  return url.toString();
}

function decryptDriveCredential(
  credential: NonNullable<Source["credential"]>,
  companyId: string,
  sourceId: string,
) {
  try {
    return decryptConnectorPayload<StoredGoogleDriveCredential>(credential, context(companyId, sourceId));
  } catch (error) {
    // Sources created before the split were authenticated with this associated
    // data. The migration only renames their key/provider, so accept that
    // legacy payload once and re-encrypt it with the new context on refresh.
    if (!(error instanceof ConnectorCryptoError) || error.code !== "CONNECTOR_CREDENTIAL_INVALID") throw error;
    return decryptConnectorPayload<StoredGoogleDriveCredential>(credential, legacyContext(companyId, sourceId));
  }
}

async function auditFailure(
  action: ActionContract,
  user: { companyId: string; id?: string; userId?: string },
  sourceId: string,
  errorMessage: string,
) {
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

function providerError(error: unknown): ServiceResult<never> {
  if (error instanceof GoogleDriveAdapterError) {
    const status = error.code === "RATE_LIMITED" ? 429
      : ["PROVIDER_UNAVAILABLE", "CONNECTOR_CONFIGURATION_MISSING"].includes(error.code) ? 503
        : error.code === "PROVIDER_RESPONSE_INVALID" ? 502
          : error.code === "FILE_NOT_FOUND" ? 404
            : 409;
    return fail(status, error.code, error.message);
  }
  if (error instanceof ConnectorCryptoError) return fail(500, error.code);
  return fail(500, "CONNECTOR_INTERNAL_ERROR");
}

export async function startGoogleDriveOAuth(user: AuthedUser, sourceId: string): Promise<ServiceResult<unknown>> {
  const source = await prisma.connectorSource.findFirst({
    where: { id: sourceId, companyId: user.companyId, connectorKey: DRIVE_KEY, isActive: true },
  });
  if (!source) return fail(404, "CONNECTOR_SOURCE_NOT_FOUND");
  if (!source.configuredScopes.includes("select:image_files")) return fail(409, "CONNECTOR_SCOPE_REQUIRED");
  try {
    assertConnectorEncryptionConfigured();
    const state = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + STATE_MS);
    const authorizationUrl = buildGoogleDriveAuthorizationUrl(state);
    await prisma.$transaction([
      prisma.connectorOAuthState.deleteMany({ where: { sourceId } }),
      prisma.connectorOAuthState.create({ data: { sourceId, companyId: user.companyId, userId: user.id, stateHash: hash(state), expiresAt } }),
      prisma.connectorSource.update({ where: { id: sourceId }, data: { isEnabled: false, connectionStatus: "authorizing", lastErrorCode: null } }),
    ]);
    await recordAudit({ companyId: user.companyId, userId: user.id, actionName: START_GOOGLE_DRIVE_OAUTH_ACTION.actionName, inputPayload: { sourceId }, dataAfter: { expiresAt }, riskLevel: 1, result: "success" });
    return ok(200, { authorizationUrl, expiresAt });
  } catch (error) {
    const result = providerError(error);
    await auditFailure(START_GOOGLE_DRIVE_OAUTH_ACTION, user, sourceId, result.ok ? "CONNECTOR_INTERNAL_ERROR" : result.error);
    return result;
  }
}

export async function completeGoogleDriveOAuth(raw: unknown): Promise<ServiceResult<{ redirectUrl: string }>> {
  const parsed = callbackSchema.safeParse(raw);
  if (!parsed.success) return fail(400, "OAUTH_CALLBACK_INVALID");
  const state = await prisma.connectorOAuthState.findUnique({
    where: { stateHash: hash(parsed.data.state) },
    include: { source: { include: { credential: true } } },
  });
  if (!state || state.consumedAt) return fail(400, "OAUTH_STATE_INVALID");
  if (state.source.connectorKey !== DRIVE_KEY || state.expiresAt <= new Date()) return fail(400, "OAUTH_STATE_EXPIRED");
  const user = await prisma.user.findFirst({ where: { id: state.userId, companyId: state.companyId, isActive: true }, select: { permissions: true } });
  if (!user?.permissions.includes("connectors.manage")) return fail(403, "MISSING_PERMISSION");
  const consumed = await prisma.connectorOAuthState.updateMany({ where: { id: state.id, consumedAt: null }, data: { consumedAt: new Date() } });
  if (consumed.count !== 1) return fail(400, "OAUTH_STATE_INVALID");
  if (parsed.data.error) return fail(409, "OAUTH_PROVIDER_REJECTED");
  try {
    const oldRefresh = state.source.credential
      ? decryptDriveCredential(state.source.credential, state.companyId, state.sourceId).refreshToken
      : undefined;
    const value = await exchangeGoogleDriveAuthorizationCode(parsed.data.code!, oldRefresh);
    const encrypted = encryptConnectorPayload(value, context(state.companyId, state.sourceId));
    await prisma.$transaction([
      prisma.connectorCredential.upsert({
        where: { sourceId: state.sourceId },
        create: { sourceId: state.sourceId, companyId: state.companyId, provider: DRIVE_KEY, ...encrypted },
        update: { provider: DRIVE_KEY, ...encrypted },
      }),
      prisma.connectorSource.update({ where: { id: state.sourceId }, data: { connectionStatus: "configured", isEnabled: false, lastErrorCode: null } }),
    ]);
    await recordAudit({ companyId: state.companyId, userId: state.userId, actionName: COMPLETE_GOOGLE_DRIVE_OAUTH_ACTION.actionName, inputPayload: { sourceId: state.sourceId }, dataAfter: { provider: DRIVE_KEY, scopeVerified: true, encrypted: true }, riskLevel: 2, result: "success" });
    return ok(200, { redirectUrl: redirect(state.sourceId) });
  } catch (error) {
    return providerError(error);
  }
}

async function usable(source: Source) {
  let value = decryptDriveCredential(source.credential!, source.companyId, source.id);
  if (!Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= Date.now() + REFRESH_MARGIN) {
    value = await refreshGoogleDriveCredential(value);
    await prisma.connectorCredential.update({ where: { sourceId: source.id }, data: encryptConnectorPayload(value, context(source.companyId, source.id)) });
  }
  return value;
}

async function sourceFor(user: AuthedUser, sourceId: string) {
  return prisma.connectorSource.findFirst({
    where: { id: sourceId, companyId: user.companyId, connectorKey: DRIVE_KEY, isActive: true },
    include: { credential: true },
  });
}

export async function getDrivePickerToken(user: AuthedUser, sourceId: string): Promise<ServiceResult<unknown>> {
  const source = await sourceFor(user, sourceId);
  if (!source) return fail(404, "CONNECTOR_SOURCE_NOT_FOUND");
  if (!source.isEnabled) return fail(409, "CONNECTOR_NOT_ENABLED");
  if (!source.credential) return fail(409, "CONNECTOR_AUTHORIZATION_REQUIRED");
  try {
    const value = await usable(source);
    const appId = process.env.GOOGLE_DRIVE_PICKER_APP_ID?.trim();
    const developerKey = process.env.GOOGLE_DRIVE_PICKER_API_KEY?.trim();
    if (!appId || !developerKey) return fail(503, "PICKER_CONFIGURATION_MISSING");
    return ok(200, { accessToken: value.accessToken, expiresAt: new Date(value.expiresAt), appId, developerKey });
  } catch (error) {
    return providerError(error);
  }
}

export async function stageGoogleDriveImages(user: AuthedUser, sourceId: string, raw: unknown): Promise<ServiceResult<unknown>> {
  const parsed = stageSchema.safeParse(raw);
  if (!parsed.success) return fail(400, "VALIDATION_FAILED", parsed.error.message);
  const source = await sourceFor(user, sourceId);
  if (!source) return fail(404, "CONNECTOR_SOURCE_NOT_FOUND");
  if (!source.isEnabled || !source.credential) return fail(409, "CONNECTOR_NOT_ENABLED");
  try {
    const value = await usable(source);
    const items = [];
    for (const fileId of [...new Set(parsed.data.file_ids)]) {
      const file = await getGoogleDriveImage(value.accessToken, fileId);
      const date = (candidate?: string) => candidate && !Number.isNaN(Date.parse(candidate)) ? new Date(candidate) : undefined;
      items.push(await prisma.externalDriveImage.upsert({
        where: { companyId_connectorSourceId_externalFileId: { companyId: user.companyId, connectorSourceId: sourceId, externalFileId: file.id! } },
        create: {
          companyId: user.companyId,
          connectorSourceId: sourceId,
          externalFileId: file.id!,
          name: file.name!,
          mimeType: file.mimeType!,
          webViewLink: file.webViewLink,
          thumbnailLink: file.thumbnailLink,
          parentIds: file.parents ?? [],
          sizeBytes: file.size,
          width: file.imageMediaMetadata?.width,
          height: file.imageMediaMetadata?.height,
          createdTime: date(file.createdTime),
          modifiedTime: date(file.modifiedTime),
        },
        update: {
          name: file.name!,
          mimeType: file.mimeType!,
          webViewLink: file.webViewLink,
          thumbnailLink: file.thumbnailLink,
          parentIds: file.parents ?? [],
          sizeBytes: file.size,
          width: file.imageMediaMetadata?.width,
          height: file.imageMediaMetadata?.height,
          modifiedTime: date(file.modifiedTime),
          isRemoved: false,
          stagedAt: new Date(),
        },
      }));
    }
    await recordAudit({ companyId: user.companyId, userId: user.id, actionName: STAGE_GOOGLE_DRIVE_IMAGES_ACTION.actionName, inputPayload: { sourceId, selectedCount: parsed.data.file_ids.length }, dataAfter: { stagedIds: items.map((item) => item.id) }, riskLevel: 1, result: "success" });
    return ok(200, { items });
  } catch (error) {
    return providerError(error);
  }
}

export async function listDriveImages(user: AuthedUser, sourceId: string): Promise<ServiceResult<unknown>> {
  const source = await sourceFor(user, sourceId);
  if (!source) return fail(404, "CONNECTOR_SOURCE_NOT_FOUND");
  return ok(200, await prisma.externalDriveImage.findMany({
    where: { companyId: user.companyId, connectorSourceId: sourceId, isRemoved: false },
    orderBy: { stagedAt: "desc" },
  }));
}

export async function registerDrivePortfolioPhoto(user: AuthedUser, sourceId: string, imageId: string, raw: unknown): Promise<ServiceResult<unknown>> {
  const parsed = confirmSchema.safeParse(raw);
  if (!parsed.success) return fail(400, "VALIDATION_FAILED", parsed.error.message);
  const image = await prisma.externalDriveImage.findFirst({ where: { id: imageId, companyId: user.companyId, connectorSourceId: sourceId, isRemoved: false } });
  if (!image) return fail(404, "DRIVE_IMAGE_NOT_FOUND");
  if (image.portfolioPhotoId) return fail(409, "PHOTO_ALREADY_REGISTERED", undefined, { portfolioPhotoId: image.portfolioPhotoId });
  const preview = { imageId, name: image.name, mimeType: image.mimeType, willStoreBytes: false, usableForMarketing: false };
  if (!parsed.data.confirmed) return fail(409, "CONFIRMATION_REQUIRED", undefined, { preview });
  const result = await prisma.$transaction(async (tx) => {
    const current = await tx.externalDriveImage.findFirst({ where: { id: image.id, portfolioPhotoId: null } });
    if (!current) throw new Error("PHOTO_ALREADY_REGISTERED");
    const photo = await tx.portfolioPhoto.create({
      data: { companyId: user.companyId, filename: current.name, caption: parsed.data.caption, tags: parsed.data.tags ?? [], source: "google_drive", usableForMarketing: false, createdBy: user.id },
    });
    await tx.externalDriveImage.update({ where: { id: current.id }, data: { portfolioPhotoId: photo.id } });
    return photo;
  });
  await recordAudit({ companyId: user.companyId, userId: user.id, actionName: REGISTER_GOOGLE_DRIVE_PHOTO_ACTION.actionName, inputPayload: { sourceId, imageId, confirmed: true }, dataAfter: { portfolioPhotoId: result.id }, riskLevel: 3, confirmationRequired: true, confirmed: true, result: "success" });
  return ok(201, result);
}

export async function disconnectGoogleDriveSource(user: AuthedUser, sourceId: string, raw: unknown): Promise<ServiceResult<unknown>> {
  const parsed = disconnectSchema.safeParse(raw);
  if (!parsed.success) return fail(400, "VALIDATION_FAILED");
  const source = await sourceFor(user, sourceId);
  if (!source) return fail(404, "CONNECTOR_SOURCE_NOT_FOUND");
  const preview = { sourceId, willKeepStagedAndPortfolioMetadata: true, willRevokeGoogleProjectGrant: Boolean(source.credential) };
  if (!parsed.data.confirmed) return fail(409, "CONFIRMATION_REQUIRED", undefined, { preview });
  await prisma.connectorSource.update({ where: { id: sourceId }, data: { isEnabled: false, connectionStatus: "disconnecting" } });
  try {
    if (source.credential) await revokeGoogleDriveCredential(decryptDriveCredential(source.credential, source.companyId, source.id).refreshToken);
    const disconnectedAt = new Date();
    await prisma.$transaction([
      prisma.connectorCredential.deleteMany({ where: { sourceId } }),
      prisma.connectorOAuthState.deleteMany({ where: { sourceId } }),
      prisma.connectorSource.update({ where: { id: sourceId }, data: { isEnabled: false, connectionStatus: "disconnected", lastErrorCode: null } }),
    ]);
    const result = { sourceId, provider: DRIVE_KEY, providerGrantRevoked: Boolean(source.credential), disconnectedAt };
    await recordAudit({ companyId: user.companyId, userId: user.id, actionName: DISCONNECT_GOOGLE_DRIVE_SOURCE_ACTION.actionName, inputPayload: { sourceId, confirmed: true }, dataAfter: result, riskLevel: 3, confirmationRequired: true, confirmed: true, result: "success" });
    return ok(200, result);
  } catch (error) {
    const result = providerError(error);
    await prisma.connectorSource.update({ where: { id: sourceId }, data: { isEnabled: false, connectionStatus: "disconnect_failed", lastErrorCode: result.ok ? "CONNECTOR_INTERNAL_ERROR" : result.error } });
    return result;
  }
}
