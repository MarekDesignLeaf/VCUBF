import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ordinalCompare } from "../src/lib/ordinalCompare.js";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (file: string) => pathToFileURL(path.join(backend, "src", file)).href;

/**
 * Computes every canonical fingerprint in a fresh process whose default
 * collation is the given locale. `localeCompare` is replaced by that
 * locale's collator before any module loads, so the check does not depend on
 * the machine's own locale (Windows takes ICU's default from the system, not
 * from LC_ALL) and would catch any locale-dependent order that came back.
 */
function fingerprintsUnder(locale: string) {
  const code = `
    const collator = new Intl.Collator(${JSON.stringify(locale)});
    String.prototype.localeCompare = function (other, locales, options) {
      return locales === undefined && options === undefined ? collator.compare(String(this), String(other)) : new Intl.Collator(locales, options).compare(String(this), String(other));
    };
    const { createHash } = await import("node:crypto");
    const tools = await import(${JSON.stringify(src("agents/toolCatalogue.ts"))});
    const mcp = await import(${JSON.stringify(src("modules/mcp/routes.ts"))});
    const shadow = await import(${JSON.stringify(src("agents/shadowAgent.ts"))});
    const surface = await import(${JSON.stringify(src("lib/emmaSurfaceCatalogue.ts"))});
    const sha = (text) => createHash("sha256").update(text).digest("hex");
    console.log(JSON.stringify({
      agentCatalogue: tools.toolCatalogueFingerprint(),
      agentLedger: tools.TOOL_CATALOGUE_FINGERPRINT,
      mcpToolset: mcp.mcpToolsetFingerprint(),
      mcpLedger: mcp.MCP_TOOLSET_FINGERPRINTS[mcp.MCP_TOOLSET_REVISION],
      agentFunctions: shadow.AGENT_TOOLSET_FINGERPRINT,
      emmaSurface: sha(JSON.stringify(surface.EMMA_CAPABILITIES)),
    }));
  `;
  const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
    cwd: backend, encoding: "utf8", env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://unused@127.0.0.1:1/unused" },
  });
  return JSON.parse(output.trim().split("\n").pop()!);
}

describe("canonical order does not depend on the machine's locale", () => {
  it("orders by code unit, not by any language's collation", () => {
    // Czech collation puts "ch" after "h"; English and the code-unit order do not.
    assert.deepEqual(["hold", "change_x", "create_job"].sort(ordinalCompare), ["change_x", "create_job", "hold"]);
    assert.deepEqual(["b", "B", "a", "_a"].sort(ordinalCompare), ["B", "_a", "a", "b"]);
    assert.equal(ordinalCompare("same", "same"), 0);
    assert.notDeepEqual(["hold", "change_x"].sort(new Intl.Collator("cs-CZ").compare), ["change_x", "hold"], "the Czech collator is available, so the next test is meaningful");
  });

  it("gives the same agent and MCP fingerprints, matching the ledgers, under English, Czech, Polish and Turkish collation", () => {
    const results = ["en-GB", "cs-CZ", "pl-PL", "tr-TR"].map((locale) => ({ locale, ...fingerprintsUnder(locale) }));
    const [first] = results;
    assert.equal(first.agentCatalogue, first.agentLedger, "the agent tool catalogue matches the last TOOL_CATALOGUE_FINGERPRINTS entry");
    assert.equal(first.mcpToolset, first.mcpLedger, "the MCP toolset matches the last MCP_TOOLSET_FINGERPRINTS entry");
    for (const result of results) {
      for (const key of ["agentCatalogue", "mcpToolset", "agentFunctions", "emmaSurface"] as const) {
        assert.equal(result[key], first[key], `${key} under ${result.locale}`);
      }
    }
  });

  it("uses no default-locale localeCompare in code that builds a catalogue or fingerprint", () => {
    const files = [
      "agents/toolCatalogue.ts", "agents/agentProposal.ts", "agents/shadowAgent.ts", "lib/emmaSurfaceCatalogue.ts",
      "lib/emmaExecutableActionCatalogue.ts", "lib/actionContracts.ts", "modules/mcp/routes.ts", "modules/mcp/writeTools.ts",
      "modules/mcp/capabilities.ts", "modules/mcp/deviceTools.ts",
    ];
    for (const file of files) {
      const text = readFileSync(path.join(backend, "src", file), "utf8");
      assert.doesNotMatch(text, /\.localeCompare\(/, `${file} must order with ordinalCompare`);
    }
  });
});
