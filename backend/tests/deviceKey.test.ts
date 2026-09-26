import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { after, afterEach, before, describe, it } from "node:test";
import request from "supertest";
import { createServer } from "../src/server.js";
import { prisma } from "../src/db.js";
import { resetDb, seedCompanyAndAdmin } from "./setup.js";

const app = createServer();
const key = randomBytes(32).toString("base64url");
const keyHash = createHash("sha256").update(key).digest("hex");

function configure(hash: string | undefined, email: string | undefined) {
  if (hash === undefined) delete process.env.DESKTOP_DEVICE_KEY_SHA256; else process.env.DESKTOP_DEVICE_KEY_SHA256 = hash;
  if (email === undefined) delete process.env.DESKTOP_DEVICE_USER_EMAIL; else process.env.DESKTOP_DEVICE_USER_EMAIL = email;
}

describe("password-free sign-in for the owner's PC (device key)", () => {
  before(async () => {
    await resetDb();
    await seedCompanyAndAdmin();
  });
  afterEach(() => configure(undefined, undefined));
  after(async () => {
    await resetDb();
    await prisma.$disconnect();
  });

  it("does not exist unless the server is configured", async () => {
    const res = await request(app).post("/auth/device/key").send({ key });
    assert.equal(res.status, 404);
  });

  it("signs the configured account in with the right key and audits it", async () => {
    configure(keyHash, "ADMIN@test.local");
    const res = await request(app).post("/auth/device/key").send({ key });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.email, "admin@test.local");
    const me = await request(app).get("/auth/me").set("Authorization", `Bearer ${res.body.token}`);
    assert.equal(me.status, 200);
    assert.equal(me.body.email, "admin@test.local");
    const audit = await prisma.auditLog.findFirst({ where: { actionName: "sign_in_with_device_key" } });
    assert.ok(audit);
    assert.doesNotMatch(JSON.stringify(audit), new RegExp(key));
  });

  it("refuses a wrong key", async () => {
    configure(keyHash, "admin@test.local");
    const res = await request(app).post("/auth/device/key").send({ key: randomBytes(32).toString("base64url") });
    assert.equal(res.status, 401);
    assert.equal(res.body.error, "DEVICE_KEY_INVALID");
    assert.equal(res.body.token, undefined);
  });

  it("refuses when the configured account does not exist", async () => {
    configure(keyHash, "nobody@test.local");
    const res = await request(app).post("/auth/device/key").send({ key });
    assert.equal(res.status, 404);
    assert.equal(res.body.error, "DEVICE_KEY_USER_NOT_FOUND");
  });
});
