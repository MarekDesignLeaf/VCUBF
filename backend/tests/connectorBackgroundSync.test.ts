import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  getConnectorBackgroundSyncConfiguration,
  isBackgroundSyncConnector,
  isBackgroundSyncDue,
  sourceSupportsBackgroundSync,
} from "../src/services/connectorBackgroundSyncConfig.js";

describe("connector background-sync configuration", () => {
  it("defaults to enabled five-minute polling and permits an explicit maintenance pause", () => {
    assert.deepEqual(getConnectorBackgroundSyncConfiguration({}), { enabled: true, intervalMs: 5 * 60_000 });
    assert.deepEqual(getConnectorBackgroundSyncConfiguration({ CONNECTOR_BACKGROUND_SYNC_ENABLED: "false" }), { enabled: false, intervalMs: 5 * 60_000 });
  });

  it("enforces the minimum interval instead of polling providers continuously", () => {
    assert.deepEqual(getConnectorBackgroundSyncConfiguration({ CONNECTOR_BACKGROUND_SYNC_INTERVAL_MINUTES: "0" }), { enabled: true, intervalMs: 60_000 });
    assert.deepEqual(getConnectorBackgroundSyncConfiguration({ CONNECTOR_BACKGROUND_SYNC_INTERVAL_MINUTES: "2" }), { enabled: true, intervalMs: 2 * 60_000 });
  });

  it("limits background polling to enabled read-capable connectors and due sources", () => {
    assert.equal(isBackgroundSyncConnector("gmail"), true);
    assert.equal(isBackgroundSyncConnector("google_drive"), false);
    assert.equal(sourceSupportsBackgroundSync("gmail", ["read:messages"]), true);
    assert.equal(sourceSupportsBackgroundSync("gmail", ["send:messages"]), false);
    assert.equal(sourceSupportsBackgroundSync("google_contacts", ["read:contacts"]), true);
    assert.equal(sourceSupportsBackgroundSync("google_calendar", ["read:calendar"]), true);
    const now = new Date("2026-07-13T12:00:00.000Z");
    assert.equal(isBackgroundSyncDue(null, now, 5 * 60_000), true);
    assert.equal(isBackgroundSyncDue(new Date("2026-07-13T11:55:00.000Z"), now, 5 * 60_000), true);
    assert.equal(isBackgroundSyncDue(new Date("2026-07-13T11:59:00.000Z"), now, 5 * 60_000), false);
  });
});
