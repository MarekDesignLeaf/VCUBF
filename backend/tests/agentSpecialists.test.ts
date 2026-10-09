import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AGENT_NEVER_PROPOSES, AGENT_PROPOSABLE_COMMANDS, describeCommandStep, toolsFor } from "../src/agents/agentProposal.js";
import { AGENT_FUNCTION_TOOLS } from "../src/agents/shadowAgent.js";
import { scopeOf, SPECIALIST_IDS, SPECIALISTS } from "../src/agents/specialists.js";
import { AGENT_TOOL_CATALOGUE } from "../src/agents/toolCatalogue.js";
import { CANONICAL_COMMAND_FORMS } from "../src/lib/canonicalCommands.js";
import { CANONICAL_COMMAND, parseTextCommand } from "../src/lib/commandParser.js";
import { COMMAND_POLICY } from "../src/lib/emmaSurfaceCatalogue.js";

// The specialists (masterplan F3): a role is an instruction and a tool subset,
// and the subset is real — every tool exists, every command form is one the
// parser knows, and nothing a role carries could not be proposed anyway.

const canonicalLines = new Set(CANONICAL_COMMAND_FORMS.split("\n").map((line) => line.trim()));
const catalogue = new Map(AGENT_TOOL_CATALOGUE.map((tool) => [tool.name as string, tool]));

describe("specialists (F3)", () => {
  it("each role's tools exist and none is a tool the agent never proposes", () => {
    for (const id of SPECIALIST_IDS) {
      for (const tool of SPECIALISTS[id].tools) {
        assert.ok(catalogue.has(tool), `${id}: ${tool} is not a catalogue tool`);
        assert.ok(!AGENT_NEVER_PROPOSES.has(tool), `${id}: ${tool} is never proposed`);
        assert.notEqual(catalogue.get(tool)!.kind, "administration", `${id}: ${tool}`);
      }
    }
  });

  it("each role's commands are reads or proposable changes, written in forms the parser lists", () => {
    for (const id of SPECIALIST_IDS) {
      const role = SPECIALISTS[id];
      for (const intent of role.intents) {
        assert.ok(COMMAND_POLICY[intent].mode === "read" || AGENT_PROPOSABLE_COMMANDS.has(intent), `${id}: ${intent} can be neither read nor proposed`);
      }
      for (const form of role.forms) assert.ok(canonicalLines.has(form), `${id}: "${form}" is not a canonical form`);
      const covered = new Set(role.examples.map((example) => parseTextCommand(example, CANONICAL_COMMAND).intent));
      for (const example of role.examples) {
        const intent = parseTextCommand(example, CANONICAL_COMMAND).intent;
        assert.ok(role.intents.includes(intent), `${id}: "${example}" reads as ${intent}, which the role does not carry`);
      }
      for (const intent of role.intents) assert.ok(covered.has(intent), `${id}: no example shows ${intent}`);
    }
  });

  it("a scope shows the model only its roles' tools and command forms; no scope shows everything", () => {
    assert.equal(toolsFor(undefined), AGENT_FUNCTION_TOOLS);
    const scope = scopeOf(["communication", "crm"]);
    const shown = toolsFor(scope);
    assert.equal(shown[0].name, "run_command");
    assert.deepEqual(new Set(shown.slice(1).map((tool) => tool.name)), new Set([...SPECIALISTS.communication.tools, ...SPECIALISTS.crm.tools]));
    assert.match(shown[0].description, /show whatsapp messages/);
    assert.match(shown[0].description, /create client NAME/);
    assert.doesNotMatch(shown[0].description, /show calendar|create job|set language|delete all notifications/);
    assert.deepEqual(scopeOf(["scheduling", "communication"]).specialists, ["communication", "scheduling"], "roles keep one order");
  });

  it("the CRM role's lead form keeps e-mail and phone out of the service", () => {
    assert.deepEqual(parseTextCommand(SPECIALISTS.crm.examples[1], CANONICAL_COMMAND), {
      intent: "create_lead",
      entities: { name: "Jan Novy", service_requested: "hedge trimming", email: "jan@example.com", phone: "07700 900123" },
    });
    assert.deepEqual(parseTextCommand("create lead Jan Novy for telephone repair", CANONICAL_COMMAND).entities, { name: "Jan Novy", service_requested: "telephone repair", email: undefined, phone: undefined });
  });

  it("reads a proposed command out in the user's language, with the values the parser read", () => {
    assert.equal(describeCommandStep("create job Hedge trim for Petra Novak", "cs-CZ"), "Nová zakázka „Hedge trim“ pro klienta Petra Novak");
    assert.equal(describeCommandStep("create task Prepare materials, assigned to Daniel, due 2026-10-12", "en-GB"), "New task “Prepare materials” for Daniel, due 2026-10-12");
    assert.equal(describeCommandStep("create client Jan Novy, email jan@example.com, phone 07700 900123", "pl-PL"), "Nowy klient Jan Novy, e-mail jan@example.com, telefon 07700 900123");
    assert.equal(describeCommandStep("set job Hedge trim as dokonceno", "cs-CZ"), "Zakázka „Hedge trim“ do stavu „dokonceno“");
    // Who contacted whom is part of the record, so it is said.
    assert.equal(describeCommandStep("log email from Petra Novak: asked for a quote", "cs-CZ"), "Záznam: e-mail od klienta Petra Novak: „asked for a quote“");
    assert.equal(describeCommandStep("log call with Petra Novak: agreed Friday", "en-GB"), "Record of a call to client Petra Novak: “agreed Friday”");
    // A command without its own wording is read out exactly as it will run.
    assert.equal(describeCommandStep("log photo hedge.jpg: finished hedge", "cs-CZ"), "příkaz „log photo hedge.jpg: finished hedge“");
  });
});
