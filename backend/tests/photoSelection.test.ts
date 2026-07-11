import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import request from "supertest";
import { createServer } from "../src/server.js";
import { prisma } from "../src/db.js";
import { resetDb, seedCompanyAndAdmin, TEST_COMPANY_ID } from "./setup.js";

const app = createServer();

async function loginAs(email: string) {
  const response = await request(app).post("/auth/login").send({ email, password: "Password123!" });
  return response.body.token as string;
}

describe("Photo selection by Service Catalogue item", () => {
  let adminToken: string;
  let workerToken: string;
  let serviceId: string;
  let jobId: string;
  let linkedPhotoId: string;
  let taggedPhotoId: string;
  let blockedPhotoId: string;
  let clientProvidedPhotoId: string;
  let irrelevantPhotoId: string;

  async function logPhoto(data: Record<string, unknown>) {
    const response = await request(app)
      .post("/portfolio")
      .set("Authorization", `Bearer ${adminToken}`)
      .send(data);
    assert.equal(response.status, 201);
    return response.body.id as string;
  }

  before(async () => {
    await resetDb();
    await seedCompanyAndAdmin();
    adminToken = await loginAs("admin@test.local");
    workerToken = await loginAs("worker@test.local");

    const service = await request(app)
      .post("/service-catalogue")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Kitchen refit", category: "Renovation" });
    serviceId = service.body.id;

    const client = await request(app)
      .post("/crm/clients")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ display_name: "Photo Selection Client" });
    const job = await request(app)
      .post("/crm/jobs")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        client_id: client.body.id,
        job_title: "Confirmed kitchen project",
        service_catalogue_item_id: serviceId,
      });
    jobId = job.body.id;

    const reviewed = {
      taken_at: "2026-06-01T12:00:00.000Z",
      usable_for_marketing: true,
      quality_review_status: "approved",
      duplicate_review_status: "unique",
      sensitive_data_review_status: "clear",
      usage_permission_status: "not_required",
    };
    linkedPhotoId = await logPhoto({
      ...reviewed,
      job_id: jobId,
      filename: "linked-kitchen.jpg",
      source: "employee_upload",
    });
    taggedPhotoId = await logPhoto({
      ...reviewed,
      filename: "tagged-kitchen.jpg",
      tags: ["KITCHEN REFIT"],
      source: "before_after",
    });
    blockedPhotoId = await logPhoto({
      job_id: jobId,
      filename: "unreviewed-kitchen.jpg",
      source: "employee_upload",
    });
    clientProvidedPhotoId = await logPhoto({
      ...reviewed,
      filename: "client-kitchen.jpg",
      tags: ["Kitchen refit"],
      source: "client_provided",
      usage_permission_status: "confirmed",
    });
    irrelevantPhotoId = await logPhoto({
      ...reviewed,
      filename: "kitchen-substring-only.jpg",
      tags: ["kitchen"],
      source: "employee_upload",
    });
  });

  after(async () => {
    await resetDb();
    await prisma.$disconnect();
  });

  it("requires crm.read for candidate discovery and crm.manage for selection", async () => {
    const read = await request(app)
      .get(`/portfolio/service-selection/workspace?service_catalogue_item_id=${serviceId}`)
      .set("Authorization", `Bearer ${workerToken}`);
    assert.equal(read.status, 403);

    const write = await request(app)
      .post("/portfolio/service-selection")
      .set("Authorization", `Bearer ${workerToken}`)
      .send({ service_catalogue_item_id: serviceId, photo_ids: [] });
    assert.equal(write.status, 403);
  });

  it("derives candidates only from linked jobs or exact tags and reports review blockers", async () => {
    const response = await request(app)
      .get(`/portfolio/service-selection/workspace?service_catalogue_item_id=${serviceId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    assert.equal(response.status, 200);
    const ids = response.body.candidates.map((candidate: any) => candidate.photo.id);
    assert.ok(ids.includes(linkedPhotoId));
    assert.ok(ids.includes(taggedPhotoId));
    assert.ok(ids.includes(blockedPhotoId));
    assert.ok(ids.includes(clientProvidedPhotoId));
    assert.ok(!ids.includes(irrelevantPhotoId));

    const linked = response.body.candidates.find((candidate: any) => candidate.photo.id === linkedPhotoId);
    assert.deepEqual(linked.reasons, ["linked_job_service"]);
    assert.equal(linked.eligible, true);

    const blocked = response.body.candidates.find((candidate: any) => candidate.photo.id === blockedPhotoId);
    assert.ok(blocked.blockers.includes("MARKETING_USE_NOT_APPROVED"));
    assert.ok(blocked.blockers.includes("TAKEN_DATE_MISSING"));
    assert.ok(blocked.blockers.includes("QUALITY_NOT_APPROVED"));

    const clientProvided = response.body.candidates.find(
      (candidate: any) => candidate.photo.id === clientProvidedPhotoId
    );
    assert.ok(clientProvided.blockers.includes("OWN_PRODUCTION_SOURCE_REQUIRED"));
    assert.equal(response.body.limitations.automatedVisualReviewPerformed, false);
    assert.equal(response.body.limitations.publishingAvailable, false);
  });

  it("can include a permission-confirmed client photo only when own-production is not required", async () => {
    const response = await request(app)
      .get(
        `/portfolio/service-selection/workspace?service_catalogue_item_id=${serviceId}&own_production_only=false`
      )
      .set("Authorization", `Bearer ${adminToken}`);
    assert.equal(response.status, 200);
    const candidate = response.body.candidates.find((item: any) => item.photo.id === clientProvidedPhotoId);
    assert.equal(candidate.eligible, true);
  });

  it("blocks unreviewed photos before confirmation and writes no selection", async () => {
    const response = await request(app)
      .post("/portfolio/service-selection")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ service_catalogue_item_id: serviceId, photo_ids: [blockedPhotoId] });
    assert.equal(response.status, 400);
    assert.equal(response.body.error, "PHOTO_SELECTION_BLOCKED");
    assert.equal(await prisma.photoServiceSelection.count(), 0);
  });

  it("returns an exact confirmation preview and makes no change on the first request", async () => {
    const response = await request(app)
      .post("/portfolio/service-selection")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        service_catalogue_item_id: serviceId,
        photo_ids: [linkedPhotoId, taggedPhotoId],
        review_notes: "Checked against the original files",
      });
    assert.equal(response.status, 409);
    assert.equal(response.body.error, "CONFIRMATION_REQUIRED");
    assert.deepEqual(response.body.preview.addedPhotoIds.sort(), [linkedPhotoId, taggedPhotoId].sort());
    assert.equal(response.body.preview.publicationWillOccur, false);
    assert.equal(await prisma.photoServiceSelection.count(), 0);
  });

  it("confirms atomically, stores an evidence snapshot and performs no publication", async () => {
    const beforePhoto = await prisma.portfolioPhoto.findUniqueOrThrow({ where: { id: linkedPhotoId } });
    const response = await request(app)
      .post("/portfolio/service-selection")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        service_catalogue_item_id: serviceId,
        photo_ids: [linkedPhotoId, taggedPhotoId],
        review_notes: "Checked against the original files",
        confirmed: true,
      });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.selectedPhotoIds.sort(), [linkedPhotoId, taggedPhotoId].sort());

    const selections = await prisma.photoServiceSelection.findMany({ where: { isSelected: true } });
    assert.equal(selections.length, 2);
    assert.deepEqual((selections.find((selection) => selection.portfolioPhotoId === linkedPhotoId)?.evidenceSnapshot as any).reasons, [
      "linked_job_service",
    ]);
    assert.equal(await prisma.websiteContentProposal.count(), 0);
    const afterPhoto = await prisma.portfolioPhoto.findUniqueOrThrow({ where: { id: linkedPhotoId } });
    assert.equal(afterPhoto.updatedAt.toISOString(), beforePhoto.updatedAt.toISOString());

    const audit = await prisma.auditLog.findFirst({
      where: { actionName: "select_photos_for_service", result: "success" },
      orderBy: { createdAt: "desc" },
    });
    assert.equal(audit?.riskLevel, 2);
    assert.equal(audit?.confirmationRequired, true);
    assert.equal(audit?.confirmed, true);
  });

  it("treats a confirmed request as the exact set and safely deselects removed references", async () => {
    const preview = await request(app)
      .post("/portfolio/service-selection")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ service_catalogue_item_id: serviceId, photo_ids: [taggedPhotoId] });
    assert.equal(preview.status, 409);
    assert.deepEqual(preview.body.preview.removedPhotoIds, [linkedPhotoId]);

    const confirmed = await request(app)
      .post("/portfolio/service-selection")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ service_catalogue_item_id: serviceId, photo_ids: [taggedPhotoId], confirmed: true });
    assert.equal(confirmed.status, 200);
    assert.deepEqual(confirmed.body.selectedPhotoIds, [taggedPhotoId]);
    assert.equal(
      (await prisma.photoServiceSelection.findUniqueOrThrow({
        where: {
          serviceCatalogueItemId_portfolioPhotoId: {
            serviceCatalogueItemId: serviceId,
            portfolioPhotoId: linkedPhotoId,
          },
        },
      })).isSelected,
      false
    );
  });

  it("does not expose or select another company's service or photograph", async () => {
    const otherCompany = await prisma.company.create({ data: { name: "Other Company" } });
    const otherService = await prisma.serviceCatalogueItem.create({
      data: { companyId: otherCompany.id, name: "Other service" },
    });
    const otherPhoto = await prisma.portfolioPhoto.create({
      data: {
        companyId: otherCompany.id,
        filename: "other-company.jpg",
        source: "employee_upload",
        tags: ["Kitchen refit"],
      },
    });

    const hiddenService = await request(app)
      .get(`/portfolio/service-selection/workspace?service_catalogue_item_id=${otherService.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    assert.equal(hiddenService.status, 404);

    const hiddenPhoto = await request(app)
      .post("/portfolio/service-selection")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ service_catalogue_item_id: serviceId, photo_ids: [otherPhoto.id], confirmed: true });
    assert.equal(hiddenPhoto.status, 404);
    assert.equal(hiddenPhoto.body.error, "PORTFOLIO_PHOTO_NOT_FOUND");
    assert.equal(
      await prisma.photoServiceSelection.count({ where: { companyId: TEST_COMPANY_ID, portfolioPhotoId: otherPhoto.id } }),
      0
    );
  });
});
