import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  EMMA_EXECUTABLE_ACTIONS,
  EMMA_NON_DIRECT_ACTIONS,
  isEmmaExecutableActionName,
  parseEmmaExecutableActionCommand,
} from "../src/lib/emmaExecutableActionCatalogue.js";

/**
 * Nothing that carries a secret may be executed by speaking.
 *
 * A password or a one-time pairing key said out loud is heard by the room, sent
 * away for recognition and left in the conversation history. The catalogue
 * documents these exclusions in prose; these tests make them a guarantee, so a
 * later change cannot quietly reopen the hole.
 */
describe("Secrets are never spoken", () => {
  const secretBearing = [
    "change_own_password",
    "reset_employee_password",
    // Creating a user means setting their first password.
    "create_employee",
    // The pairing token is a key to the whole system.
    "approve_device_pairing",
  ];

  for (const action of secretBearing) {
    it(`${action} is absent from the spoken catalogue`, () => {
      assert.ok(
        !Object.prototype.hasOwnProperty.call(EMMA_EXECUTABLE_ACTIONS, action),
        `${action} must not be a spoken action`,
      );
    });

    it(`${action} is documented as excluded, with a reason`, () => {
      assert.ok(
        Object.prototype.hasOwnProperty.call(EMMA_NON_DIRECT_ACTIONS, action),
        `${action} must be listed as deliberately excluded so it reads as a decision`,
      );
    });

    it(`${action} is refused at the gate, not deeper in`, () => {
      // This is the check that actually stops it: the name is rejected before any
      // parameter is looked at.
      assert.equal(isEmmaExecutableActionName(action), false);
      assert.equal(
        parseEmmaExecutableActionCommand(`voice action ${action}: {"confirmed":true}`),
        undefined,
        `a crafted command naming ${action} must not parse`,
      );
    });
  }

  it("every exclusion records why", () => {
    for (const [action, definition] of Object.entries(EMMA_NON_DIRECT_ACTIONS)) {
      assert.ok(
        typeof definition.note === "string" && definition.note.trim().length > 10,
        `${action} needs a reason, so nobody has to guess whether it was an oversight`,
      );
    }
  });

  it("no spoken action takes a field that looks like a secret", () => {
    // A field named for a password or a token is the shape of the mistake this
    // guards against, whatever the action ends up being called.
    const suspicious = /password|secret|token|api_key|passphrase/i;
    for (const [action, definition] of Object.entries(EMMA_EXECUTABLE_ACTIONS)) {
      assert.ok(
        !suspicious.test(definition.fields),
        `${action} accepts a secret-looking field: ${definition.fields}`,
      );
    }
  });

  it("a real action still parses, so the gate is not simply refusing everything", () => {
    const parsed = parseEmmaExecutableActionCommand('voice action set_speech_rate: {"change":"faster"}');
    assert.deepEqual(parsed, { action: "set_speech_rate", parameters: { change: "faster" } });
  });
});
