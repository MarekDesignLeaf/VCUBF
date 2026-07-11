import EmbeddedPostgres from "embedded-postgres";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const dbDir = "/tmp/vcuf_test_pg";
fs.rmSync(dbDir, { recursive: true, force: true });

const pg = new EmbeddedPostgres({
  databaseDir: dbDir,
  user: "vcuf",
  password: "vcuf",
  port: 55432,
  persistent: false,
});

const url = "postgresql://vcuf:vcuf@localhost:55432/vcuf_test";
const prismaCli = path.resolve("node_modules/prisma/build/index.js");
const testTarget = process.argv[2] ?? "tests/*.test.ts";

try {
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("vcuf_test");
  console.log(`Generating Prisma Client with ${process.arch} ${process.version}...`);
  execFileSync(process.execPath, [prismaCli, "generate"], {
    env: { ...process.env, DATABASE_URL: url },
    stdio: "inherit",
  });
  console.log("Postgres up, pushing schema...");
  execFileSync(process.execPath, [prismaCli, "db", "push", "--skip-generate"], {
    env: { ...process.env, DATABASE_URL: url },
    stdio: "inherit",
  });
  console.log("Running tests...");
  execFileSync(
    process.execPath,
    ["--import", "tsx", "--test", "--test-concurrency=1", "--test-force-exit", testTarget],
    {
      env: { ...process.env, DATABASE_URL: url, NODE_ENV: "test" },
      stdio: "inherit",
    }
  );
  console.log("TESTS_OK");
} finally {
  await pg.stop();
}
