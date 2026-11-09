/**
 * MCP gateway, capability metadata (owner requirement, 3 Nov 2026).
 *
 * After a reconnect with reading and writing, ChatGPT reported "39 Secretary
 * functions" and could not name or explain one of them. The rule since then:
 * every tool the gateway can offer carries a machine-readable description of
 * itself, built from the same definition that builds its tools/list entry and
 * runs it, so the description ships and versions with the code and cannot go
 * stale by hand.
 *
 * This module holds only the shape of that description and the pure helpers
 * that turn it into text. It reads nothing and writes nothing: no database, no
 * environment, no request. routes.ts and writeTools.ts fill it from their own
 * tool definitions; tests/mcpCapabilities.test.ts proves that every tool the
 * gateway can list or run has exactly one entry, with every field filled.
 */

/** What the tool does to Secretary. metadata: describes the gateway only. */
export type McpAccess = "metadata" | "read" | "write";

/**
 * How a call reaches its effect.
 * - none: runs at once (reads, and direct writes with an idempotency_key).
 * - preview_then_confirm: returns a preview and a confirmation_id; nothing
 *   changes until confirm_action after the user's explicit yes.
 * - preview_confirm_and_typed_name: as above, and confirm_action must also
 *   carry confirm_display_name, the record's exact name typed by the user.
 * - confirms_preview / withdraws_preview: confirm_action and cancel_action.
 */
export type McpConfirmation =
  | "none"
  | "preview_then_confirm"
  | "preview_confirm_and_typed_name"
  | "confirms_preview"
  | "withdraws_preview";

/** The risk class a client should treat the tool as. */
export type McpRiskClass =
  | "metadata"
  | "read"
  | "routine_write"
  | "destructive"
  | "irreversible"
  | "financial"
  | "classification"
  | "permanent"
  | "confirmation";

export type McpIdempotency = "not_applicable" | "idempotency_key_required" | "once_per_confirmation_id";

/** Everything a client needs to know about one tool, independent of who asks. */
export interface McpCapability {
  name: string;
  title: string;
  /** What the tool is for, in the words its tools/list description uses. */
  purpose: string;
  access: McpAccess;
  readOnly: boolean;
  /** The OAuth scope a connection must have been approved for. */
  oauthScope: string;
  /**
   * The account permission the tool needs: a permission name, "authenticated"
   * (any signed-in user), or "per_command" (run_read_command: the permission of
   * the command it runs).
   */
  requiredPermission: string;
  /**
   * The administrator's per-company switch (an Alfonzo capability id) that can
   * turn this tool off, "per_command", or null when no switch applies.
   */
  capabilitySwitch: string | null;
  /** The Action Contract the tool carries out, when it has one. */
  actionContract: string | null;
  /** The contract's risk level (0–5), when it has one. */
  riskLevel: number | null;
  riskClass: McpRiskClass;
  destructive: boolean;
  irreversible: boolean;
  financial: boolean;
  /** Removes a record for good. */
  permanent: boolean;
  confirmation: McpConfirmation;
  idempotency: McpIdempotency;
  /** False only for the metadata tool: it reads no company records at all. */
  readsCompanyRecords: boolean;
  /** What a successful call changes; "None." for reads. */
  sideEffects: string;
  limitations: string[];
  /** The audit entry the gateway writes for a call, or "none". */
  audit: "mcp_read_tool" | "mcp_write_tool" | "none";
  /** The top-level argument names, as the tools/list inputSchema declares them. */
  inputFields: string[];
  requiredInputs: string[];
}

/** Why a tool is or is not usable on this connection. */
export type McpAvailabilityReason =
  | "available"
  | "missing_permission"
  | "requires_write_scope"
  | "write_disabled_on_server"
  | "no_previewed_tool_available"
  | "connector_not_configured";

export interface McpAvailability {
  /** The tool is in this connection's tools/list. */
  listed: boolean;
  reason: McpAvailabilityReason;
  /** What would make it available, in plain words, when it is not. */
  howToEnable?: string;
}

export interface McpCatalogueEntry {
  capability: McpCapability;
  availability: McpAvailability;
}

export const AVAILABILITY_HELP: Record<Exclude<McpAvailabilityReason, "available">, string> = {
  missing_permission: "The Secretary account behind this connection lacks the required permission; an administrator must grant it.",
  requires_write_scope:
    "This connection was approved for reading only. Disconnect and connect the Secretary connector again, and on the consent page tick the box allowing Secretary to create and change records.",
  write_disabled_on_server: "Writing through this gateway is switched off on the Secretary server (MCP_WRITE_ENABLED). The owner must switch it on.",
  connector_not_configured:
    "The device or system behind this tool (the owner's phone through SMS Bridge, or the owner's PC through PC Control Plus) is not set up for this company on the Secretary server. The owner configures it; see docs/PHONE_PC_INTEGRATION.md.",
  no_previewed_tool_available: "Available only when at least one previewed tool (archive, conversion, invoice status, WhatsApp sender review, permanent deletion) is available to this connection.",
};

export function availability(reason: McpAvailabilityReason, listed: boolean): McpAvailability {
  return reason === "available" ? { listed, reason } : { listed, reason, howToEnable: AVAILABILITY_HELP[reason] };
}

/** The top-level argument names of a JSON Schema object. */
export function schemaFields(schema: Record<string, unknown>): Pick<McpCapability, "inputFields" | "requiredInputs"> {
  const properties = schema.properties && typeof schema.properties === "object" ? Object.keys(schema.properties as object) : [];
  const required = Array.isArray(schema.required) ? (schema.required as unknown[]).map(String) : [];
  return { inputFields: properties, requiredInputs: required };
}

/** Every string field of a capability that must never be empty. */
export const REQUIRED_TEXT_FIELDS = [
  "name", "title", "purpose", "access", "oauthScope", "requiredPermission", "riskClass", "confirmation", "idempotency", "sideEffects", "audit",
] as const satisfies ReadonlyArray<keyof McpCapability>;

/**
 * The capability problems of a catalogue: empty required text, no limitations,
 * a name twice, or flags that contradict each other. Empty means sound.
 */
export function capabilityProblems(entries: readonly McpCatalogueEntry[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const { capability: tool } of entries) {
    if (seen.has(tool.name)) problems.push(`${tool.name}: listed twice`);
    seen.add(tool.name);
    for (const field of REQUIRED_TEXT_FIELDS) {
      const value = tool[field];
      if (typeof value !== "string" || !value.trim()) problems.push(`${tool.name}: ${field} is empty`);
    }
    if (!tool.limitations.length || tool.limitations.some((line) => !line.trim())) problems.push(`${tool.name}: limitations missing`);
    if (tool.readOnly !== (tool.access !== "write")) problems.push(`${tool.name}: readOnly contradicts access`);
    if (tool.access === "write" && tool.audit !== "mcp_write_tool") problems.push(`${tool.name}: a write must be audited as mcp_write_tool`);
    if (tool.access === "read" && tool.audit !== "mcp_read_tool") problems.push(`${tool.name}: a read must be audited as mcp_read_tool`);
    if (tool.access !== "metadata" && !tool.readsCompanyRecords) problems.push(`${tool.name}: only the metadata tool may read no records`);
    if (tool.access === "write" && tool.riskClass === "routine_write" && tool.idempotency !== "idempotency_key_required") {
      problems.push(`${tool.name}: a direct write needs an idempotency_key`);
    }
    if ((tool.destructive || tool.irreversible || tool.permanent) && tool.confirmation === "none") {
      problems.push(`${tool.name}: destructive, irreversible or permanent but not previewed`);
    }
    if (tool.permanent && tool.confirmation !== "preview_confirm_and_typed_name") problems.push(`${tool.name}: permanent deletion needs the typed name`);
  }
  return problems;
}

/**
 * The concise summary for the initialize instructions: exact tool names on
 * this connection, grouped by what they do, the names held back and why, and
 * where the full metadata is. Generated from the catalogue, never by hand.
 */
export function capabilitySummary(entries: readonly McpCatalogueEntry[], toolsetVersion: string, metadataTool: string): string {
  const listed = entries.filter((entry) => entry.availability.listed).map((entry) => entry.capability);
  const names = (filter: (tool: McpCapability) => boolean) => listed.filter(filter).map((tool) => tool.name);
  const groups: Array<[string, string[]]> = [
    ["Metadata (reads no company records)", names((tool) => tool.access === "metadata")],
    ["Read", names((tool) => tool.access === "read")],
    ["Write at once (idempotency_key required)", names((tool) => tool.access === "write" && tool.confirmation === "none")],
    ["Write after a preview and the user's yes", names((tool) => tool.confirmation === "preview_then_confirm")],
    ["Permanent, after a preview, the user's yes and the exact name typed by the user", names((tool) => tool.confirmation === "preview_confirm_and_typed_name")],
    ["Answer a preview", names((tool) => tool.confirmation === "confirms_preview" || tool.confirmation === "withdraws_preview")],
  ];
  const lines = [`Secretary toolset ${toolsetVersion}: ${listed.length} tools on this connection.`];
  for (const [label, group] of groups) if (group.length) lines.push(`${label} (${group.length}): ${group.join(", ")}.`);
  const held = entries.filter((entry) => !entry.availability.listed);
  const byReason = new Map<string, string[]>();
  for (const entry of held) byReason.set(entry.availability.reason, [...(byReason.get(entry.availability.reason) ?? []), entry.capability.name]);
  for (const [reason, group] of byReason) {
    lines.push(`Not available on this connection, ${reason} (${group.length}): ${group.join(", ")}. ${AVAILABILITY_HELP[reason as Exclude<McpAvailabilityReason, "available">]}`);
  }
  lines.push(
    `For the full machine-readable description of every tool (purpose, read or write, OAuth scope, account permission, administrator switch, ` +
    `confirmation, risk, side effects, limitations, and why a tool is unavailable here) call ${metadataTool}. It reads no company records and changes nothing.`,
  );
  return lines.join("\n");
}
