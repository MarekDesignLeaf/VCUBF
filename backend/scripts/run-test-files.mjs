import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const requestedFiles = process.argv.slice(2);
const testFiles = requestedFiles.length > 0
  ? requestedFiles
  : fs.readdirSync("tests")
    .filter((file) => file.endsWith(".test.ts"))
    .sort()
    .map((file) => path.join("tests", file));

if (testFiles.length === 0) throw new Error("NO_TEST_FILES_FOUND");

for (const testFile of testFiles) {
  console.log(`Running ${testFile}...`);
  execFileSync(
    process.execPath,
    ["--import", "tsx", "--test", "--test-concurrency=1", "--test-force-exit", testFile],
    { env: process.env, stdio: "inherit" }
  );
}
