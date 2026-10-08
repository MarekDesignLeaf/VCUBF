import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// Pattern freeze (docs/AGENT_MASTERPLAN_2026-10-08.md, F0 step 4). Every
// reviewed action — prepare, wait for the yes, claim exactly once, execute,
// resolve — goes through src/lib/executionEngine.ts. Seven services used to
// keep their own copy of that lifecycle over VoicePendingAction; they were
// migrated one by one (PRs #34–#39). This guard keeps it that way: a new
// confirmation flow that writes the table directly fails here and must use
// the engine instead. It reads files only; it needs no database.

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

// The only places allowed to touch the table directly, each with its reason.
const ALLOWED = new Map<string, string>([
  ["lib/executionEngine.ts", "the engine itself"],
  [
    "modules/command/voiceState.ts",
    "clearing the voice history withdraws the waiting email in the same transaction as the transcript deletion",
  ],
]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

describe("execution engine pattern freeze", () => {
  it("no code outside the engine keeps its own reviewed-action lifecycle", () => {
    const offenders = sourceFiles(SRC)
      .map((path) => relative(SRC, path).split("\\").join("/"))
      .filter((path) => !ALLOWED.has(path))
      .filter((path) => /\bvoicePendingAction\b/.test(readFileSync(join(SRC, path), "utf8")));
    assert.deepEqual(
      offenders,
      [],
      "These files touch VoicePendingAction directly. Use prepareReviewedAction / claimReviewedAction / " +
        "cancelReviewedAction from src/lib/executionEngine.ts instead of a new copy of the lifecycle.",
    );
  });

  it("every status the engine writes is allowed by the production CHECK constraint", () => {
    // CI builds its database with `prisma db push`, which never applies the
    // CHECK constraints written in migrations. A new status word would pass
    // every test and fail only in production — so it is checked here, against
    // the newest migration that defines the constraint.
    const migrations = fileURLToPath(new URL("../prisma/migrations/", import.meta.url));
    const definitions = readdirSync(migrations)
      .filter((name) => statSync(join(migrations, name)).isDirectory())
      .sort()
      .map((name) => readFileSync(join(migrations, name, "migration.sql"), "utf8"))
      .filter((sql) => /ADD CONSTRAINT "voice_pending_actions_status_check"|CONSTRAINT "voice_pending_actions_status_check"\s+CHECK/.test(sql));
    const latest = definitions.at(-1);
    assert.ok(latest, "no migration defines voice_pending_actions_status_check");
    const check = latest.slice(latest.lastIndexOf("voice_pending_actions_status_check"));
    const allowed = new Set([...check.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]));

    const engine = readFileSync(join(SRC, "lib/executionEngine.ts"), "utf8");
    const written = new Set<string>();
    for (const match of engine.matchAll(/status: "([a-z_]+)"/g)) written.add(match[1]);
    for (const match of engine.matchAll(/\?\? "([a-z_]+)"/g)) written.add(match[1]);
    for (const path of sourceFiles(SRC)) {
      for (const match of readFileSync(path, "utf8").matchAll(/(?:claimedStatus|replacedStatus|completedStatus): "([a-z_]+)"/g)) {
        written.add(match[1]);
      }
    }
    assert.ok(written.has("pending") && written.has("completed"), "the scan must see the engine's own statuses");
    const refused = [...written].filter((status) => !allowed.has(status)).sort();
    assert.deepEqual(refused, [], "Add these statuses to voice_pending_actions_status_check in a new migration.");
  });

  it("every allowed exception still exists, so the list cannot rot", () => {
    for (const path of ALLOWED.keys()) {
      assert.match(readFileSync(join(SRC, path), "utf8"), /\bvoicePendingAction\b/, `${path} no longer needs its exception`);
    }
  });
});
