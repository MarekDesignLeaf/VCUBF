import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { PROGRAM_KNOWLEDGE } from "../src/lib/programKnowledge.js";
import { getNavigationCatalogue } from "../src/lib/navigationCatalogue.js";

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
    for (const label of ["New client", "Preserve message", "Create draft", "Record payment", "Confirm run", "Save voice preferences", "For the company", "Remember"]) {
      assert.ok(PROGRAM_KNOWLEDGE.includes(label), `program knowledge is missing control ${label}`);
    }
    assert.match(PROGRAM_KNOWLEDGE, /does not send/i);
    assert.match(PROGRAM_KNOWLEDGE, /does not publish/i);
    assert.match(PROGRAM_KNOWLEDGE, /there is no New invoice button and no add-line control/i);
    assert.match(PROGRAM_KNOWLEDGE, /Only Record payment is confirmation-gated/i);
  });

  it("keeps Emma's complete menu tree aligned with every sidebar item and page subtree", () => {
    const appPath = fileURLToPath(new URL("../../frontend/src/App.tsx", import.meta.url));
    const layoutPath = fileURLToPath(new URL("../../frontend/src/components/Layout.tsx", import.meta.url));
    const appSource = readFileSync(appPath, "utf8");
    const layoutSource = readFileSync(layoutPath, "utf8");
    const catalogue = getNavigationCatalogue(["connectors.read", "recruitment.manage", "voice.execute", "audit.read"]);
    const cataloguePaths = new Set(
      catalogue.sections.flatMap((section) => section.items.flatMap((item) => [item.path, ...item.children.flatMap((child) => child.path ? [child.path] : [])]))
    );
    const protectedRoutes = [...appSource.matchAll(/<Route path="([^"]+)"/g)]
      .map((match) => match[1])
      .filter((path) => path !== "/login");
    const sidebarPaths = [...layoutSource.matchAll(/<NavLink to="([^"]+)"/g)].map((match) => match[1]);

    for (const path of [...protectedRoutes, ...sidebarPaths]) {
      assert.ok(cataloguePaths.has(path), `Emma's navigation catalogue is missing ${path}`);
    }
    assert.match(catalogue.readout, /Client details/);
    assert.match(catalogue.readout, /Quote details/);
    assert.match(catalogue.readout, /User access management/);

    const restricted = getNavigationCatalogue([]);
    const connectors = restricted.sections.flatMap((section) => section.items).find((item) => item.id === "connectors");
    assert.equal(connectors?.available, false);
    assert.match(connectors?.accessNote ?? "", /connectors\.read/);
  });
});
