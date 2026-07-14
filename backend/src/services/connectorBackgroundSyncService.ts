import { prisma } from "../db.js";
import type { AuthedUser } from "../middleware/auth.js";
import { syncGmailMessages } from "./gmailConnectorService.js";
import { syncGoogleCalendar } from "./googleCalendarConnectorService.js";
import { syncGoogleContacts } from "./googleContactsConnectorService.js";
import {
  getConnectorBackgroundSyncConfiguration,
  type ConnectorBackgroundSyncConfiguration,
} from "./connectorBackgroundSyncConfig.js";

export interface ConnectorBackgroundSyncSummary {
  started: boolean;
  scanned: number;
  claimed: number;
  succeeded: number;
  failed: number;
  skippedWithoutManager: number;
}

type BackgroundSyncSource = {
  id: string;
  companyId: string;
  connectorKey: string;
  createdBy: string | null;
};

function toAuthedUser(user: {
  id: string;
  companyId: string;
  email: string;
  displayName: string;
  role: string;
  permissions: string[];
  mustChangePassword: boolean;
  voiceWakeWord: string;
  voiceContinuous: boolean;
  voiceLanguage: string;
}): AuthedUser {
  return user;
}

async function runSourceSync(source: BackgroundSyncSource, actor: AuthedUser) {
  if (source.connectorKey === "gmail") {
    return syncGmailMessages(actor, source.id, { max_results: 50 });
  }
  if (source.connectorKey === "google_contacts") {
    return syncGoogleContacts(actor, source.id);
  }
  if (source.connectorKey === "google_calendar") {
    return syncGoogleCalendar(actor, source.id);
  }
  return null;
}

let sweepRunning = false;
let scheduler: NodeJS.Timeout | undefined;

function requestConfiguredSweep(configuration: ConnectorBackgroundSyncConfiguration) {
  void runConnectorBackgroundSyncOnce(configuration).catch(() => {
    // Source status stores the actionable error when a provider call runs. This
    // final guard prevents an unexpected scheduler failure from crashing HTTP.
    console.error("Connector background sync sweep failed.");
  });
}

export async function runConnectorBackgroundSyncOnce(
  configuration = getConnectorBackgroundSyncConfiguration()
): Promise<ConnectorBackgroundSyncSummary> {
  if (!configuration.enabled || sweepRunning) {
    return { started: false, scanned: 0, claimed: 0, succeeded: 0, failed: 0, skippedWithoutManager: 0 };
  }

  sweepRunning = true;
  try {
    const now = new Date();
    const cutoff = new Date(now.getTime() - configuration.intervalMs);
    const sources = await prisma.connectorSource.findMany({
      where: {
        isActive: true,
        isEnabled: true,
        credential: { isNot: null },
        OR: [
          { connectorKey: "gmail", configuredScopes: { has: "read:messages" } },
          { connectorKey: "google_contacts", configuredScopes: { has: "read:contacts" } },
          { connectorKey: "google_calendar", configuredScopes: { has: "read:calendar" } },
        ],
        AND: [{ OR: [{ lastSyncAt: null }, { lastSyncAt: { lt: cutoff } }] }],
      },
      select: { id: true, companyId: true, connectorKey: true, createdBy: true },
      orderBy: [{ lastSyncAt: "asc" }, { createdAt: "asc" }],
    });
    if (sources.length === 0) {
      return { started: true, scanned: 0, claimed: 0, succeeded: 0, failed: 0, skippedWithoutManager: 0 };
    }

    const companyIds = [...new Set(sources.map((source) => source.companyId))];
    const managers = await prisma.user.findMany({
      where: { companyId: { in: companyIds }, isActive: true, permissions: { has: "connectors.manage" } },
      select: {
        id: true,
        companyId: true,
        email: true,
        displayName: true,
        role: true,
        permissions: true,
        mustChangePassword: true,
        voiceWakeWord: true,
        voiceContinuous: true,
        voiceLanguage: true,
      },
      orderBy: { createdAt: "asc" },
    });
    const managersByCompany = new Map<string, AuthedUser[]>();
    for (const manager of managers) {
      const companyManagers = managersByCompany.get(manager.companyId) ?? [];
      companyManagers.push(toAuthedUser(manager));
      managersByCompany.set(manager.companyId, companyManagers);
    }

    let claimed = 0;
    let succeeded = 0;
    let failed = 0;
    let skippedWithoutManager = 0;
    for (const source of sources) {
      const companyManagers = managersByCompany.get(source.companyId) ?? [];
      const actor = companyManagers.find((manager) => manager.id === source.createdBy) ?? companyManagers[0];
      if (!actor) {
        const marked = await prisma.connectorSource.updateMany({
          where: {
            id: source.id,
            companyId: source.companyId,
            isActive: true,
            isEnabled: true,
            OR: [{ lastSyncAt: null }, { lastSyncAt: { lt: cutoff } }],
          },
          data: { lastSyncAt: now, lastSyncStatus: "error", lastErrorCode: "CONNECTOR_AUTOMATION_ACTOR_REQUIRED" },
        });
        if (marked.count === 1) skippedWithoutManager++;
        continue;
      }

      const lease = await prisma.connectorSource.updateMany({
        where: {
          id: source.id,
          companyId: source.companyId,
          isActive: true,
          isEnabled: true,
          OR: [{ lastSyncAt: null }, { lastSyncAt: { lt: cutoff } }],
        },
        data: { lastSyncAt: now, lastSyncStatus: "syncing", lastErrorCode: null },
      });
      if (lease.count !== 1) continue;
      claimed++;

      try {
        const result = await runSourceSync(source, actor);
        if (result?.ok) {
          succeeded++;
          continue;
        }
        failed++;
        await prisma.connectorSource.updateMany({
          where: { id: source.id, lastSyncStatus: "syncing" },
          data: { lastSyncAt: new Date(), lastSyncStatus: "error", lastErrorCode: result?.error ?? "CONNECTOR_BACKGROUND_SYNC_FAILED" },
        });
      } catch {
        failed++;
        await prisma.connectorSource.updateMany({
          where: { id: source.id, lastSyncStatus: "syncing" },
          data: { lastSyncAt: new Date(), lastSyncStatus: "error", lastErrorCode: "CONNECTOR_BACKGROUND_SYNC_FAILED" },
        });
      }
    }
    return { started: true, scanned: sources.length, claimed, succeeded, failed, skippedWithoutManager };
  } finally {
    sweepRunning = false;
  }
}

export function startConnectorBackgroundSync() {
  if (scheduler) return;
  const configuration = getConnectorBackgroundSyncConfiguration();
  if (!configuration.enabled) {
    console.log("Connector background sync is disabled by configuration.");
    return;
  }

  const run = () => requestConfiguredSweep(configuration);
  run();
  scheduler = setInterval(run, configuration.intervalMs);
  console.log(`Connector background sync is enabled every ${Math.round(configuration.intervalMs / 60_000)} minute(s).`);
}

export function requestConnectorBackgroundSync() {
  // Tests exercise background sweeps directly. Starting a detached sweep from
  // an HTTP request would race connector-specific fetch mocks and make the
  // result depend on timing rather than connector behaviour.
  if (process.env.NODE_ENV === "test") return;
  const configuration = getConnectorBackgroundSyncConfiguration();
  if (!configuration.enabled) return;
  requestConfiguredSweep(configuration);
}

export function stopConnectorBackgroundSync() {
  if (!scheduler) return;
  clearInterval(scheduler);
  scheduler = undefined;
}
