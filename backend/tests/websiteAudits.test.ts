import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import request from "supertest";
import bcrypt from "bcryptjs";
import { createServer } from "../src/server.js";
import { prisma } from "../src/db.js";
import { resetDb, seedCompanyAndAdmin } from "./setup.js";

const app = createServer();

async function loginAs(email: string) {
  const res = await request(app).post("/auth/login").send({ email, password: "Password123!" });
  return res.body.token as string;
}

describe("Basic Website Audit", () => {
  let adminToken: string;
  let workerToken: string;
  let gapAuditId: string;
  let evidenceAuditId: string;

  before(async () => {
    await resetDb();
    await seedCompanyAndAdmin();
    adminToken = await loginAs("admin@test.local");
    workerToken = await loginAs("worker@test.local");
  });

  after(async () => {
    await resetDb();
    await prisma.$disconnect();
  });

  it("requires crm.manage to create an audit", async () => {
    const res = await request(app)
      .post("/website-audits")
      .set("Authorization", `Bearer ${workerToken}`)
      .send({ website_url: "https://example.com", pages: [{ url: "https://example.com" }] });
    assert.equal(res.status, 403);
  });

  it("requires crm.read to list audits", async () => {
    const res = await request(app)
      .get("/website-audits")
      .set("Authorization", `Bearer ${workerToken}`);
    assert.equal(res.status, 403);
  });

  it("rejects non-http URLs and page observations from another origin", async () => {
    const badProtocol = await request(app)
      .post("/website-audits")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ website_url: "ftp://example.com", pages: [{ url: "ftp://example.com" }] });
    assert.equal(badProtocol.status, 400);
    assert.equal(badProtocol.body.error, "VALIDATION_FAILED");

    const wrongOrigin = await request(app)
      .post("/website-audits")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ website_url: "https://example.com", pages: [{ url: "https://other.example/page" }] });
    assert.equal(wrongOrigin.status, 400);
    assert.equal(wrongOrigin.body.error, "VALIDATION_FAILED");
  });

  it("reports internal data gaps without treating unobserved page fields as missing", async () => {
    const res = await request(app)
      .post("/website-audits")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        website_url: "https://example.com",
        notes: "Only the home page URL was recorded; all checks remain unknown.",
        pages: [{ url: "https://example.com/" }],
      });

    assert.equal(res.status, 201);
    assert.equal(res.body.pageCount, 1);
    assert.equal(res.body.findingCount, 3);
    assert.equal(res.body.warningCount, 2);
    assert.equal(res.body.infoCount, 1);
    assert.ok(res.body.findings.some((finding: any) => finding.title === "Service Catalogue is empty"));
    assert.ok(res.body.findings.some((finding: any) => finding.title === "No confirmed Business Context is available"));
    assert.ok(res.body.findings.some((finding: any) => finding.title === "No reviewed marketing photographs are available"));
    assert.ok(!res.body.findings.some((finding: any) => finding.category === "contact"));
    assert.ok(!res.body.findings.some((finding: any) => finding.category === "form"));
    gapAuditId = res.body.id;
  });

  it("creates evidence-backed findings from observations and real Secretary records", async () => {
    const company = await prisma.company.findFirstOrThrow({ where: { name: "Test Co" } });
    const admin = await prisma.user.findFirstOrThrow({ where: { email: "admin@test.local" } });
    await prisma.serviceCatalogueItem.createMany({
      data: [
        { companyId: company.id, name: "Painting", createdBy: admin.id },
        { companyId: company.id, name: "Roofing", createdBy: admin.id },
      ],
    });
    await prisma.businessContextItem.create({
      data: {
        companyId: company.id,
        category: "company_profile",
        label: "Trading name",
        value: "Test Co",
        verificationStatus: "confirmed",
        createdBy: admin.id,
      },
    });
    await prisma.portfolioPhoto.create({
      data: {
        companyId: company.id,
        filename: "real-project.jpg",
        source: "employee_upload",
        usableForMarketing: true,
        usableForMarketingNotes: "Approved by owner",
        createdBy: admin.id,
      },
    });

    const res = await request(app)
      .post("/website-audits")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        website_url: "https://example.com",
        pages: [
          {
            url: "https://example.com/",
            status_code: 503,
            title: "",
            has_contact_details: false,
            has_contact_form: false,
            has_service_content: false,
            photo_count: 0,
            service_names: ["Painting"],
            broken_links: ["https://example.com/broken"],
          },
        ],
      });

    assert.equal(res.status, 201);
    assert.equal(res.body.findingCount, 8);
    assert.equal(res.body.urgentCount, 1);
    assert.equal(res.body.warningCount, 6);
    assert.equal(res.body.infoCount, 1);
    assert.ok(res.body.findings.some((finding: any) => finding.title === "Page returned HTTP 503"));
    assert.ok(res.body.findings.some((finding: any) => finding.title === "Contact details were not found"));
    assert.ok(res.body.findings.some((finding: any) => finding.title === "Service not observed on website: Roofing"));
    assert.ok(!res.body.findings.some((finding: any) => finding.title === "Service not observed on website: Painting"));
    assert.ok(!res.body.findings.some((finding: any) => finding.title === "No confirmed Business Context is available"));
    assert.ok(!res.body.findings.some((finding: any) => finding.title === "No reviewed marketing photographs are available"));
    evidenceAuditId = res.body.id;

    const auditLog = await prisma.auditLog.findFirst({
      where: { actionName: "create_website_audit", result: "success" },
      orderBy: { createdAt: "desc" },
    });
    assert.ok(auditLog);
    assert.equal(auditLog?.riskLevel, 1);
    assert.equal((auditLog?.dataAfter as any)?.id, evidenceAuditId);
  });

  it("lists audits and returns detail with urgent findings first", async () => {
    const list = await request(app)
      .get("/website-audits")
      .set("Authorization", `Bearer ${adminToken}`);
    assert.equal(list.status, 200);
    assert.equal(list.body.length, 2);
    assert.ok(list.body.every((audit: any) => audit._count.findings === audit.findingCount));

    const detail = await request(app)
      .get(`/website-audits/${evidenceAuditId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.findings[0].severity, "urgent");
  });

  it("returns not found for an unknown audit", async () => {
    const res = await request(app)
      .get("/website-audits/00000000-0000-0000-0000-000000000099")
      .set("Authorization", `Bearer ${adminToken}`);
    assert.equal(res.status, 404);
    assert.equal(res.body.error, "WEBSITE_AUDIT_NOT_FOUND");
  });

  it("keeps audits isolated between companies", async () => {
    const companyB = await prisma.company.create({ data: { name: "Other Website Co" } });
    const passwordHash = await bcrypt.hash("Password123!", 10);
    await prisma.user.create({
      data: {
        companyId: companyB.id,
        email: "website-b@test.local",
        passwordHash,
        displayName: "Website Admin B",
        role: "admin",
        permissions: ["crm.read", "crm.manage"],
      },
    });
    const tokenB = await loginAs("website-b@test.local");

    const listB = await request(app)
      .get("/website-audits")
      .set("Authorization", `Bearer ${tokenB}`);
    assert.equal(listB.status, 200);
    assert.equal(listB.body.length, 0);

    const getB = await request(app)
      .get(`/website-audits/${gapAuditId}`)
      .set("Authorization", `Bearer ${tokenB}`);
    assert.equal(getB.status, 404);
  });
});
