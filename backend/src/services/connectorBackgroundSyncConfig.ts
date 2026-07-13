export const BACKGROUND_SYNC_CONNECTOR_KEYS = ["gmail", "google_contacts", "google_calendar"] as const;
export type BackgroundSyncConnectorKey = (typeof BACKGROUND_SYNC_CONNECTOR_KEYS)[number];

const DEFAULT_INTERVAL_MINUTES = 5;
const MINIMUM_INTERVAL_MINUTES = 1;
const DISABLED_VALUES = new Set(["0", "false", "no", "off"]);

export interface ConnectorBackgroundSyncConfiguration {
  enabled: boolean;
  intervalMs: number;
}

export function getConnectorBackgroundSyncConfiguration(
  environment: NodeJS.ProcessEnv = process.env
): ConnectorBackgroundSyncConfiguration {
  const enabledValue = environment.CONNECTOR_BACKGROUND_SYNC_ENABLED?.trim().toLowerCase();
  const enabled = !enabledValue || !DISABLED_VALUES.has(enabledValue);
  const requestedMinutes = Number.parseInt(environment.CONNECTOR_BACKGROUND_SYNC_INTERVAL_MINUTES ?? "", 10);
  const intervalMinutes = Number.isFinite(requestedMinutes)
    ? Math.max(MINIMUM_INTERVAL_MINUTES, requestedMinutes)
    : DEFAULT_INTERVAL_MINUTES;
  return { enabled, intervalMs: intervalMinutes * 60_000 };
}

export function isBackgroundSyncConnector(key: string): key is BackgroundSyncConnectorKey {
  return (BACKGROUND_SYNC_CONNECTOR_KEYS as readonly string[]).includes(key);
}

export function sourceSupportsBackgroundSync(connectorKey: string, configuredScopes: string[]) {
  if (connectorKey === "gmail") return configuredScopes.includes("read:messages");
  if (connectorKey === "google_contacts") return configuredScopes.includes("read:contacts");
  return connectorKey === "google_calendar" && configuredScopes.includes("read:calendar");
}

export function isBackgroundSyncDue(lastSyncAt: Date | null, now: Date, intervalMs: number) {
  return !lastSyncAt || lastSyncAt.getTime() <= now.getTime() - intervalMs;
}
