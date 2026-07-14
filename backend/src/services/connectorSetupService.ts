import type { AuthedUser } from "../middleware/auth.js";
import { CONNECTOR_KEYS, type ConnectorKey } from "../connectors/registry.js";
import * as connectorService from "./connectorService.js";
import * as gmailConnectorService from "./gmailConnectorService.js";
import * as googleContactsConnectorService from "./googleContactsConnectorService.js";
import * as googleCalendarConnectorService from "./googleCalendarConnectorService.js";
import { validateWhatsAppConfiguration, WhatsAppBusinessAdapterError } from "../connectors/whatsappBusinessAdapter.js";
import { fail, ok, type ServiceResult } from "./result.js";

export type ConnectorSetupTarget = ConnectorKey | "all";

const setupDefaults: Record<ConnectorKey, { displayName: string; scopes: string[] }> = {
  gmail: { displayName: "Gmail", scopes: ["read:messages", "write:drafts", "send:messages"] },
  google_contacts: { displayName: "Google Contacts", scopes: ["read:contacts"] },
  google_calendar: { displayName: "Google Calendar", scopes: ["read:calendar"] },
  google_drive: { displayName: "Google Drive", scopes: ["select:image_files"] },
  google_photos: { displayName: "Google Photos", scopes: ["select:user_selected_photos"] },
  whatsapp_business: { displayName: "WhatsApp Business", scopes: ["read:messages", "send:messages"] },
};

function selectedKeys(target: ConnectorSetupTarget) {
  return target === "all" ? [...CONNECTOR_KEYS] : [target];
}

function canManage(user: AuthedUser) {
  return user.permissions.includes("connectors.manage");
}

function setupState(source: any) {
  if (!source.isActive) return "inactive";
  if (source.isEnabled) return "ready";
  if (!source.configurationAvailable) return "needs_deployment_configuration";
  if (!source.authorizationConfigured) return "needs_authorization";
  return "needs_confirmation";
}

export async function connectorSetupStatus(user: AuthedUser, target: ConnectorSetupTarget): Promise<ServiceResult<unknown>> {
  if (!user.permissions.includes("connectors.read")) return fail(403, "MISSING_PERMISSION", "Connector read permission is required.");
  const keys = selectedKeys(target);
  const sources = await connectorService.listConnectorSources(user, false);
  let whatsappProviderStatus: { ok: boolean; error?: string; message?: string; details?: unknown } | undefined;
  if (keys.includes("whatsapp_business")) {
    try {
      const details = await validateWhatsAppConfiguration();
      whatsappProviderStatus = { ok: true, details };
    } catch (error) {
      whatsappProviderStatus = error instanceof WhatsAppBusinessAdapterError
        ? { ok: false, error: error.code, message: error.message }
        : { ok: false, error: "CONNECTOR_INTERNAL_ERROR" };
    }
  }
  const items = keys.map((connectorKey) => {
    const candidates = sources.filter((source) => source.connectorKey === connectorKey);
    const source = candidates.find((item) => item.isActive && item.isEnabled)
      ?? candidates.find((item) => item.isActive && item.authorizationConfigured)
      ?? candidates.find((item) => item.isActive)
      ?? candidates[0];
    return source
      ? {
          connectorKey,
          source,
          setupState: connectorKey === "whatsapp_business" && whatsappProviderStatus && !whatsappProviderStatus.ok
            ? "needs_authorization"
            : setupState(source),
          ...(connectorKey === "whatsapp_business" ? { providerStatus: whatsappProviderStatus } : {}),
        }
      : { connectorKey, source: null, setupState: "not_registered" };
  });
  return ok(200, { target, items });
}

export async function prepareConnectorSetup(user: AuthedUser, target: ConnectorSetupTarget): Promise<ServiceResult<unknown>> {
  if (!canManage(user)) return fail(403, "MISSING_PERMISSION", "Connector management permission is required.");
  const keys = selectedKeys(target);
  const created: ConnectorKey[] = [];
  let sources = await connectorService.listConnectorSources(user, false);

  for (const connectorKey of keys) {
    if (sources.some((source) => source.connectorKey === connectorKey)) continue;
    const defaults = setupDefaults[connectorKey];
    const result = await connectorService.registerConnectorSource(user, {
      connector_key: connectorKey,
      display_name: defaults.displayName,
      configured_scopes: defaults.scopes,
    });
    if (!result.ok && result.error !== "CONNECTOR_SOURCE_ALREADY_EXISTS") return result;
    if (result.ok) created.push(connectorKey);
    sources = await connectorService.listConnectorSources(user, false);
  }

  const status = await connectorSetupStatus(user, target);
  if (!status.ok) return status;
  return ok(created.length ? 201 : 200, { ...(status.data as object), created });
}

export async function syncConnectors(user: AuthedUser, target: ConnectorSetupTarget): Promise<ServiceResult<unknown>> {
  if (!canManage(user)) return fail(403, "MISSING_PERMISSION", "Connector management permission is required.");
  const keys = selectedKeys(target);
  const sources = await connectorService.listConnectorSources(user, true);
  const results: Array<Record<string, unknown>> = [];

  for (const connectorKey of keys) {
    const source = sources.find((item) => item.connectorKey === connectorKey && item.isEnabled);
    if (!source) {
      results.push({ connectorKey, ok: false, status: "not_enabled" });
      continue;
    }
    if (connectorKey === "google_drive" || connectorKey === "google_photos") {
      results.push({ connectorKey, ok: true, status: "ready_for_user_selection", sourceId: source.id });
      continue;
    }
    if (connectorKey === "whatsapp_business") {
      try {
        const provider = await validateWhatsAppConfiguration();
        results.push({ connectorKey, ok: true, status: "listening_for_signed_webhooks", sourceId: source.id, provider });
      } catch (error) {
        results.push({
          connectorKey,
          ok: false,
          status: "authorization_failed",
          sourceId: source.id,
          error: error instanceof WhatsAppBusinessAdapterError ? error.code : "CONNECTOR_INTERNAL_ERROR",
          message: error instanceof Error ? error.message : undefined,
        });
      }
      continue;
    }
    const result = connectorKey === "google_contacts"
      ? await googleContactsConnectorService.syncGoogleContacts(user, source.id)
      : connectorKey === "google_calendar"
        ? await googleCalendarConnectorService.syncGoogleCalendar(user, source.id)
        : await gmailConnectorService.syncGmailMessages(user, source.id, { max_results: 25 });
    results.push(result.ok
      ? { connectorKey, ok: true, status: "synced", sourceId: source.id, result: result.data }
      : { connectorKey, ok: false, status: "sync_failed", sourceId: source.id, error: result.error, message: result.message });
  }

  const failures = results.filter((item) => !item.ok).length;
  return ok(200, { target, results, failures });
}
