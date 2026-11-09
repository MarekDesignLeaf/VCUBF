// The tool-catalogue version ledger must only ever grow at the end: an entry
// that has shipped names one exact catalogue document for ever. A test inside
// the repository cannot prove that, because the same commit can rewrite both
// the ledger and the test's expectations. This check runs in CI against the
// file as it stands on master — the one place the previous ledger actually
// exists — and fails when a shipped entry was changed or removed.
//
// Usage: node scripts/check-ledger-append-only.mjs <base-file> <head-file> [LEDGER_NAME]
// LEDGER_NAME defaults to TOOL_CATALOGUE_FINGERPRINTS; the MCP gateway's
// MCP_TOOLSET_FINGERPRINTS (backend/src/modules/mcp/routes.ts) is checked the
// same way. The caller skips the check when there is no base file; a base file
// without the named ledger yet (the ledger's first commit) passes.

import { readFileSync } from "node:fs";

const [, , basePath, headPath, ledgerName = "TOOL_CATALOGUE_FINGERPRINTS"] = process.argv;

function entries(path, { optional = false } = {}) {
  const source = readFileSync(path, "utf8");
  const block = source.match(new RegExp(`${ledgerName} = \\{([\\s\\S]*?)\\}`));
  if (!block) {
    if (optional) return null;
    throw new Error(`${path}: no ${ledgerName} ledger found`);
  }
  const found = new Map();
  for (const match of block[1].matchAll(/"([0-9A-Za-z._-]+)":\s*"([0-9a-f]{64})"/g)) {
    if (found.has(match[1])) throw new Error(`${path}: version ${match[1]} appears twice`);
    found.set(match[1], match[2]);
  }
  if (found.size === 0) throw new Error(`${path}: the ledger is empty`);
  return found;
}

const base = entries(basePath, { optional: ledgerName !== "TOOL_CATALOGUE_FINGERPRINTS" });
const head = entries(headPath);
if (!base) {
  console.log(`${ledgerName}: not on the base yet; ${head.size} entr${head.size === 1 ? "y" : "ies"} added.`);
  process.exit(0);
}

const broken = [];
for (const [version, fingerprint] of base) {
  if (!head.has(version)) broken.push(`version ${version} was removed from the ledger`);
  else if (head.get(version) !== fingerprint) broken.push(`version ${version} changed its fingerprint`);
}
if (broken.length > 0) {
  console.error(`The ${ledgerName} ledger is append-only. On master it already contains entries this change rewrites:`);
  for (const line of broken) console.error(`  - ${line}`);
  console.error("Append a NEW version for the changed catalogue instead. (A branch behind master: rebase first.)");
  process.exit(1);
}
console.log(`${ledgerName} append-only: ${base.size} shipped entr${base.size === 1 ? "y" : "ies"} unchanged, ${head.size - base.size} added.`);
