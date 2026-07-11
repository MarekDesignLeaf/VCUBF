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

describe("Website Content Proposal and Approval Workflow", () => {
  let adminToken: string;
  let workerToken: string;
  let companyId: string;
  let adminId: string;
  let contextId: string;
  let serviceId: string;
  let photoId: string;
  let auditId: string;
  let findingId: string;
  let proposalId: string;

  before(async () => {
    await resetDb();
    const seeded = await seedCompanyAndAdmin();
    companyId = seeded.company.id;
    adminId = seeded.admin.id;
    adminToken = await loginAs("admin@test.local");
    workerToken = await loginAs("worker@test.local");

    const context = await prisma.businessContextItem.create({
      data: {
        companyId,
        category: "company_profile",
        label: "Trading name",
        value: "Test Co",
        verificationStatus: "confirmed",
        createdBy: adminId,
      },
    });
    contextId = context.id;
    const service = await prisma.serviceCatalogueItem.create({
      data: {
        companyId,
        name: "Roofing",
        description: "Roof repairs and replacement",
        createdBy: adminId,
      },
    });
    serviceId = service.id;
    const photo = await prisma.portfolioPhoto.create({
      data: {
        companyId,
        filename: "roof-project.jpg",
        caption: "Completed roof project",
        source: "employee_upload",
        takenAt: new Date("2026-06-01T12:00:00.000Z"),
        usableForMarketing: true,
        usableForMarketingNotes: "Owner approved",
        qualityReviewStatus: "approved",
        duplicateReviewStatus: "unique",
        sensitiveDataReviewStatus: "clear",
        usagePermissionStatus: "not_required",
        createdBy: adminId,
      },
    });
    photoId = photo.id;
    const audit = await prisma.websiteAudit.create({
      data: {
        companyId,
        websiteUrl: "https://example.com",
        observations: [{ url: "https://example.com/services" }],
        pageCount: 1,
        findingCount: 1,
        urgentCount: 0,
        warningCount: 1,
        infoCount: 0,
        createdBy: adminId,
        findings: {
          create: {
            companyId,
            category: "missing_service_page",
            severity: "warning",
            title: "Service not observed on website: Roofing",
            evidence: `Active Service Catalogue item Roofing (${service.id}) was not listed.`,
            recommendation: "Prepare a Roofing service page from verified catalogue data.",
            sourceType: "service_catalogue",
            sourceRecordId: service.id,
          },
        },
      },
      include: { findings: true },
    });
    auditId = audit.id;
    findingId = audit.findings[0].id;
  });

  after(async () => {
    await resetDb();
    await prisma.$disconnect();
  });

  it("requires crm.manage to prepare a proposal", async () => {
    const res = await request(app)
      .post("/website-content-proposals")
      .set("Authorization", `Bearer ${workerToken}`)
      .send({
        proposal_type: "service_page",
        target_page_url: "https://example.com/roofing",
        content_body: "Draft content",
        service_catalogue_item_ids: [serviceId],
      });
    assert.equal(res.status, 403);
  });

  it("requires crm.read to list proposals", async () => {
    const res = await request(app)
      .get("/website-content-proposals")
      .set("Authorization", `Bearer ${workerToken}`);
    assert.equal(res.status, 403);
  });

  it("requires at least one verified Secretary source", async () => {
    const res = await request(app)
      .post("/website-content-proposals")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        proposal_type: "service_page",
        target_page_url: "https://example.com/roofing",
        content_body: "Unsupported draft content",
      });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "VALIDATION_FAILED");
  });

  it("rejects unconfirmed context and an unreviewed photo as public-content sources", async () => {
    const context = await prisma.businessContextItem.create({
      data: {
        companyId,
        category: "marketing_text",
        label: "Claim",
        value: "Unverified claim",
        verificationStatus: "unverified",
        createdBy: adminId,
      },
    });
    const contextRes = await request(app)
      .post("/website-content-proposals")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        proposal_type: "other",
        target_page_url: "https://example.com/about",
        content_body: "Draft",
        business_context_ids: [context.id],
      });
    assert.equal(contextRes.status, 400);
    assert.equal(contextRes.body.error, "SOURCE_NOT_CONFIRMED");

    const photo = await prisma.portfolioPhoto.create({
      data: {
        companyId,
        filename: "unreviewed.jpg",
        source: "employee_upload",
        usableForMarketing: false,
        createdBy: adminId,
      },
    });
    const photoRes = await request(app)
      .post("/website-content-proposals")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        proposal_type: "photo_selection",
        target_page_url: "https://example.com/gallery",
        content_body: "Use selected photograph",
        portfolio_photo_ids: [photo.id],
      });
    assert.equal(photoRes.status, 400);
    assert.equal(photoRes.body.error, "SOURCE_NOT_AVAILABLE");
  });

  it("rejects a target page outside the linked audit website", async () => {
    const res = await request(app)
      .post("/website-content-proposals")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        website_audit_id: auditId,
        proposal_type: "service_page",
        target_page_url: "https://other.example/roofing",
        content_body: "Draft",
      });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "TARGET_URL_MISMATCH");
  });

  it("creates a ready-for-review proposal with an immutable evidence snapshot", async () => {
    const res = await request(app)
      .post("/website-content-proposals")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        website_audit_id: auditId,
        proposal_type: "service_page",
        target_page_url: "https://example.com/roofing",
        headline: "Roofing services",
        content_body: "Test Co provides roof repairs and replacement.",
        notes: "Prepared from confirmed records for owner review.",
        business_context_ids: [contextId],
        service_catalogue_item_ids: [serviceId],
        portfolio_photo_ids: [photoId],
        website_audit_finding_ids: [findingId],
      });

    assert.equal(res.status, 201);
    assert.equal(res.body.status, "ready_for_review");
    assert.equal(res.body.sourceSnapshot.businessContext.length, 1);
    assert.equal(res.body.sourceSnapshot.services.length, 1);
    assert.equal(res.body.sourceSnapshot.photos.length, 1);
    assert.equal(res.body.sourceSnapshot.auditFindings.length, 1);
    assert.equal(res.body.sourceSnapshot.websiteAudit.id, auditId);
    proposalId = res.body.id;

    const auditLog = await prisma.auditLog.findFirst({
      where: { actionName: "prepare_website_content_proposal", result: "success" },
      orderBy: { createdAt: "desc" },
    });
    assert.ok(auditLog);
    assert.equal(auditLog?.riskLevel, 1);
    assert.equal((auditLog?.dataAfter as any)?.id, proposalId);
  });

  it("lists and gets company proposals", async () => {
    const list = await request(app)
      .get("/website-content-proposals?status=ready_for_review")
      .set("Authorization", `Bearer ${adminToken}`);
    assert.equal(list.status, 200);
    assert.equal(list.body.length, 1);
    assert.equal(list.body[0].id, proposalId);

    const detail = await request(app)
      .get(`/website-content-proposals/${proposalId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.websiteAudit.id, auditId);
  });

  it("previews an approval without changing the proposal", async () => {
    const preview = await request(app)
      .post(`/website-content-proposals/${proposalId}/decision`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ decision: "approved", decision_notes: "Ready to publish later." });
    assert.equal(preview.status, 409);
    assert.equal(preview.body.error, "CONFIRMATION_REQUIRED");
    assert.equal(preview.body.preview.currentStatus, "ready_for_review");
    assert.equal(preview.body.preview.proposedStatus, "approved");
    assert.equal(preview.body.preview.sourceCounts.services, 1);

    const unchanged = await prisma.websiteContentProposal.findUniqueOrThrow({ where: { id: proposalId } });
    assert.equal(unchanged.status, "ready_for_review");
    assert.equal(unchanged.reviewedAt, null);
  });

  it("approves only after confirmed:true and records before/after audit evidence", async () => {
    const res = await request(app)
      .post(`/website-content-proposals/${proposalId}/decision`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ decision: "approved", decision_notes: "Approved for future publication.", confirmed: true });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, "approved");
    assert.equal(res.body.reviewedBy, adminId);
    assert.ok(res.body.reviewedAt);

    const auditLog = await prisma.auditLog.findFirst({
      where: { actionName: "decide_website_content_proposal", result: "success", confirmed: true },
      orderBy: { createdAt: "desc" },
    });
    assert.ok(auditLog);
    assert.equal((auditLog?.dataBefore as any)?.status, "ready_for_review");
    assert.equal((auditLog?.dataAfter as any)?.status, "approved");
  });

  it("cannot decide a proposal twice or use publication as a review decision", async () => {
    const twice = await request(app)
      .post(`/website-content-proposals/${proposalId}/decision`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ decision: "rejected", confirmed: true });
    assert.equal(twice.status, 409);
    assert.equal(twice.body.error, "WEBSITE_CONTENT_PROPOSAL_ALREADY_DECIDED");

    const publish = await request(app)
      .post(`/website-content-proposals/${proposalId}/decision`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ decision: "published", confirmed: true });
    assert.equal(publish.status, 400);
    assert.equal(publish.body.error, "VALIDATION_FAILED");
  });

  it("supports an explicitly confirmed rejection without publishing", async () => {
    const created = await request(app)
      .post("/website-content-proposals")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        proposal_type: "meta_description",
        target_page_url: "https://example.com/roofing",
        content_body: "Roof repairs and replacement from Test Co.",
        service_catalogue_item_ids: [serviceId],
      });
    assert.equal(created.status, 201);

    const preview = await request(app)
      .post(`/website-content-proposals/${created.body.id}/decision`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ decision: "rejected", decision_notes: "Rewrite required." });
    assert.equal(preview.status, 409);

    const rejected = await request(app)
      .post(`/website-content-proposals/${created.body.id}/decision`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ decision: "rejected", decision_notes: "Rewrite required.", confirmed: true });
    assert.equal(rejected.status, 200);
    assert.equal(rejected.body.status, "rejected");
  });

  it("keeps proposal records and source IDs isolated between companies", async () => {
    const companyB = await prisma.company.create({ data: { name: "Other Content Co" } });
    const passwordHash = await bcrypt.hash("Password123!", 10);
    const adminB = await prisma.user.create({
      data: {
        companyId: companyB.id,
        email: "content-b@test.local",
        passwordHash,
        displayName: "Content Admin B",
        role: "admin",
        permissions: ["crm.read", "crm.manage"],
      },
    });
    const contextB = await prisma.businessContextItem.create({
      data: {
        companyId: companyB.id,
        category: "company_profile",
        label: "Name",
        value: "Other Content Co",
        verificationStatus: "confirmed",
        createdBy: adminB.id,
      },
    });
    const tokenB = await loginAs("content-b@test.local");

    const foreignSource = await request(app)
      .post("/website-content-proposals")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        proposal_type: "other",
        target_page_url: "https://example.com/about",
        content_body: "Draft",
        business_context_ids: [contextB.id],
      });
    assert.equal(foreignSource.status, 400);
    assert.equal(foreignSource.body.error, "SOURCE_NOT_CONFIRMED");

    const listB = await request(app)
      .get("/website-content-proposals")
      .set("Authorization", `Bearer ${tokenB}`);
    assert.equal(listB.status, 200);
    assert.equal(listB.body.length, 0);

    const getB = await request(app)
      .get(`/website-content-proposals/${proposalId}`)
      .set("Authorization", `Bearer ${tokenB}`);
    assert.equal(getB.status, 404);
  });
});
