#!/usr/bin/env node
// CP-CODE-001 / GOV-042 bridge: every Action Contract in code maps to a Bible capability with a risk class
// at least as strict as the registry (PERM-011). Exit 1 on drift. Runs in CI without a database.
import fs from "node:fs";
import path from "node:path";
const root = path.resolve(new URL(".", import.meta.url).pathname, "../..");
const csv = (p) => { const [h, ...rows] = fs.readFileSync(p, "utf8").trim().split(/\r?\n/).map(l => l.match(/("([^"]|"")*"|[^,]*)(,|$)/g).map(c => c.replace(/,$/, "").replace(/^"|"$/g, "").replace(/""/g, '"'))); return rows.map(r => Object.fromEntries(h.map((k, i) => [k, r[i] ?? ""]))); };
const reg = new Map(csv(path.join(root, "docs/bible/capability_registry.csv")).map(r => [r.capability, r]));
for (const r of csv(path.join(root, "docs/bible/capability_registry_proposed_additions.csv"))) reg.set(r.capability, { ...r, proposed: true });
const map = new Map(csv(path.join(root, "docs/bible/action_capability_map.csv")).map(r => [r.action_name, r]));
const src = path.join(root, "backend/src");
const names = new Map();
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith(".ts")) { const t = fs.readFileSync(p, "utf8"); for (const m of t.matchAll(/actionName:\s*"([a-z_]+)"/g)) names.set(m[1], p); } } };
walk(src);
const contracts = new Map([...fs.readFileSync(path.join(src, "lib/actionContracts.ts"), "utf8").matchAll(/actionName:\s*"([a-z_]+)"[\s\S]*?riskLevel:\s*(\d)/g)].map(m => [m[1], Number(m[2])]));
const issues = [];
for (const [n, file] of names) {
  const row = map.get(n);
  if (!row) { issues.push(`${n} (${path.relative(root, file)}) not in docs/bible/action_capability_map.csv`); continue; }
  const cap = reg.get(row.capability);
  if (!cap) { issues.push(`${n} maps to unknown capability ${row.capability}`); continue; }
  const codeRisk = contracts.get(n);
  const base = Number(cap.base_risk.slice(1));
  if (codeRisk !== undefined && codeRisk < base && !row.accepted_deviation) issues.push(`${n}: code riskLevel ${codeRisk} < ${row.capability} base ${cap.base_risk} (PERM-011)`);
}
for (const n of map.keys()) if (!names.has(n)) issues.push(`map row ${n} has no action in code`);
console.log(`action→capability check: ${names.size} actions, ${map.size} mapped, ${[...reg.values()].filter(r => r.proposed).length} proposed capabilities pending Bible CP`);
if (issues.length) { console.error(`${issues.length} issue(s):`); issues.forEach(i => console.error("  " + i)); process.exit(1); }
console.log("PASS");
