/**
 * The versioned tool catalogue: what an agent may ask for, written down once.
 *
 * Second step of the agent plan (docs/AGENT_MASTERPLAN_2026-10-08.md, F0.2,
 * layer B). The catalogue is generated from what already governs the product —
 * the executable-action allowlist, its Zod schemas, the Action Contracts and
 * the administrator's capability switches — so a tool can never promise more
 * than the deterministic core enforces. Nothing reads this file in production
 * yet: the agent runtime (F1) will hand these tools to the model, and the
 * Execution Engine will remain the only thing that runs them.
 *
 * The catalogue is versioned by content: its canonical JSON is fingerprinted,
 * and a test refuses a change that does not also bump the version. An agent
 * run will record the catalogue version it saw, so an audited proposal can be
 * read back later against the exact tool set that produced it.
 */

import { createHash } from "node:crypto";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  EMMA_EXECUTABLE_ACTIONS,
  EMMA_EXECUTABLE_ACTION_PAGES,
  type EmmaExecutableActionName,
} from "../lib/emmaExecutableActionCatalogue.js";
import { isVoiceActionName, voiceActionSchemas } from "../lib/voiceActionCatalogue.js";
import { EMMA_CAPABILITIES, type EmmaCapability } from "../lib/emmaSurfaceCatalogue.js";

/**
 * The version ledger: every catalogue version ever shipped, paired with the
 * fingerprint of exactly the document it named. Append-only — a change to the
 * catalogue adds a NEW entry (minor for a compatible addition, major for
 * anything a consumer could trip over) and never edits an old one, so no two
 * different catalogues can share a version. Three layers hold that: the test
 * checks the last entry against the computed document and that versions
 * strictly ascend; CI (check-ledger-append-only.mjs) compares this ledger
 * with the one on master and fails when a shipped entry was changed or
 * removed — the one place the previous ledger genuinely exists; and an agent
 * run records the fingerprint itself, so an audited proposal identifies its
 * tool set even against a rewritten history.
 */
export const TOOL_CATALOGUE_FINGERPRINTS = {
  "1.0.0": "b70815b9548f2cbd030e403dc64088ff6005f3a04c0644a6c139ecc0ff8d9afe",
  "1.1.0": "294829b964566c0cdd33e8ae65e2b2e8bd9d218cdf23e4ff2b3c46ce02f1308e",
} as const satisfies Record<string, string>;

const ledger = Object.entries(TOOL_CATALOGUE_FINGERPRINTS);
export const TOOL_CATALOGUE_VERSION = ledger[ledger.length - 1][0];
export const TOOL_CATALOGUE_FINGERPRINT = ledger[ledger.length - 1][1];

export interface AgentTool {
  /** The model-facing name — exactly the executable action name. */
  name: EmmaExecutableActionName;
  /** The contract's purpose: what the tool does, in the words the audit uses. */
  description: string;
  /**
   * How the agent loop treats the tool: "read" runs immediately under the
   * calling user's permissions; everything else ("write", "external",
   * "administration") may only be collected into a proposal for a yes.
   * The mode comes from the administrator-facing capability catalogue, so the
   * agent's idea of "read" can never be wider than the admin's.
   */
  kind: EmmaCapability["mode"];
  riskLevel: number;
  requiredPermission: string;
  /** The administrator's per-company switch that can turn this tool off. */
  capabilityId: string;
  /** "service_preview" tools always come back as a preview needing a yes. */
  confirmation: "none" | "service_preview";
  /** The page whose data the tool touches, for the Control Tower. */
  page: string;
  /**
   * JSON Schema for the parameters. Actions without a catalogue Zod schema are
   * validated by their owning service; their schema is an open object and
   * parametersValidatedBy says so.
   */
  parameters: Record<string, unknown>;
  parametersValidatedBy: "schema" | "service";
}

const capabilitiesById = new Map(EMMA_CAPABILITIES.map((capability) => [capability.id, capability]));

function parametersFor(name: EmmaExecutableActionName): Pick<AgentTool, "parameters" | "parametersValidatedBy"> {
  if (isVoiceActionName(name)) {
    const schema = zodToJsonSchema(voiceActionSchemas[name], { $refStrategy: "none" }) as Record<string, unknown>;
    delete schema.$schema;
    return { parameters: schema, parametersValidatedBy: "schema" };
  }
  return {
    parameters: { type: "object", description: `Fields: ${EMMA_EXECUTABLE_ACTIONS[name].fields || "(none)"}` },
    parametersValidatedBy: "service",
  };
}

function toolFor(name: EmmaExecutableActionName): AgentTool {
  const definition = EMMA_EXECUTABLE_ACTIONS[name];
  const capabilityId = `action.${definition.capabilityAction}`;
  const capability = capabilitiesById.get(capabilityId);
  if (!capability || capability.riskLevel === undefined || !capability.requiredPermission) {
    // Every executable action must resolve to a governed contract. Failing at
    // module load is deliberate: a tool without a risk level and a permission
    // must never reach a model.
    throw new Error(`Executable action "${name}" has no governed capability "${capabilityId}".`);
  }
  return {
    name,
    description: capability.description,
    kind: capability.mode,
    riskLevel: capability.riskLevel,
    requiredPermission: capability.requiredPermission,
    capabilityId,
    confirmation: definition.confirmation,
    page: EMMA_EXECUTABLE_ACTION_PAGES[name],
    ...parametersFor(name),
  };
}

// Frozen deeply: the catalogue is shared, and a consumer sorting an array in
// place would silently change the fingerprint of what every agent run records.
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export const AGENT_TOOL_CATALOGUE: readonly AgentTool[] = deepFreeze(
  (Object.keys(EMMA_EXECUTABLE_ACTIONS) as EmmaExecutableActionName[])
    .sort((left, right) => left.localeCompare(right))
    .map(toolFor)
);

/** The catalogue as one canonical JSON document: what an AgentRun records. */
export function toolCatalogueDocument(): string {
  return JSON.stringify({ version: TOOL_CATALOGUE_VERSION, tools: AGENT_TOOL_CATALOGUE }, null, 2);
}

export function toolCatalogueFingerprint(): string {
  return createHash("sha256").update(toolCatalogueDocument()).digest("hex");
}

