import EmbeddedPostgres from "embedded-postgres";
import { execSync } from "node:child_process";
import fs from "node:fs";

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

try {
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("vcuf_test");
  console.log("Postgres up, pushing schema...");
  execSync("npx prisma db push --skip-generate", {
    env: { ...process.env, DATABASE_URL: url },
    stdio: "inherit",
  });
  console.log("Running tests...");
  execSync("node --import tsx --test tests/*.test.ts", {
    env: { ...process.env, DATABASE_URL: url, NODE_ENV: "test" },
    stdio: "inherit",
  });
  console.log("TESTS_OK");
} finally {
  await pg.stop();
}
