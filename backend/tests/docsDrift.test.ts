import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// Documentation drift guard. The "Current snapshot" section of the repository
// README states hard counts. This suite recomputes them from source so a new
// route group, model, Action Contract, permission or test suite cannot land
// without the README being updated in the same change. It reads files only;
// it needs no database.

const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

function snapshotSection() {
  const readme = read("../../README.md");
  const start = readme.indexOf("## Current snapshot");
  assert.ok(start >= 0, "README.md must contain a '## Current snapshot' section");
  const end = readme.indexOf("\n## ", start + 5);
  return readme.slice(start, end === -1 ? undefined : end);
}

function documented(section: string, pattern: RegExp, label: string) {
  const match = section.match(pattern);
  assert.ok(match, `README Current snapshot does not state the ${label} count`);
  return Number(match[1]);
}

describe("README Current snapshot matches the code", () => {
  const section = snapshotSection();

  it("states the real number of mounted route groups", () => {
    const actual = (read("../src/server.ts").match(/app\.use\("\//g) ?? []).length;
    assert.equal(documented(section, /(\d+) mounted route groups/, "route group"), actual);
  });

  it("states the real number of Prisma models", () => {
    const actual = (read("../prisma/schema.prisma").match(/^model /gm) ?? []).length;
    assert.equal(documented(section, /(\d+) Prisma models/, "Prisma model"), actual);
  });

  it("states the real number of distinct Action Contracts", () => {
    const names = new Set([...read("../src/lib/actionContracts.ts").matchAll(/actionName:\s*"([a-z_]+)"/g)].map((m) => m[1]));
    assert.equal(documented(section, /(\d+) Action\s+Contracts/, "Action Contract"), names.size);
  });

  it("states the real number of fixed permissions", () => {
    const source = read("../src/lib/actionContracts.ts");
    const block = source.match(/export const KNOWN_PERMISSIONS = \[([\s\S]*?)\] as const/);
    assert.ok(block, "KNOWN_PERMISSIONS not found");
    const actual = (block[1].match(/"[a-z.]+"/g) ?? []).length;
    assert.equal(documented(section, /(\d+) fixed permissions/, "permission"), actual);
  });

  it("states the real number of test suites", () => {
    const actual = readdirSync(fileURLToPath(new URL(".", import.meta.url))).filter((file) => file.endsWith(".test.ts")).length;
    assert.equal(documented(section, /(\d+) test files/, "test suite"), actual);
  });
});
