import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import {
  capabilityIdForCommand,
  COMMAND_POLICY,
  EMMA_ACTION_CAPABILITY_COUNT,
  EMMA_ACTION_CONTRACTS,
  EMMA_CAPABILITIES,
  EMMA_PAGE_CAPABILITY_COUNT,
} from "../src/lib/emmaSurfaceCatalogue.js";
import { VOICE_PAGE_ROUTES } from "../src/lib/voiceNavigation.js";

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
});
