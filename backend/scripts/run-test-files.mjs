import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const requestedFiles = process.argv.slice(2);
const testFiles = requestedFiles.length > 0
  ? requestedFiles
  : fs.readdirSync("tests")
    .filter((file) => file.endsWith(".test.ts"))
    .sort()
    .map((file) => path.join("tests", file));

if (testFiles.length === 0) throw new Error("NO_TEST_FILES_FOUND");

let testNode = process.execPath;
if (process.arch === "arm64") {
  const localConfigPath = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, "VCUBF", "Emma", "config.json")
    : "";
  let configuredNode = "";
  try {
    configuredNode = JSON.parse(fs.readFileSync(localConfigPath, "utf8")).LocalNodePath ?? "";
  } catch {
    // A non-desktop environment simply keeps its current Node executable.
  }
  const candidates = [process.env.VCUBF_NODE_PATH, configuredNode].filter(Boolean);
  const compatible = candidates.find((candidate) => {
    if (!fs.existsSync(candidate)) return false;
    try {
      return execFileSync(candidate, ["-p", "process.arch"], { encoding: "utf8" }).trim() === "x64";
    } catch {
      return false;
    }
  });
  if (compatible) testNode = compatible;
}

// Each file must finish on its own. `--test-force-exit` is deliberately not
// used: on Node 22 it can end a file's process before every result has been
// written back, and the file then "passes" with fewer tests. A file that
// leaves a handle open (a Prisma connection, a server, a timer) now hangs
// instead, and the timeout below turns that into a failure naming the file.
const fileTimeoutMs = Number(process.env.VCUBF_TEST_FILE_TIMEOUT_MS ?? 10 * 60 * 1000);
const verdictDir = fs.mkdtempSync(path.join(os.tmpdir(), "vcubf-test-verdicts-"));
const results = [];
const failures = [];

try {
  for (const [index, testFile] of testFiles.entries()) {
    console.log(`Running ${testFile}...`);
    const verdictFile = path.join(verdictDir, `${index}.json`);
    const run = spawnSync(
      testNode,
      [
        "--import", "tsx", "--test", "--test-concurrency=1",
        "--test-reporter=spec", "--test-reporter-destination=stdout",
        // Proves the file ran to its end; read back below.
        "--test-reporter=./scripts/test-completion-reporter.mjs", `--test-reporter-destination=${verdictFile}`,
        // On GitHub Actions each failure also becomes an annotation on the check,
        // readable without the raw log.
        ...(process.env.GITHUB_ACTIONS
          ? ["--test-reporter=./scripts/github-test-annotations.mjs", "--test-reporter-destination=stdout"]
          : []),
        testFile,
      ],
      // Every test imports createServer from server.ts. Force test mode for the
      // child process so that import never opens the production listener on
      // port 4000 while the local Secretary runtime is already running.
      { env: { ...process.env, NODE_ENV: "test" }, stdio: "inherit", timeout: fileTimeoutMs, killSignal: "SIGKILL" }
    );

    let verdict = null;
    try {
      verdict = JSON.parse(fs.readFileSync(verdictFile, "utf8"));
    } catch {
      // Missing or partial verdict: handled as incomplete below.
    }

    const problems = [];
    if (run.error?.code === "ETIMEDOUT") {
      problems.push(`did not finish within ${fileTimeoutMs} ms; something keeps its process alive (an open Prisma connection, server, socket or timer)`);
    } else if (run.error) {
      problems.push(`could not run: ${run.error.message}`);
    } else if (run.status !== 0) {
      problems.push(`exited with ${run.signal ? `signal ${run.signal}` : `code ${run.status}`}`);
    }
    if (!verdict) problems.push("the completion reporter wrote no verdict");
    else if (!verdict.complete) problems.push(...verdict.problems);
    if (verdict?.counts && verdict.counts.tests === 0) problems.push("reported no tests at all");

    const counts = verdict?.counts;
    results.push({ testFile, counts, ok: problems.length === 0 });
    if (problems.length > 0) {
      failures.push(testFile);
      console.error(`\nTEST FILE FAILED: ${testFile}\n${problems.map((problem) => `  - ${problem}`).join("\n")}\n`);
    }
  }
} finally {
  fs.rmSync(verdictDir, { recursive: true, force: true });
}

console.log("\nPer-file results (tests / pass / fail / skipped / todo / cancelled):");
for (const { testFile, counts, ok } of results) {
  const line = counts
    ? `${counts.tests} / ${counts.passed} / ${counts.failed} / ${counts.skipped} / ${counts.todo} / ${counts.cancelled}`
    : "no results";
  console.log(`  ${ok ? "ok    " : "FAILED"} ${testFile}: ${line}`);
}
const total = results.reduce((sum, { counts }) => sum + (counts?.tests ?? 0), 0);
console.log(`Total: ${total} tests in ${results.length} files.`);

if (failures.length > 0) {
  console.error(`\n${failures.length} test file(s) failed or did not complete:\n${failures.map((file) => `  ${file}`).join("\n")}`);
  process.exit(1);
}
