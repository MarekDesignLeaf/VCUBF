import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { PROGRAM_KNOWLEDGE } from "../src/lib/programKnowledge.js";

describe("Emma program knowledge", () => {
  it("covers every route implemented by the frontend", () => {
    const appPath = fileURLToPath(new URL("../../frontend/src/App.tsx", import.meta.url));
    const source = readFileSync(appPath, "utf8");
    const routes = [...source.matchAll(/<Route path="([^"]+)"/g)].map((match) => match[1]);
    assert.ok(routes.length > 30, "expected the complete frontend route tree");
    for (const route of routes) {
      assert.ok(PROGRAM_KNOWLEDGE.includes(route), `program knowledge is missing ${route}`);
    }
  });

  it("grounds guidance in exact controls and safe external-effect boundaries", () => {
    for (const label of ["New client", "Preserve message", "Create draft", "Record payment", "Confirm run", "Save voice preferences"]) {
      assert.ok(PROGRAM_KNOWLEDGE.includes(label), `program knowledge is missing control ${label}`);
    }
    assert.match(PROGRAM_KNOWLEDGE, /does not send/i);
    assert.match(PROGRAM_KNOWLEDGE, /does not publish/i);
  });
});
