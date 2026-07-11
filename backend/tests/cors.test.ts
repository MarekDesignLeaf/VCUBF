import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import request from "supertest";
import { createServer } from "../src/server.js";

describe("CORS configuration", () => {
  const previousFrontendUrl = process.env.FRONTEND_URL;

  before(() => { process.env.FRONTEND_URL = "https://frontend.example"; });
  after(() => {
    if (previousFrontendUrl === undefined) delete process.env.FRONTEND_URL;
    else process.env.FRONTEND_URL = previousFrontendUrl;
  });

  it("allows the configured frontend origin", async () => {
    const response = await request(createServer()).options("/health").set("Origin", "https://frontend.example").set("Access-Control-Request-Method", "GET");
    assert.equal(response.status, 204);
    assert.equal(response.headers["access-control-allow-origin"], "https://frontend.example");
  });

  it("does not grant CORS access to an unconfigured origin", async () => {
    const response = await request(createServer()).options("/health").set("Origin", "https://untrusted.example").set("Access-Control-Request-Method", "GET");
    assert.equal(response.status, 204);
    assert.equal(response.headers["access-control-allow-origin"], undefined);
  });
});
