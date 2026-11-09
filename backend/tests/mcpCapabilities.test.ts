import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import request from "supertest";
import { createServer } from "../src/server.js";
import { prisma } from "../src/db.js";
import { AGENT_TOOL_CATALOGUE, TOOL_CATALOGUE_VERSION } from "../src/agents/toolCatalogue.js";
import { EMMA_EXECUTABLE_ACTIONS } from "../src/lib/emmaExecutableActionCatalogue.js";
import { EMMA_CAPABILITIES } from "../src/lib/emmaSurfaceCatalogue.js";
import { MCP_READ_SCOPE, MCP_WRITE_SCOPE } from "../src/modules/mcp/oauth.js";
import { capabilityProblems, REQUIRED_TEXT_FIELDS } from "../src/modules/mcp/capabilities.js";
import {
  describeCapabilities,
  MCP_DESCRIBE_TOOL,
  MCP_DEVICE_READ_TOOL_NAMES,
  MCP_GATEWAY_READ_TOOL_NAMES,
  MCP_READ_COMMAND_TOOL,
  MCP_READ_POLICY,
  MCP_TOOLSET_FINGERPRINTS,
  MCP_TOOLSET_REVISION,
  MCP_WRITE_POLICY,
  mcpCatalogue,
  mcpToolRunner,
  mcpToolsetFingerprint,
} from "../src/modules/mcp/routes.js";
import { MCP_CANCEL_TOOL, MCP_CONFIRM_TOOL, MCP_WRITE_TOOLS } from "../src/modules/mcp/writeTools.js";
import type { AuthedUser } from "../src/middleware/auth.js";
import { resetDb, seedCompanyAndAdmin } from "./setup.js";

// Owner requirement (3 Nov 2026): every MCP tool carries machine-readable
// capability metadata generated from its own definition. These tests make a
// tool without it, a description of a tool that does not exist, or a changed
// tool set under an old revision fail CI.

const app = createServer();
const BASE = "https://secretary.test";
const RESOURCE = `${BASE}/mcp`;
const REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect";
const BOTH = `${MCP_READ_SCOPE} ${MCP_WRITE_SCOPE}`;
const ENV_KEYS = ["MCP_GATEWAY_ENABLED", "MCP_WRITE_ENABLED", "MCP_PUBLIC_URL"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((name) => [name, process.env[name]]));

type Json = Record<string, any>;

/** Every tool name the gateway's definitions contain, collected independently of the catalogue. */
function definedToolNames(): string[] {
  const catalogueReads = AGENT_TOOL_CATALOGUE.filter((tool) => tool.kind === "read" && EMMA_EXECUTABLE_ACTIONS[tool.name].confirmation === "none");
  return [
    MCP_DESCRIBE_TOOL,
    MCP_READ_COMMAND_TOOL,
    ...catalogueReads.map((tool) => tool.name),
    ...MCP_GATEWAY_READ_TOOL_NAMES,
    ...MCP_DEVICE_READ_TOOL_NAMES,
    ...MCP_WRITE_TOOLS.map((tool) => tool.name),
    MCP_CONFIRM_TOOL,
    MCP_CANCEL_TOOL,
  ];
}

const WHATSAPP_REVIEW = ["approve_whatsapp_sender", "reject_whatsapp_sender", "reopen_whatsapp_sender", "defer_whatsapp_sender"];

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

describe("MCP capability metadata", () => {
  const owner = { id: "owner", companyId: "c", permissions: ["crm.read", "crm.manage"], mustChangePassword: false } as unknown as AuthedUser;
  const writeApproved = { writeEnabled: true, writeScope: true };

  // ------------------------------------------------------------------------
  // The catalogue against the definitions: no drift in either direction.

  it("describes exactly the tools the gateway defines, each one runnable, none twice", () => {
    const described = mcpCatalogue(owner, writeApproved).map((entry) => entry.capability.name);
    const defined = definedToolNames();
    assert.equal(new Set(described).size, described.length, "a tool is described twice");
    assert.deepEqual([...described].sort(), [...defined].sort(), "the catalogue and the tool definitions differ");
    for (const name of described) assert.ok(mcpToolRunner(name), `${name} is described but no runner serves it`);
    for (const name of ["send_invoice", "delete_client", "record_payment", "describe"]) {
      assert.equal(mcpToolRunner(name), null, `${name} must not be a tool`);
      assert.ok(!described.includes(name), name);
    }
  });

  it("fills every required field of every tool, on every kind of connection", () => {
    const worker = { ...owner, permissions: [] } as unknown as AuthedUser;
    for (const user of [owner, worker, undefined]) {
      for (const access of [writeApproved, { writeEnabled: true, writeScope: false }, { writeEnabled: false, writeScope: true }, { writeEnabled: false, writeScope: false }]) {
        const catalogue = mcpCatalogue(user, access);
        assert.deepEqual(capabilityProblems(catalogue), [], JSON.stringify(access));
        for (const { capability, availability, listing } of catalogue) {
          for (const field of REQUIRED_TEXT_FIELDS) assert.ok(String(capability[field]).trim(), `${capability.name}.${field}`);
          assert.equal(listing.name, capability.name);
          assert.equal(typeof availability.listed, "boolean");
          if (availability.reason !== "available") assert.ok(availability.howToEnable, `${capability.name}: ${availability.reason} without help`);
          // The annotations clients see agree with the metadata.
          assert.equal(listing.annotations.readOnlyHint, capability.readOnly, capability.name);
          if (capability.access === "write" && capability.riskClass !== "confirmation") assert.equal(listing.annotations.destructiveHint, capability.destructive, capability.name);
          // The argument names come from the very schema tools/list shows.
          assert.deepEqual(capability.inputFields, Object.keys((listing.inputSchema.properties ?? {}) as object), capability.name);
        }
      }
    }
  });

  it("records the current toolset under its own revision: a changed tool needs a new revision", () => {
    const ledger = Object.entries(MCP_TOOLSET_FINGERPRINTS);
    assert.equal(ledger[ledger.length - 1][0], MCP_TOOLSET_REVISION);
    assert.equal(
      mcpToolsetFingerprint(),
      MCP_TOOLSET_FINGERPRINTS[MCP_TOOLSET_REVISION as keyof typeof MCP_TOOLSET_FINGERPRINTS],
      "The MCP tool set or its metadata changed. Append a new revision with the new fingerprint to MCP_TOOLSET_FINGERPRINTS (backend/src/modules/mcp/routes.ts) and update docs/MCP_CAPABILITY_METADATA.md.",
    );
    assert.equal(new Set(ledger.map(([revision]) => revision)).size, ledger.length);
    for (const [, fingerprint] of ledger) assert.match(fingerprint, /^[0-9a-f]{64}$/);
  });

  it("reports only administrator switches that exist and the policy page can turn off", () => {
    for (const { capability } of mcpCatalogue(owner, writeApproved)) {
      if (capability.capabilitySwitch === null || capability.capabilitySwitch === "per_command") continue;
      const governed = EMMA_CAPABILITIES.find((entry) => entry.id === capability.capabilitySwitch);
      assert.ok(governed, `${capability.name}: ${capability.capabilitySwitch} does not exist`);
      assert.notEqual(governed.availableToEmma, false, `${capability.name}: ${capability.capabilitySwitch} cannot be switched off`);
      if (capability.requiredPermission !== "per_command") assert.equal(governed.requiredPermission, capability.requiredPermission, capability.name);
    }
  });

  it("names in the hand-written policy text only tools and arguments that exist", () => {
    const catalogue = mcpCatalogue(owner, writeApproved);
    const known = new Set<string>();
    for (const { capability } of catalogue) {
      known.add(capability.name);
      for (const field of capability.inputFields) known.add(field);
    }
    known.add("confirm_display_name_required");
    known.add("confirmation_id");
    for (const text of [MCP_READ_POLICY, MCP_WRITE_POLICY]) {
      for (const [token] of text.matchAll(/\b[a-z]+(?:_[a-z]+)+\b/g)) assert.ok(known.has(token), `policy names "${token}", which is no tool or argument`);
    }
  });

  it("classifies create_task, the WhatsApp sender review and permanent contact deletion truthfully", () => {
    const byName = new Map(mcpCatalogue(owner, writeApproved).map((entry) => [entry.capability.name, entry.capability]));
    const task = byName.get("create_task")!;
    assert.equal(task.access, "write");
    assert.equal(task.oauthScope, MCP_WRITE_SCOPE);
    assert.equal(task.requiredPermission, "crm.manage");
    assert.equal(task.capabilitySwitch, "action.create_task");
    assert.equal(task.confirmation, "none");
    assert.equal(task.idempotency, "idempotency_key_required");
    assert.equal(task.riskClass, "routine_write");
    assert.ok(task.requiredInputs.includes("idempotency_key") && task.inputFields.includes("task"));

    for (const name of ["list_whatsapp_senders", "get_whatsapp_sender"]) {
      const read = byName.get(name)!;
      assert.equal(read.access, "read");
      assert.equal(read.oauthScope, MCP_READ_SCOPE);
      assert.equal(read.requiredPermission, "crm.read");
      assert.ok(read.capabilitySwitch, name);
    }
    for (const name of [...WHATSAPP_REVIEW, "delete_contact_permanently"]) {
      // Not switchable on the assistant policy page, and said so.
      assert.equal(byName.get(name)!.capabilitySwitch, null, name);
      assert.ok(byName.get(name)!.limitations.some((line) => line.startsWith("No separate administrator switch")), name);
    }
    for (const name of WHATSAPP_REVIEW) {
      const tool = byName.get(name)!;
      assert.equal(tool.access, "write", name);
      assert.equal(tool.riskClass, "classification", name);
      assert.equal(tool.confirmation, "preview_then_confirm", name);
      assert.equal(tool.actionContract, "review_whatsapp_sender", name);
      assert.equal(tool.requiredPermission, "crm.manage", name);
      assert.match(tool.sideEffects, /nothing is (sent|added)/i, name);
    }
    const deletion = byName.get("delete_contact_permanently")!;
    assert.equal(deletion.riskClass, "permanent");
    assert.equal(deletion.permanent, true);
    assert.equal(deletion.irreversible, true);
    assert.equal(deletion.destructive, true);
    assert.equal(deletion.confirmation, "preview_confirm_and_typed_name");
    assert.ok(deletion.limitations.some((line) => line.includes("confirm_display_name")));
    assert.equal(byName.get("change_invoice_status")!.financial, true);
    assert.equal(byName.get("convert_lead")!.irreversible, true);
    assert.equal(byName.get("archive_contact")!.destructive, true);
    assert.equal(byName.get(MCP_CONFIRM_TOOL)!.confirmation, "confirms_preview");

    const meta = byName.get(MCP_DESCRIBE_TOOL)!;
    assert.equal(meta.access, "metadata");
    assert.equal(meta.readsCompanyRecords, false);
    assert.equal(meta.audit, "none");
  });

  // ------------------------------------------------------------------------
  // Over the wire, with real OAuth connections.

  describe("over the gateway", () => {
    let readToken: string;
    let writeToken: string;
    let workerToken: string;

    const register = async () => (await request(app).post("/oauth/register").send({ client_name: "ChatGPT", redirect_uris: [REDIRECT] })).body.client_id as string;
    async function connect(clientId: string, email: string, decision: "approve" | "approve_write") {
      const { verifier, challenge } = pkce();
      const consent = await request(app).post("/oauth/authorize").type("form").send({
        client_id: clientId, redirect_uri: REDIRECT, response_type: "code", code_challenge: challenge, code_challenge_method: "S256",
        state: "s", scope: BOTH, resource: RESOURCE, email, password: "Password123!", decision,
        ...(decision === "approve_write" ? { allow_write: "yes" } : {}),
      });
      assert.equal(consent.status, 302, consent.text);
      const code = new URL(consent.headers.location).searchParams.get("code")!;
      const token = await request(app).post("/oauth/token").type("form")
        .send({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier, resource: RESOURCE });
      assert.equal(token.status, 200, JSON.stringify(token.body));
      return token.body.access_token as string;
    }
    const rpc = (token: string, body: Json) => request(app).post("/mcp").set("Authorization", `Bearer ${token}`).send(body);
    const list = async (token: string) => ((await rpc(token, { jsonrpc: "2.0", id: 1, method: "tools/list" })).body.result.tools as Json[]);
    const describeCall = async (token: string, args: Json = {}) => {
      const res = await rpc(token, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: MCP_DESCRIBE_TOOL, arguments: args } });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      return { isError: res.body.result.isError as boolean, body: JSON.parse(res.body.result.content[0].text) as Json };
    };
    const initialize = async (token: string) =>
      (await rpc(token, { jsonrpc: "2.0", id: 3, method: "initialize", params: { protocolVersion: "2025-06-18" } })).body.result as Json;

    before(async () => {
      await resetDb();
      await seedCompanyAndAdmin();
      process.env.MCP_GATEWAY_ENABLED = "true";
      process.env.MCP_WRITE_ENABLED = "true";
      process.env.MCP_PUBLIC_URL = BASE;
      readToken = await connect(await register(), "admin@test.local", "approve");
      writeToken = await connect(await register(), "admin@test.local", "approve_write");
      workerToken = await connect(await register(), "worker@test.local", "approve_write");
    });

    beforeEach(() => {
      process.env.MCP_GATEWAY_ENABLED = "true";
      process.env.MCP_WRITE_ENABLED = "true";
      process.env.MCP_PUBLIC_URL = BASE;
    });

    after(async () => {
      for (const name of ENV_KEYS) {
        if (saved[name] === undefined) delete process.env[name];
        else process.env[name] = saved[name];
      }
      await prisma.$disconnect();
    });

    it("tells a read-only connection every tool, and that write tools need a reconnect with write approval", async () => {
      const listed = (await list(readToken)).map((tool) => tool.name as string);
      assert.ok(listed.includes(MCP_DESCRIBE_TOOL), "the metadata tool is always visible");
      assert.ok(!listed.includes("create_task"));

      const { isError, body } = await describeCall(readToken);
      assert.equal(isError, false);
      assert.equal(body.toolsetRevision, MCP_TOOLSET_REVISION);
      assert.equal(body.server.version, `${TOOL_CATALOGUE_VERSION}+${MCP_TOOLSET_REVISION}`);
      assert.deepEqual(body.connection, { writeEnabledOnServer: true, writeApproved: false, canWrite: false, passwordChangeRequired: false });
      const tools = body.tools as Json[];
      assert.deepEqual(tools.map((tool) => tool.name).sort(), definedToolNames().sort(), "unavailable tools are described too");
      assert.deepEqual(tools.filter((tool) => tool.availability.listed).map((tool) => tool.name).sort(), [...listed].sort(), "listed means exactly tools/list");
      for (const name of ["create_task", "delete_contact_permanently", ...WHATSAPP_REVIEW, MCP_CONFIRM_TOOL]) {
        const tool = tools.find((entry) => entry.name === name)!;
        assert.equal(tool.availability.listed, false, name);
        assert.equal(tool.availability.reason, "requires_write_scope", name);
        assert.match(tool.availability.howToEnable, /connect the Secretary connector again/, name);
      }
      assert.equal(body.counts.total, tools.length);
      assert.equal(body.counts.listed, listed.length);

      const init = await initialize(readToken);
      assert.match(init.serverInfo.version, new RegExp(`\\+${MCP_TOOLSET_REVISION.replace(/\./g, "\\.")}$`));
      assert.match(init.instructions, new RegExp(`${listed.length} tools on this connection`));
      assert.match(init.instructions, /requires_write_scope \(\d+\): create_client, .*create_task.*delete_contact_permanently/);
      assert.match(init.instructions, /call describe_capabilities/);
      for (const name of listed) assert.ok(init.instructions.includes(name), `initialize names ${name}`);
    });

    it("tells a write-approved connection every tool by name, matching tools/list exactly", async () => {
      const listedTools = await list(writeToken);
      const listed = listedTools.map((tool) => tool.name as string);
      // Every tool, except the owner's phone and PC, which are not set up in this test:
      // they are described with connector_not_configured (tests/mcpDevices.test.ts sets them up).
      const deviceTools = new Set([...MCP_DEVICE_READ_TOOL_NAMES, ...MCP_WRITE_TOOLS.filter((tool) => tool.available).map((tool) => tool.name)]);
      assert.ok(deviceTools.has("send_phone_sms") && deviceTools.has("pc_browser_act") && deviceTools.has("list_phone_sms"));
      assert.deepEqual([...listed].sort(), definedToolNames().filter((name) => !deviceTools.has(name)).sort(), "a write-approved owner sees every tool");
      for (const name of ["create_task", "list_whatsapp_senders", "get_whatsapp_sender", ...WHATSAPP_REVIEW, "delete_contact_permanently", MCP_CONFIRM_TOOL, MCP_CANCEL_TOOL]) {
        assert.ok(listed.includes(name), name);
      }

      const { body } = await describeCall(writeToken);
      assert.equal(body.connection.canWrite, true);
      assert.equal(body.counts.notListed, deviceTools.size);
      for (const tool of body.tools as Json[]) {
        if (deviceTools.has(tool.name)) {
          assert.equal(tool.availability.reason, "connector_not_configured", tool.name);
          assert.match(tool.availability.howToEnable, /PHONE_PC_INTEGRATION/, tool.name);
          continue;
        }
        assert.equal(tool.availability.reason, "available", tool.name);
        const listing = listedTools.find((entry) => entry.name === tool.name)!;
        assert.ok(listing, tool.name);
        assert.equal(tool.readOnly, listing.annotations.readOnlyHint, tool.name);
      }

      const init = await initialize(writeToken);
      assert.match(init.instructions, new RegExp(`${listed.length} tools on this connection`));
      for (const name of listed) assert.ok(init.instructions.includes(name), `initialize names ${name}`);
      assert.match(init.instructions, /Permanent, after a preview, the user's yes and the exact name typed by the user \(1\): delete_contact_permanently/);
      // Only the devices that are not set up are held back, with their reason.
      assert.doesNotMatch(init.instructions, /Not available on this connection, (requires_write_scope|missing_permission|write_disabled_on_server)/);
      assert.match(init.instructions, /Not available on this connection, connector_not_configured \(\d+\): phone_status/);

      const one = await describeCall(writeToken, { tool: "create_task" });
      assert.deepEqual(one.body.tools.map((tool: Json) => tool.name), ["create_task"]);
      const unknown = await describeCall(writeToken, { tool: "send_everything" });
      assert.equal(unknown.isError, true);
      assert.equal(unknown.body.error, "UNKNOWN_TOOL");
    });

    it("marks write tools the account lacks the permission for, and when the server switch is off", async () => {
      const worker = await describeCall(workerToken);
      const task = (worker.body.tools as Json[]).find((tool) => tool.name === "create_task")!;
      assert.equal(task.availability.listed, false);
      assert.equal(task.availability.reason, "missing_permission");
      assert.ok(!(await list(workerToken)).some((tool) => tool.name === "create_task"));

      process.env.MCP_WRITE_ENABLED = "false";
      const off = await describeCall(writeToken);
      assert.equal(off.body.connection.writeEnabledOnServer, false);
      const deletion = (off.body.tools as Json[]).find((tool) => tool.name === "delete_contact_permanently")!;
      assert.equal(deletion.availability.reason, "write_disabled_on_server");
      assert.ok(!(await list(writeToken)).some((tool) => tool.name === "delete_contact_permanently"));
    });

    it("reads no business record and writes nothing, not even an audit entry", async () => {
      const counts = async () => ({
        audit: await prisma.auditLog.count(),
        clients: await prisma.client.count(),
        contacts: await prisma.contact.count(),
        tasks: await prisma.task.count(),
        reviews: await prisma.voicePendingAction.count(),
        keys: await prisma.idempotencyRecord.count(),
      });
      const before = await counts();
      await describeCall(readToken);
      await describeCall(writeToken);
      await describeCall(writeToken, { tool: "delete_contact_permanently" });
      assert.deepEqual(await counts(), before);

      // Pure: the payload does not depend on the database at all.
      const offline = describeCapabilities(owner, writeApproved, {});
      assert.equal(offline.ok, true);
      assert.ok(JSON.stringify(offline.payload).length > 0);
    });

    it("dispatches every described tool: none answers Unknown tool", async () => {
      for (const name of definedToolNames()) {
        // Arguments no tool accepts: every call stops at validation, before any change.
        const res = await rpc(writeToken, { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name, arguments: { not_an_argument: true } } });
        assert.equal(res.status, 200, `${name}: ${JSON.stringify(res.body)}`);
        assert.ok(!res.body.error, `${name}: ${JSON.stringify(res.body.error)}`);
      }
      const unknown = await rpc(writeToken, { jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "not_a_tool", arguments: {} } });
      assert.equal(unknown.body.error.code, -32602);
      assert.match(unknown.body.error.message, /describe_capabilities/);
    });
  });
});
