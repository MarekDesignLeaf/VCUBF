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

  it("every allowed exception still exists, so the list cannot rot", () => {
    for (const path of ALLOWED.keys()) {
      assert.match(readFileSync(join(SRC, path), "utf8"), /\bvoicePendingAction\b/, `${path} no longer needs its exception`);
    }
  });
});
