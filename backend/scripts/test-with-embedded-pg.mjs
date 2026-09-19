import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Prisma's local Windows engine is x64. On Snapdragon Windows, re-run this
// orchestrator with the same x64 Node runtime used by Secretary instead of
// touching the live database or requiring Docker merely for architecture.
if (process.platform === "win32" && process.arch === "arm64") {
  const localConfigPath = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, "VCUBF", "Emma", "config.json")
    : "";
  let configuredNode = "";
  try {
    configuredNode = JSON.parse(fs.readFileSync(localConfigPath, "utf8")).LocalNodePath ?? "";
  } catch {
    // The Docker fallback below remains available outside the desktop setup.
  }
  if (configuredNode && fs.existsSync(configuredNode)) {
    const architecture = execFileSync(configuredNode, ["-p", "process.arch"], { encoding: "utf8" }).trim();
    if (architecture === "x64") {
      execFileSync(configuredNode, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
        env: process.env,
        stdio: "inherit",
      });
      process.exit(0);
    }
  }
}

const dbDir = path.join(os.tmpdir(), `vcuf_test_pg_${process.pid}`);
fs.rmSync(dbDir, { recursive: true, force: true });

const prismaCli = path.resolve("node_modules/prisma/build/index.js");
const embeddedUrl = "postgresql://vcuf:vcuf@localhost:55432/vcuf_test";
const repositoryRoot = path.resolve(process.cwd(), "..");
const frontendSourceRoot = path.join(repositoryRoot, "frontend", "src");
const testTargets = process.argv.slice(2);

function runTests(url) {
  const generatedClient = path.resolve("node_modules/.prisma/client/index.js");
  if (!fs.existsSync(generatedClient)) {
    console.log(`Generating Prisma Client with ${process.arch} ${process.version}...`);
    execFileSync(process.execPath, [prismaCli, "generate"], {
      env: { ...process.env, DATABASE_URL: url },
      stdio: "inherit",
    });
  } else {
    // The running local backend has this native engine loaded. Windows locks
    // it against replacement, and regeneration is unnecessary because the
    // schema is unchanged; only the isolated database URL differs.
    console.log("Using the existing compatible Prisma Client.");
  }
  console.log("Postgres up, pushing schema...");
  execFileSync(process.execPath, [prismaCli, "db", "push", "--skip-generate"], {
    env: { ...process.env, DATABASE_URL: url },
    stdio: "inherit",
  });
  console.log("Running tests...");
  execFileSync(
    process.execPath,
    ["scripts/run-test-files.mjs", ...testTargets],
    {
      env: { ...process.env, DATABASE_URL: url, NODE_ENV: "test" },
      stdio: "inherit",
    }
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runWithDocker() {
  const suffix = process.pid;
  const networkName = `vcuf-test-network-${suffix}`;
  const databaseName = `vcuf-test-postgres-${suffix}`;
  try {
    console.log("Windows ARM64 needs Linux Prisma engines; starting an isolated Docker test stack...");
    execFileSync("docker", ["network", "create", networkName], { stdio: "inherit" });
    execFileSync("docker", [
      "run", "--rm", "--detach", "--name", databaseName,
      "--network", networkName, "--network-alias", "postgres",
      "-e", "POSTGRES_USER=vcuf",
      "-e", "POSTGRES_PASSWORD=vcuf",
      "-e", "POSTGRES_DB=vcuf",
      "postgres:16-alpine",
    ], { stdio: "inherit" });

    let ready = false;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        // Check through the Docker network, not the database container's local
        // socket: Postgres briefly accepts local socket clients while its init
        // process is still about to restart for normal TCP connections.
        execFileSync("docker", [
          "run", "--rm", "--network", networkName,
          "postgres:16-alpine", "pg_isready", "-h", "postgres", "-U", "vcuf", "-d", "vcuf",
        ], { stdio: "ignore" });
        ready = true;
        break;
      } catch {
        await sleep(1000);
      }
    }
    if (!ready) throw new Error("TEST_POSTGRES_DID_NOT_BECOME_READY");
    execFileSync("docker", [
      "run", "--rm", "--network", networkName,
      "-e", "DATABASE_URL=postgresql://vcuf:vcuf@postgres:5432/vcuf?schema=public",
      "-e", "NODE_ENV=test",
      "-e", `VCUF_TEST_TARGETS=${testTargets.join(";")}`,
      "-v", `${process.cwd()}:/source/backend:ro`,
      "-v", `${frontendSourceRoot}:/source/frontend/src:ro`,
      "-w", "/work",
      "node:22-bookworm",
      "sh", "-lc",
      "mkdir -p /work/backend /work/frontend && tar -C /source/backend --exclude=node_modules --exclude=dist -cf - . | tar -C /work/backend -xf - && cp -a /source/frontend/src /work/frontend/src && cd /work/backend && npm ci --no-audit --no-fund && npx prisma generate && npx prisma db push --skip-generate && if [ -n \"$VCUF_TEST_TARGETS\" ]; then node scripts/run-test-files.mjs $(printf '%s' \"$VCUF_TEST_TARGETS\" | tr ';' ' '); else node scripts/run-test-files.mjs; fi",
    ], { stdio: "inherit" });
  } finally {
    try {
      execFileSync("docker", ["rm", "--force", databaseName], { stdio: "ignore" });
    } catch {
      // The container may not have started, or may already have been removed.
    }
    try {
      execFileSync("docker", ["network", "rm", networkName], { stdio: "ignore" });
    } catch {
      // The network may not have been created, or may already have been removed.
    }
  }
}

if (process.platform === "win32" && process.arch === "arm64") {
  await runWithDocker();
} else {
  const { default: EmbeddedPostgres } = await import("embedded-postgres");
  const pg = new EmbeddedPostgres({
    databaseDir: dbDir,
    user: "vcuf",
    password: "vcuf",
    port: 55432,
    persistent: false,
  });
  try {
    await pg.initialise();
    await pg.start();
    await pg.createDatabase("vcuf_test");
    runTests(embeddedUrl);
  } finally {
    await pg.stop();
  }
}

console.log("TESTS_OK");
