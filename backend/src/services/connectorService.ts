import { z } from "zod";
import { prisma } from "../db.js";
import {
  DISABLE_CONNECTOR_SOURCE_ACTION,
  ENABLE_CONNECTOR_SOURCE_ACTION,
  REGISTER_CONNECTOR_SOURCE_ACTION,
  UPDATE_CONNECTOR_SOURCE_ACTION,
} from "../lib/actionContracts.js";
import { recordAudit } from "../lib/audit.js";
import {
  CONNECTOR_DEFINITIONS,
  CONNECTOR_KEYS,
  getConnectorDefinition,
  type ConnectorDefinition,
} from "../connectors/registry.js";
import type { AuthedUser } from "../middleware/auth.js";
import { whatsAppConfigurationAvailable } from "../connectors/whatsappBusinessAdapter.js";
import { assertConnectorEncryptionConfigured } from "../connectors/connectorCrypto.js";
import { fail, ok, type ServiceResult } from "./result.js";

const credentialReferenceSchema = z
  .string()
  .trim()
  .max(500)
  .regex(/^(env|vault|secret-manager):[A-Za-z0-9_./-]+$/, "credential_reference must be an env:, vault: or secret-manager: reference");

export const registerConnectorSourceSchema = z
  .object({
    connector_key: z.enum(CONNECTOR_KEYS),
    display_name: z.string().trim().min(1, "display_name is required").max(200),
    configured_scopes: z.array(z.string().trim().min(1)).default([]),
    credential_reference: credentialReferenceSchema.optional(),
  })
  .strict();

export const updateConnectorSourceSchema = z
  .object({
    display_name: z.string().trim().min(1).max(200).optional(),
    configured_scopes: z.array(z.string().trim().min(1)).optional(),
    credential_reference: credentialReferenceSchema.nullable().optional(),
    is_active: z.boolean().optional(),
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, "At least one field is required");

export const enableConnectorSourceSchema = z.object({ confirmed: z.boolean().optional() }).strict();

type ConnectorAction =
  | typeof REGISTER_CONNECTOR_SOURCE_ACTION
  | typeof UPDATE_CONNECTOR_SOURCE_ACTION
  | typeof DISABLE_CONNECTOR_SOURCE_ACTION
  | typeof ENABLE_CONNECTOR_SOURCE_ACTION;

function redactInput(rawInput: unknown): unknown {
  if (Array.isArray(rawInput)) return rawInput.map(redactInput);
  if (!rawInput || typeof rawInput !== "object") return rawInput;
  return Object.fromEntries(
    Object.entries(rawInput as Record<string, unknown>).map(([key, value]) => [
      key,
      key === "credential_reference" ? "[REDACTED_REFERENCE]" : redactInput(value),
    ])
  );
}

export function publicConnectorSource<T extends {
  connectorKey: string;
  credentialReference: string | null;
  credential?: { sourceId: string } | null;
  syncCursor?: string | null;
  syncPageToken?: string | null;
}>(source: T) {
  const { credentialReference, credential, syncCursor, syncPageToken: _syncPageToken, ...safe } = source;
  return {
    ...safe,
    credentialReferenceConfigured: Boolean(credentialReference),
    configurationAvailable: connectorConfigurationAvailable(source.connectorKey),
    authorizationConfigured: Boolean(credential) || (source.connectorKey === "whatsapp_business" && whatsAppConfigurationAvailable()),
    incrementalSyncConfigured: Boolean(syncCursor),
    definition: getConnectorDefinition(source.connectorKey),
  };
}

function validProviderRedirect(value: string | undefined) {
  if (!value?.trim()) return false;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname));
  } catch {
    return false;
  }
}

export function connectorConfigurationAvailable(connectorKey: string) {
  if (connectorKey === "whatsapp_business") return whatsAppConfigurationAvailable();
  try { assertConnectorEncryptionConfigured(); } catch { return false; }
  const requiredByConnector: Record<string, [string | undefined, string | undefined, string | undefined]> = {
    gmail: [process.env.GMAIL_OAUTH_CLIENT_ID, process.env.GMAIL_OAUTH_CLIENT_SECRET, process.env.GMAIL_OAUTH_REDIRECT_URI],
    google_contacts: [process.env.GOOGLE_CONTACTS_OAUTH_CLIENT_ID, process.env.GOOGLE_CONTACTS_OAUTH_CLIENT_SECRET, process.env.GOOGLE_CONTACTS_OAUTH_REDIRECT_URI],
    google_calendar: [process.env.GOOGLE_CALENDAR_OAUTH_CLIENT_ID, process.env.GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET, process.env.GOOGLE_CALENDAR_OAUTH_REDIRECT_URI],
    google_drive: [process.env.GOOGLE_DRIVE_OAUTH_CLIENT_ID, process.env.GOOGLE_DRIVE_OAUTH_CLIENT_SECRET, process.env.GOOGLE_DRIVE_OAUTH_REDIRECT_URI],
    google_photos: [process.env.GOOGLE_PHOTOS_OAUTH_CLIENT_ID, process.env.GOOGLE_PHOTOS_OAUTH_CLIENT_SECRET, process.env.GOOGLE_PHOTOS_OAUTH_REDIRECT_URI],
  };
  const required = requiredByConnector[connectorKey];
  return Boolean(required?.[0]?.trim() && required?.[1]?.trim() && validProviderRedirect(required?.[2]));
}

async function auditError(
  user: AuthedUser,
  action: ConnectorAction,
  inputPayload: unknown,
  errorMessage: string,
  dataBefore?: unknown
) {
  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: action.actionName,
    inputPayload: redactInput(inputPayload),
    dataBefore,
    riskLevel: action.riskLevel,
    confirmationRequired: action.confirmationRequired,
    result: "error",
    errorMessage,
  });
}

function unsupportedScopes(definition: ConnectorDefinition, scopes: string[]) {
  return [...new Set(scopes)].filter((scope) => !definition.logicalScopes.includes(scope));
}

export function listConnectorDefinitions() {
  return CONNECTOR_KEYS.map((key) => CONNECTOR_DEFINITIONS[key]);
}

export async function listConnectorSources(user: AuthedUser, activeOnly = false) {
  const sources = await prisma.connectorSource.findMany({
    where: { companyId: user.companyId, ...(activeOnly ? { isActive: true } : {}) },
    include: { credential: { select: { sourceId: true } } },
    orderBy: [{ serviceType: "asc" }, { displayName: "asc" }],
  });
  return sources.map(publicConnectorSource);
}

export async function getConnectorSource(user: AuthedUser, id: string) {
  const source = await prisma.connectorSource.findFirst({
    where: { id, companyId: user.companyId },
    include: { credential: { select: { sourceId: true } } },
  });
  return source ? publicConnectorSource(source) : null;
}

export async function registerConnectorSource(user: AuthedUser, rawInput: unknown): Promise<ServiceResult<unknown>> {
  const parsed = registerConnectorSourceSchema.safeParse(rawInput);
  if (!parsed.success) {
    await auditError(user, REGISTER_CONNECTOR_SOURCE_ACTION, rawInput, "VALIDATION_FAILED");
    return fail(400, "VALIDATION_FAILED", parsed.error.message);
  }
  const input = parsed.data;
  const definition = getConnectorDefinition(input.connector_key);
  if (!definition) {
    await auditError(user, REGISTER_CONNECTOR_SOURCE_ACTION, input, "CONNECTOR_DEFINITION_NOT_FOUND");
    return fail(404, "CONNECTOR_DEFINITION_NOT_FOUND");
  }
  const invalidScopes = unsupportedScopes(definition, input.configured_scopes);
  if (invalidScopes.length > 0) {
    await auditError(user, REGISTER_CONNECTOR_SOURCE_ACTION, input, "UNSUPPORTED_CONNECTOR_SCOPE");
    return fail(400, "UNSUPPORTED_CONNECTOR_SCOPE", "One or more logical scopes are not declared by this connector.", {
      unsupportedScopes: invalidScopes,
      allowedScopes: definition.logicalScopes,
    });
  }
  const duplicate = await prisma.connectorSource.findFirst({
    where: {
      companyId: user.companyId,
      connectorKey: input.connector_key,
      displayName: { equals: input.display_name, mode: "insensitive" },
    },
  });
  if (duplicate) {
    await auditError(user, REGISTER_CONNECTOR_SOURCE_ACTION, input, "CONNECTOR_SOURCE_ALREADY_EXISTS");
    return fail(409, "CONNECTOR_SOURCE_ALREADY_EXISTS");
  }
  const created = await prisma.connectorSource.create({
    data: {
      companyId: user.companyId,
      connectorKey: definition.key,
      displayName: input.display_name,
      serviceType: definition.serviceType,
      configuredScopes: [...new Set(input.configured_scopes)],
      credentialReference: input.credential_reference,
      createdBy: user.id,
    },
  });
  const safeCreated = publicConnectorSource(created);
  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: REGISTER_CONNECTOR_SOURCE_ACTION.actionName,
    inputPayload: redactInput(input),
    dataAfter: safeCreated,
    riskLevel: REGISTER_CONNECTOR_SOURCE_ACTION.riskLevel,
    confirmationRequired: REGISTER_CONNECTOR_SOURCE_ACTION.confirmationRequired,
    result: "success",
  });
  return ok(201, safeCreated);
}

export async function updateConnectorSource(
  user: AuthedUser,
  id: string,
  rawInput: unknown
): Promise<ServiceResult<unknown>> {
  const parsed = updateConnectorSourceSchema.safeParse(rawInput);
  if (!parsed.success) {
    await auditError(user, UPDATE_CONNECTOR_SOURCE_ACTION, { id, input: rawInput }, "VALIDATION_FAILED");
    return fail(400, "VALIDATION_FAILED", parsed.error.message);
  }
  const input = parsed.data;
  const existing = await prisma.connectorSource.findFirst({
    where: { id, companyId: user.companyId },
    include: { credential: { select: { sourceId: true } } },
  });
  if (!existing) {
    await auditError(user, UPDATE_CONNECTOR_SOURCE_ACTION, { id, ...input }, "CONNECTOR_SOURCE_NOT_FOUND");
    return fail(404, "CONNECTOR_SOURCE_NOT_FOUND");
  }
  if (existing.isEnabled) {
    await auditError(user, UPDATE_CONNECTOR_SOURCE_ACTION, { id, ...input }, "CONNECTOR_MUST_BE_DISABLED", publicConnectorSource(existing));
    return fail(409, "CONNECTOR_MUST_BE_DISABLED", "Disable the source before changing its configuration.");
  }
  const definition = getConnectorDefinition(existing.connectorKey)!;
  if (input.configured_scopes) {
    const invalidScopes = unsupportedScopes(definition, input.configured_scopes);
    if (invalidScopes.length > 0) {
      await auditError(user, UPDATE_CONNECTOR_SOURCE_ACTION, { id, ...input }, "UNSUPPORTED_CONNECTOR_SCOPE", publicConnectorSource(existing));
      return fail(400, "UNSUPPORTED_CONNECTOR_SCOPE", "One or more logical scopes are not declared by this connector.", {
        unsupportedScopes: invalidScopes,
        allowedScopes: definition.logicalScopes,
      });
    }
  }
  if (input.display_name && input.display_name.toLowerCase() !== existing.displayName.toLowerCase()) {
    const duplicate = await prisma.connectorSource.findFirst({
      where: {
        companyId: user.companyId,
        connectorKey: existing.connectorKey,
        displayName: { equals: input.display_name, mode: "insensitive" },
        id: { not: existing.id },
      },
    });
    if (duplicate) {
      await auditError(user, UPDATE_CONNECTOR_SOURCE_ACTION, { id, ...input }, "CONNECTOR_SOURCE_ALREADY_EXISTS", publicConnectorSource(existing));
      return fail(409, "CONNECTOR_SOURCE_ALREADY_EXISTS");
    }
  }
  const changes: Record<string, unknown> = {};
  if (input.display_name !== undefined) changes.displayName = input.display_name;
  if (input.configured_scopes !== undefined) changes.configuredScopes = [...new Set(input.configured_scopes)];
  if (input.credential_reference !== undefined) {
    changes.credentialReference = input.credential_reference;
    changes.connectionStatus = "setup_required";
    changes.lastErrorCode = null;
  }
  if (input.is_active !== undefined) {
    changes.isActive = input.is_active;
    if (!input.is_active) {
      changes.isEnabled = false;
      changes.connectionStatus = "disabled";
    }
  }
  const updated = await prisma.connectorSource.update({
    where: { id: existing.id },
    data: changes,
    include: { credential: { select: { sourceId: true } } },
  });
  const safeBefore = publicConnectorSource(existing);
  const safeUpdated = publicConnectorSource(updated);
  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: UPDATE_CONNECTOR_SOURCE_ACTION.actionName,
    inputPayload: redactInput({ id, ...input }),
    dataBefore: safeBefore,
    dataAfter: safeUpdated,
    riskLevel: UPDATE_CONNECTOR_SOURCE_ACTION.riskLevel,
    confirmationRequired: UPDATE_CONNECTOR_SOURCE_ACTION.confirmationRequired,
    result: "success",
  });
  return ok(200, safeUpdated);
}

export async function disableConnectorSource(user: AuthedUser, id: string): Promise<ServiceResult<unknown>> {
  const existing = await prisma.connectorSource.findFirst({
    where: { id, companyId: user.companyId },
    include: { credential: { select: { sourceId: true } } },
  });
  if (!existing) {
    await auditError(user, DISABLE_CONNECTOR_SOURCE_ACTION, { id }, "CONNECTOR_SOURCE_NOT_FOUND");
    return fail(404, "CONNECTOR_SOURCE_NOT_FOUND");
  }
  const [updated] = await prisma.$transaction([
    prisma.connectorSource.update({
      where: { id: existing.id },
      data: { isEnabled: false, connectionStatus: "disabled" },
      include: { credential: { select: { sourceId: true } } },
    }),
    prisma.connectorOAuthState.deleteMany({ where: { sourceId: existing.id } }),
  ]);
  const safeBefore = publicConnectorSource(existing);
  const safeUpdated = publicConnectorSource(updated);
  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: DISABLE_CONNECTOR_SOURCE_ACTION.actionName,
    inputPayload: { id },
    dataBefore: safeBefore,
    dataAfter: safeUpdated,
    riskLevel: DISABLE_CONNECTOR_SOURCE_ACTION.riskLevel,
    confirmationRequired: DISABLE_CONNECTOR_SOURCE_ACTION.confirmationRequired,
    result: "success",
  });
  return ok(200, safeUpdated);
}

export async function enableConnectorSource(
  user: AuthedUser,
  id: string,
  rawInput: unknown
): Promise<ServiceResult<unknown>> {
  const parsed = enableConnectorSourceSchema.safeParse(rawInput);
  if (!parsed.success) {
    await auditError(user, ENABLE_CONNECTOR_SOURCE_ACTION, { id, input: rawInput }, "VALIDATION_FAILED");
    return fail(400, "VALIDATION_FAILED", parsed.error.message);
  }
  const existing = await prisma.connectorSource.findFirst({
    where: { id, companyId: user.companyId, isActive: true },
    include: { credential: { select: { sourceId: true } } },
  });
  if (!existing) {
    await auditError(user, ENABLE_CONNECTOR_SOURCE_ACTION, { id }, "CONNECTOR_SOURCE_NOT_FOUND");
    return fail(404, "CONNECTOR_SOURCE_NOT_FOUND");
  }
  const definition = getConnectorDefinition(existing.connectorKey)!;
  if (!definition.adapterAvailable) {
    await auditError(user, ENABLE_CONNECTOR_SOURCE_ACTION, { id }, "CONNECTOR_ADAPTER_UNAVAILABLE", publicConnectorSource(existing));
    return fail(
      409,
      "CONNECTOR_ADAPTER_UNAVAILABLE",
      `${definition.serviceName} is contract-only in this build; no external account was accessed.`
    );
  }
  const usesDeploymentCredential = existing.connectorKey === "whatsapp_business";
  if (usesDeploymentCredential && !whatsAppConfigurationAvailable()) {
    await auditError(user, ENABLE_CONNECTOR_SOURCE_ACTION, { id }, "CONNECTOR_CONFIGURATION_MISSING", publicConnectorSource(existing));
    return fail(503, "CONNECTOR_CONFIGURATION_MISSING", "Configure the WhatsApp Business deployment secrets before enabling this source.");
  }
  if (!existing.credential && !usesDeploymentCredential) {
    await auditError(user, ENABLE_CONNECTOR_SOURCE_ACTION, { id }, "CONNECTOR_AUTHORIZATION_REQUIRED", publicConnectorSource(existing));
    return fail(409, "CONNECTOR_AUTHORIZATION_REQUIRED", "Authorize the provider account before enabling this source.");
  }
  if (existing.configuredScopes.length === 0) {
    await auditError(user, ENABLE_CONNECTOR_SOURCE_ACTION, { id }, "CONNECTOR_SCOPE_REQUIRED", publicConnectorSource(existing));
    return fail(409, "CONNECTOR_SCOPE_REQUIRED");
  }
  if (usesDeploymentCredential) {
    const competingSource = await prisma.connectorSource.findFirst({
      where: { connectorKey: "whatsapp_business", isEnabled: true, isActive: true, id: { not: existing.id } },
      select: { id: true },
    });
    if (competingSource) {
      await auditError(user, ENABLE_CONNECTOR_SOURCE_ACTION, { id }, "WHATSAPP_SOURCE_ALREADY_ENABLED", publicConnectorSource(existing));
      return fail(409, "WHATSAPP_SOURCE_ALREADY_ENABLED", "This deployment supports one active WhatsApp Business phone number.");
    }
  }
  const preview = { source: publicConnectorSource(existing), willEnableExternalAccess: true };
  if (!parsed.data.confirmed) {
    await auditError(user, ENABLE_CONNECTOR_SOURCE_ACTION, { id, confirmed: false }, "CONFIRMATION_REQUIRED", preview);
    return fail(409, "CONFIRMATION_REQUIRED", "Review the connector access and resubmit with confirmed: true.", { preview });
  }
  const updated = await prisma.connectorSource.update({
    where: { id: existing.id },
    data: { isEnabled: true, connectionStatus: "enabled", lastErrorCode: null },
    include: { credential: { select: { sourceId: true } } },
  });
  const safeUpdated = publicConnectorSource(updated);
  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: ENABLE_CONNECTOR_SOURCE_ACTION.actionName,
    inputPayload: { id, confirmed: true },
    dataBefore: publicConnectorSource(existing),
    dataAfter: safeUpdated,
    riskLevel: ENABLE_CONNECTOR_SOURCE_ACTION.riskLevel,
    confirmationRequired: ENABLE_CONNECTOR_SOURCE_ACTION.confirmationRequired,
    confirmed: true,
    result: "success",
  });
  return ok(200, safeUpdated);
}
