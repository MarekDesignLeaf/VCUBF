import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import request from "supertest";
import { createServer } from "../src/server.js";
import { prisma } from "../src/db.js";
import { resetDb, seedCompanyAndAdmin, TEST_COMPANY_ID } from "./setup.js";

const app = createServer();
async function loginAs(email: string) {
  const res = await request(app).post("/auth/login").send({ email, password: "Password123!" });
  return res.body.token as string;
}

describe("Idempotency-Key middleware (CON-012 / OAS-001)", () => {
  let token: string;
  before(async () => { await resetDb(); await seedCompanyAndAdmin(); token = await loginAs("admin@test.local"); });
  after(async () => { await resetDb(); await prisma.$disconnect(); });

  it("replays the original response for the same key + same body and creates the client once", async () => {
    const body = { display_name: "Idem Client", email_primary: "idem@example.com" };
    const first = await request(app).post("/crm/clients").set("Authorization", `Bearer ${token}`).set("Idempotency-Key", "k-1").send(body);
    assert.equal(first.status, 201);
    const second = await request(app).post("/crm/clients").set("Authorization", `Bearer ${token}`).set("Idempotency-Key", "k-1").send(body);
    assert.equal(second.status, 201);
    assert.equal(second.headers["idempotency-replayed"], "true");
    assert.deepEqual(second.body, first.body);
    assert.equal(await prisma.client.count({ where: { companyId: TEST_COMPANY_ID, displayName: "Idem Client" } }), 1);
  });

  it("rejects the same key with a different body (422)", async () => {
    const res = await request(app).post("/crm/clients").set("Authorization", `Bearer ${token}`).set("Idempotency-Key", "k-1").send({ display_name: "Other" });
    assert.equal(res.status, 422);
    assert.equal(res.body.code, "IDEMPOTENCY_KEY_REUSED");
  });

  it("treats key order in the body as the same request", async () => {
    const a = await request(app).post("/crm/clients").set("Authorization", `Bearer ${token}`).set("Idempotency-Key", "k-2").send({ display_name: "Order", email_primary: "o@example.com" });
    const b = await request(app).post("/crm/clients").set("Authorization", `Bearer ${token}`).set("Idempotency-Key", "k-2").send({ email_primary: "o@example.com", display_name: "Order" });
    assert.equal(a.status, 201); assert.equal(b.status, 201); assert.equal(b.headers["idempotency-replayed"], "true");
  });

  it("does not memoise a validation failure differently from success semantics: 4xx is replayed, 5xx is not stored", async () => {
    const bad = await request(app).post("/crm/clients").set("Authorization", `Bearer ${token}`).set("Idempotency-Key", "k-3").send({});
    assert.ok(bad.status >= 400 && bad.status < 500);
    const row = await prisma.idempotencyKey.findUnique({ where: { companyId_key: { companyId: TEST_COMPANY_ID, key: "k-3" } } });
    assert.equal(row?.state, "COMPLETED");
  });

  it("GET requests never touch the idempotency store", async () => {
    const before = await prisma.idempotencyKey.count();
    const res = await request(app).get("/crm/clients").set("Authorization", `Bearer ${token}`).set("Idempotency-Key", "k-get");
    assert.equal(res.status, 200);
    assert.equal(await prisma.idempotencyKey.count(), before);
  });
});
