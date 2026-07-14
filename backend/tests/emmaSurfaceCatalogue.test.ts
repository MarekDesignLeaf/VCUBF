import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import {
  capabilityIdForCommand,
  capabilityIdsForCommand,
  COMMAND_POLICY,
  EMMA_ACTION_CAPABILITY_COUNT,
  EMMA_ACTION_CONTRACTS,
  EMMA_CAPABILITIES,
  EMMA_PAGE_CAPABILITY_COUNT,
} from "../src/lib/emmaSurfaceCatalogue.js";
import { VOICE_PAGE_ROUTES } from "../src/lib/voiceNavigation.js";
import { EMMA_DYNAMIC_COMMAND_ACTIONS, EMMA_EXECUTABLE_ACTIONS, EMMA_NON_DIRECT_ACTIONS } from "../src/lib/emmaExecutableActionCatalogue.js";

describe("complete mirrored Emma surface catalogue", () => {
  it("contains every unique action contract automatically", () => {
    const actionNames = EMMA_ACTION_CONTRACTS.map((item) => item.actionName);
    assert.equal(new Set(actionNames).size, actionNames.length);
    assert.equal(EMMA_ACTION_CAPABILITY_COUNT, actionNames.length);
    for (const actionName of actionNames) {
      assert.ok(EMMA_CAPABILITIES.some((item) => item.id === `action.${actionName}`));
    }
  });

  it("contains every voice page and every non-login frontend route", () => {
    for (const page of Object.keys(VOICE_PAGE_ROUTES)) {
      assert.ok(EMMA_CAPABILITIES.some((item) => item.id === `page.${page}`));
    }
    const appSource = readFileSync("../frontend/src/App.tsx", "utf8");
    const frontendRoutes = [...appSource.matchAll(/<Route path="([^"]+)"/g)].map((match) => match[1]).filter((path) => path !== "/login");
    const mirroredRoutes = new Set(EMMA_CAPABILITIES.filter((item) => item.kind === "page").map((item) => item.route));
    assert.equal(EMMA_PAGE_CAPABILITY_COUNT, mirroredRoutes.size);
    for (const route of frontendRoutes) assert.ok(mirroredRoutes.has(route), `missing mirrored page ${route}`);
  });

  it("has one unique policy ID and a policy assignment for every voice intent", () => {
    const ids = EMMA_CAPABILITIES.map((item) => item.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const intent of Object.keys(COMMAND_POLICY) as Array<keyof typeof COMMAND_POLICY>) {
      if (intent === "unrecognized" || intent === "navigate") continue;
      assert.ok(capabilityIdForCommand(intent), `missing command policy for ${intent}`);
    }
  });

  it("maps every structured Emma operation to an exact administrator action right", () => {
    const actionNames = new Set(EMMA_ACTION_CONTRACTS.map((item) => item.actionName));
    for (const [action, definition] of Object.entries(EMMA_EXECUTABLE_ACTIONS)) {
      assert.ok(actionNames.has(definition.capabilityAction), `${action} maps to missing action contract ${definition.capabilityAction}`);
      assert.equal(capabilityIdForCommand({ intent: "execute_action", entities: { action: action as keyof typeof EMMA_EXECUTABLE_ACTIONS, parameters: {} } }), `action.${definition.capabilityAction}`);
    }
  });

  it("enforces exact connector action rights for setup and synchronisation", () => {
    assert.deepEqual(capabilityIdsForCommand({ intent: "setup_connectors", entities: { connector_key: "all" } }), ["action.register_connector_source"]);
    assert.deepEqual(capabilityIdsForCommand({ intent: "sync_connectors", entities: { connector_key: "gmail" } }), ["action.sync_gmail_messages"]);
    assert.deepEqual(capabilityIdsForCommand({ intent: "sync_connectors", entities: { connector_key: "all" } }), [
      "action.sync_gmail_messages", "action.sync_google_contacts", "action.sync_google_calendar",
    ]);
  });

  it("requires both review and underlying mutation rights when confirming", () => {
    assert.deepEqual(capabilityIdsForCommand({ intent: "confirm_gmail_message", entities: {} }), [
      "action.confirm_voice_gmail_message", "action.send_gmail_message",
    ]);
    assert.deepEqual(capabilityIdsForCommand({ intent: "confirm_delete_notifications", entities: {} }), [
      "action.confirm_voice_notification_deletion", "action.delete_all_notifications",
    ]);
  });

  it("classifies every action contract as voice, interactive, system or superseded", () => {
    const covered = new Set<string>([
      ...Object.values(COMMAND_POLICY).map((policy) => "actionName" in policy ? policy.actionName : undefined).filter((name): name is string => Boolean(name)),
      ...Object.values(EMMA_EXECUTABLE_ACTIONS).map((definition) => definition.capabilityAction),
      ...EMMA_DYNAMIC_COMMAND_ACTIONS,
      ...Object.keys(EMMA_NON_DIRECT_ACTIONS),
    ]);
    for (const contract of EMMA_ACTION_CONTRACTS) assert.ok(covered.has(contract.actionName), `unclassified action ${contract.actionName}`);
  });
});
