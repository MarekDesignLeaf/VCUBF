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

for (const testFile of testFiles) {
  console.log(`Running ${testFile}...`);
  execFileSync(
    testNode,
    ["--import", "tsx", "--test", "--test-concurrency=1", "--test-force-exit", testFile],
    // Every test imports createServer from server.ts. Force test mode for the
    // child process so that import never opens the production listener on
    // port 4000 while the local Secretary runtime is already running.
    { env: { ...process.env, NODE_ENV: "test" }, stdio: "inherit" }
  );
}
