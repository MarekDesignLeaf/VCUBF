import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AGENT_TOOL_CATALOGUE,
  TOOL_CATALOGUE_FINGERPRINT,
  TOOL_CATALOGUE_VERSION,
  toolCatalogueFingerprint,
} from "../src/agents/toolCatalogue.js";
import { EMMA_EXECUTABLE_ACTIONS, EMMA_NON_DIRECT_ACTIONS } from "../src/lib/emmaExecutableActionCatalogue.js";
import { EMMA_CAPABILITIES } from "../src/lib/emmaSurfaceCatalogue.js";
import { voiceActionSchemas } from "../src/lib/voiceActionCatalogue.js";
import { TASK_STATUSES } from "../src/lib/actionContracts.js";

describe("agent tool catalogue (parity with the deterministic core)", () => {
  it("covers every executable action exactly once, and nothing else", () => {
    const actions = Object.keys(EMMA_EXECUTABLE_ACTIONS).sort();
    const tools = AGENT_TOOL_CATALOGUE.map((tool) => tool.name);
    assert.deepEqual([...tools].sort(), actions);
    assert.equal(new Set(tools).size, tools.length);
  });

  it("gives every tool a governed risk, permission, capability switch and page", () => {
    const capabilityIds = new Set(EMMA_CAPABILITIES.map((capability) => capability.id));
    for (const tool of AGENT_TOOL_CATALOGUE) {
      assert.ok(Number.isInteger(tool.riskLevel) && tool.riskLevel >= 0 && tool.riskLevel <= 4, `${tool.name}: risk ${tool.riskLevel}`);
      assert.ok(tool.requiredPermission.length > 0, `${tool.name}: permission`);
      assert.ok(capabilityIds.has(tool.capabilityId), `${tool.name}: capability ${tool.capabilityId}`);
      assert.ok(tool.page.length > 0, `${tool.name}: page`);
      assert.ok(tool.description.length > 0, `${tool.name}: description`);
    }
  });

  it("marks as read only genuine queries; sending, writing and admin stay proposals", () => {
    const reads = [...AGENT_TOOL_CATALOGUE.filter((tool) => tool.kind === "read").map((tool) => tool.name)];
    // The agent loop will execute "read" immediately and collect everything
    // else into a proposal, so this list widening is a safety-relevant change.
    assert.deepEqual(reads.sort(), [
      "check_capacity",
      "export_invoice_pdf",
      "export_quote_pdf",
      "find_photos_for_service",
      "get_metrics",
      "get_recruitment_recommendation",
      "get_unpaid_invoices",
      "list_reference_activities",
      "suggest_schedule",
    ]);
    const byName = new Map(AGENT_TOOL_CATALOGUE.map((tool) => [tool.name, tool]));
    assert.equal(byName.get("send_email")?.kind, "external");
    assert.equal(byName.get("send_email")?.confirmation, "service_preview");
    assert.equal(byName.get("merge_clients")?.confirmation, "service_preview");
    assert.equal(byName.get("update_emma_permissions")?.kind, "administration");
  });

  it("carries the catalogue Zod schemas as strict JSON Schemas", () => {
    const schemaCount = AGENT_TOOL_CATALOGUE.filter((tool) => tool.parametersValidatedBy === "schema").length;
    const expected = Object.keys(voiceActionSchemas).filter((name) => name in EMMA_EXECUTABLE_ACTIONS).length;
    assert.equal(schemaCount, expected);

    const setTaskStatus = AGENT_TOOL_CATALOGUE.find((tool) => tool.name === "set_task_status")!;
    assert.equal(setTaskStatus.parametersValidatedBy, "schema");
    const parameters = setTaskStatus.parameters as {
      type?: string;
      additionalProperties?: boolean;
      required?: string[];
      properties?: Record<string, { enum?: string[] }>;
    };
    assert.equal(parameters.type, "object");
    assert.equal(parameters.additionalProperties, false);
    assert.deepEqual([...(parameters.required ?? [])].sort(), ["task_status", "task_title"]);
    // The enum in the tool is exactly the enum the service enforces.
    assert.deepEqual(parameters.properties?.task_status?.enum, [...TASK_STATUSES]);

    const mergeClients = AGENT_TOOL_CATALOGUE.find((tool) => tool.name === "merge_clients")!;
    assert.deepEqual([...((mergeClients.parameters as { required?: string[] }).required ?? [])].sort(), [
      "duplicate_client_name",
      "primary_client_name",
    ]);

    // An action without a catalogue schema says plainly who validates it.
    const sendEmail = AGENT_TOOL_CATALOGUE.find((tool) => tool.name === "send_email")!;
    assert.equal(sendEmail.parametersValidatedBy, "service");
  });

  it("accounts for every action capability: a tool, a parser intent, or a written exception", () => {
    const reachable = new Set(AGENT_TOOL_CATALOGUE.map((tool) => tool.capabilityId));
    const unaccounted = EMMA_CAPABILITIES.filter((capability) => {
      if (capability.kind !== "action") return false;
      if (reachable.has(capability.id)) return false;
      if ((capability.intents?.length ?? 0) > 0) return false;
      if ((capability.voiceActions?.length ?? 0) > 0) return false;
      // A deliberate exception must say why it is one; the dynamic commands
      // (register_connector_source, delete_all_notifications) carry their note
      // while keeping executionClass "voice".
      return !capability.executionNote;
    });
    assert.deepEqual(unaccounted.map((capability) => capability.id), []);
    // The written exceptions stay the catalogue's, not this test's, to maintain.
    for (const [name, exception] of Object.entries(EMMA_NON_DIRECT_ACTIONS)) {
      assert.ok(exception.note.length > 0, `${name}: exception without a reason`);
    }
  });

  it("cannot change without a conscious version bump", () => {
    assert.match(TOOL_CATALOGUE_VERSION, /^\d+\.\d+\.\d+$/);
    assert.equal(
      toolCatalogueFingerprint(),
      TOOL_CATALOGUE_FINGERPRINT,
      "The tool catalogue changed. Review the change, bump TOOL_CATALOGUE_VERSION, and set TOOL_CATALOGUE_FINGERPRINT to the new value from toolCatalogueFingerprint() — in the same commit."
    );
  });
});
