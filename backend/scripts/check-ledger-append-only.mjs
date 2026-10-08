// The tool-catalogue version ledger must only ever grow at the end: an entry
// that has shipped names one exact catalogue document for ever. A test inside
// the repository cannot prove that, because the same commit can rewrite both
// the ledger and the test's expectations. This check runs in CI against the
// file as it stands on master — the one place the previous ledger actually
// exists — and fails when a shipped entry was changed or removed.
//
// Usage: node scripts/check-ledger-append-only.mjs <base-file> <head-file>
// The caller skips the check when there is no base (first commit of the file).

import { readFileSync } from "node:fs";

function entries(path) {
  const source = readFileSync(path, "utf8");
  const block = source.match(/TOOL_CATALOGUE_FINGERPRINTS = \{([\s\S]*?)\}/);
  if (!block) throw new Error(`${path}: no TOOL_CATALOGUE_FINGERPRINTS ledger found`);
  const found = new Map();
  for (const match of block[1].matchAll(/"(\d+\.\d+\.\d+)":\s*"([0-9a-f]{64})"/g)) {
    if (found.has(match[1])) throw new Error(`${path}: version ${match[1]} appears twice`);
    found.set(match[1], match[2]);
  }
  if (found.size === 0) throw new Error(`${path}: the ledger is empty`);
  return found;
}

const [, , basePath, headPath] = process.argv;
const base = entries(basePath);
const head = entries(headPath);

const broken = [];
for (const [version, fingerprint] of base) {
  if (!head.has(version)) broken.push(`version ${version} was removed from the ledger`);
  else if (head.get(version) !== fingerprint) broken.push(`version ${version} changed its fingerprint`);
}
if (broken.length > 0) {
  console.error("The tool-catalogue ledger is append-only. On master it already contains entries this change rewrites:");
  for (const line of broken) console.error(`  - ${line}`);
  console.error("Append a NEW version for the changed catalogue instead. (A branch behind master: rebase first.)");
  process.exit(1);
}
console.log(`Ledger append-only: ${base.size} shipped entr${base.size === 1 ? "y" : "ies"} unchanged, ${head.size - base.size} added.`);
