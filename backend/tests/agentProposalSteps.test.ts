import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AGENT_NEVER_PROPOSES,
  AGENT_PROPOSABLE_COMMANDS,
  AGENT_PROPOSAL_REVIEW,
  describeActionStep,
  describeCommandStep,
  executionMessage,
  proposalFingerprint,
  proposalMessage,
  withoutQuestion,
  type ProposalStep,
} from "../src/agents/agentProposal.js";
import { AGENT_TOOL_CATALOGUE } from "../src/agents/toolCatalogue.js";
import { CANONICAL_COMMAND, parseTextCommand } from "../src/lib/commandParser.js";
import { COMMAND_POLICY } from "../src/lib/emmaSurfaceCatalogue.js";
import { commandAllowedInSafeMode } from "../src/lib/safeModeCommands.js";

// The agent's proposal (masterplan F2b) without a database: what it may carry,
// how it is read out, and that a stored proposal is executed only as read out.

const jobStep: ProposalStep = {
  kind: "command",
  command: "create job Hedge trim for Petra Novak",
  intent: "create_job",
  description: describeCommandStep("create job Hedge trim for Petra Novak", "en-GB"),
};
const statusStep: ProposalStep = {
  kind: "action",
  action: "set_task_status",
  parameters: { task_title: "Call Petra", task_status: "completed" },
  reviewed: false,
  description: describeActionStep("set_task_status", { task_title: "Call Petra", task_status: "completed" }, undefined, "en-GB"),
};

function payload(steps: ProposalStep[]) {
  return { version: 1 as const, fingerprint: proposalFingerprint(steps), steps };
}

describe("agent proposal steps (F2b)", () => {
  it("never proposes administration or connector governance (§48)", () => {
    for (const tool of AGENT_TOOL_CATALOGUE) {
      if (tool.kind === "administration") assert.ok(AGENT_NEVER_PROPOSES.has(tool.name), `${tool.name} must never be proposed`);
      if (/^(?:start_.*_oauth|disconnect_.*|enable_connector_source|disable_connector_source|update_connector_source|set_default_email_account)$/.test(tool.name)) {
        assert.ok(AGENT_NEVER_PROPOSES.has(tool.name), `${tool.name} governs a connector and must never be proposed`);
      }
    }
    for (const name of AGENT_NEVER_PROPOSES) {
      assert.ok(AGENT_TOOL_CATALOGUE.some((tool) => tool.name === name), `${name} is not a catalogue tool`);
    }
  });

  it("carries only commands that change something at once, never a command with its own review or a language change", () => {
    for (const intent of AGENT_PROPOSABLE_COMMANDS) {
      assert.equal(COMMAND_POLICY[intent].mode, "write", `${intent} is not a plain write`);
      assert.ok(!intent.startsWith("prepare_") && !intent.startsWith("confirm_") && !intent.startsWith("cancel_"), intent);
    }
    for (const intent of ["set_voice_language", "prepare_gmail_message", "prepare_whatsapp_message", "prepare_archive_client", "create_assistant_memory", "create_learning_rule", "setup_connectors", "sync_connectors"] as const) {
      assert.ok(!AGENT_PROPOSABLE_COMMANDS.has(intent), `${intent} must not be proposable`);
    }
  });

  it("the yes and the no to a proposal cannot be written as a command, and only the no works during an emergency stop", () => {
    for (const text of ["confirm agent proposal", "cancel agent proposal", "confirm_agent_proposal"]) {
      const parsed = parseTextCommand(text, CANONICAL_COMMAND).intent;
      assert.ok(parsed !== "confirm_agent_proposal" && parsed !== "cancel_agent_proposal", text);
    }
    assert.equal(commandAllowedInSafeMode({ intent: "cancel_agent_proposal", entities: {} }), true);
    assert.equal(commandAllowedInSafeMode({ intent: "confirm_agent_proposal", entities: {} }), false);
  });

  it("reads the whole proposal out and asks once, in the user's language", () => {
    const english = proposalMessage([jobStep, statusStep], [], "en-GB");
    assert.equal(
      english,
      "I propose 2 steps: 1. command “create job Hedge trim for Petra Novak”. 2. set task status: task title “Call Petra”, task status “completed”. Shall I carry out all of them?",
    );
    const czech = proposalMessage([jobStep], ["disconnect gmail"], "cs-CZ");
    assert.match(czech, /^Navrhuji tento krok: 1\. /);
    assert.match(czech, /Do návrhu jsem nezařadil: disconnect gmail\. To musíte udělat sami\. Mám ho provést\?$/);
    assert.match(proposalMessage([jobStep, statusStep, jobStep], [], "cs-CZ"), /^Navrhuji 3 kroky:/);
    assert.match(proposalMessage([jobStep, statusStep, jobStep, statusStep, jobStep], [], "pl-PL"), /^Proponuję 5 kroków:.*Czy mam wykonać je wszystkie\?$/);
  });

  it("a service's own review becomes the step, without its question", () => {
    assert.equal(withoutQuestion("I will move “Hedge trim”. Now: Monday. New time: Tuesday. Shall I move it?"), "I will move “Hedge trim”. Now: Monday. New time: Tuesday.");
    assert.equal(withoutQuestion("Pošlu e-mail na petra@example.com. Text: „Dobrý den?“. Mám ho odeslat?"), "Pošlu e-mail na petra@example.com. Text: „Dobrý den?“.");
    const resolved = describeActionStep("resolve_communication_intakes", { channel: "whatsapp" }, { count: 3, channel: "whatsapp" }, "en-GB");
    assert.match(resolved, /^I will mark .* as resolved\..* Nothing is sent or deleted\.$/);
    // Without a review of its own, a step says exactly what it will be given.
    assert.equal(describeActionStep("create_industry", { name: "Gardening", confirmed: true }, undefined, "cs-CZ"), "create industry: name „Gardening“");
  });

  it("says which steps ran, which failed and that the rest did not run", () => {
    assert.equal(
      executionMessage([{ ok: true, httpStatus: 201, message: "command “create job Hedge trim for Petra Novak” – done" }, { ok: true, httpStatus: 200, message: "The event has been moved." }], 2, "en-GB"),
      "Done. 1. command “create job Hedge trim for Petra Novak” – done. 2. The event has been moved.",
    );
    assert.equal(
      executionMessage([{ ok: true, httpStatus: 201, message: "Job created" }, { ok: false, httpStatus: 404, error: "TASK_NOT_FOUND", message: "task 'Call Petra' was not found." }], 3, "en-GB"),
      "I carried out 1 of 3 steps. 1. Job created. 2. Failed: task 'Call Petra' was not found. I did not carry out the remaining step.",
    );
    assert.match(executionMessage([{ ok: false, httpStatus: 423, message: "Nouzové zastavení." }], 2, "cs-CZ"), /^Provedl jsem 0 z 2 kroků\. 1\. Nepovedlo se: .* Zbylé kroky \(1\) jsem neprovedl\.$/);
  });

  it("executes a stored proposal only exactly as it was read out", () => {
    const schema = AGENT_PROPOSAL_REVIEW.payloadSchema;
    const stored = payload([jobStep, statusStep]);
    assert.equal(schema.safeParse(stored).success, true);
    // The database does not keep key order; the fingerprint must not care.
    const reordered = JSON.parse(JSON.stringify({ steps: stored.steps.map((step) => Object.fromEntries(Object.entries(step).reverse())), fingerprint: stored.fingerprint, version: 1 }));
    assert.equal(schema.safeParse(reordered).success, true, "key order is not a change");

    const changedWords = { ...stored, steps: [{ ...jobStep, description: "something else" }, statusStep] };
    assert.equal(schema.safeParse(changedWords).success, false, "different words than were read out");
    const changedValue = { ...stored, steps: [jobStep, { ...statusStep, parameters: { task_title: "Call Petra", task_status: "cancelled" } }] };
    assert.equal(schema.safeParse(changedValue).success, false, "a different value than was read out");

    const forbidden: ProposalStep = { kind: "action", action: "disconnect_gmail", parameters: {}, reviewed: true, description: "disconnect gmail" };
    assert.equal(schema.safeParse(payload([forbidden])).success, false, "never-proposed tools are refused even when fingerprinted");
    const unreviewed: ProposalStep = { kind: "action", action: "send_email", parameters: { to: ["petra@example.com"], subject: "Hi", body: "Hello" }, reviewed: false, description: "send" };
    assert.equal(schema.safeParse(payload([unreviewed])).success, false, "a reviewed action cannot run without its review");
    const archive: ProposalStep = { kind: "command", command: "archive client Petra Novak", intent: "prepare_archive_client", description: "archive" };
    assert.equal(schema.safeParse(payload([archive])).success, false, "a command with its own review is not proposable");
    const misread: ProposalStep = { kind: "command", command: "list clients", intent: "create_job", description: "x" };
    assert.equal(schema.safeParse(payload([misread])).success, false, "the stored intent must be what the command reads as");
    assert.equal(schema.safeParse({ ...payload([]), steps: [] }).success, false, "an empty proposal is nothing to approve");
  });
});
