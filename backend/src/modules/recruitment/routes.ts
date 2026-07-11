import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/permissions.js";
import {
  CREATE_JOB_OPENING_ACTION,
  UPDATE_JOB_OPENING_ACTION,
  DRAFT_JOB_ADVERT_ACTION,
  CREATE_CANDIDATE_ACTION,
  UPDATE_CANDIDATE_ACTION,
  GET_RECRUITMENT_RECOMMENDATION_ACTION,
} from "../../lib/actionContracts.js";
import * as recruitmentService from "../../services/recruitmentService.js";

export const recruitmentRouter = Router();

recruitmentRouter.use(requireAuth);

const recommendationQuerySchema = z.object({
  weeks_ahead: z.coerce.number().int().min(2).max(26).default(6),
  minimum_repeated_weeks: z.coerce.number().int().min(2).max(8).default(2),
});

recruitmentRouter.get(
  "/capacity-recommendation",
  requirePermission(GET_RECRUITMENT_RECOMMENDATION_ACTION.requiredPermission),
  async (req, res) => {
    const parsed = recommendationQuerySchema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: "VALIDATION_FAILED", message: parsed.error.message });
    res.json(await recruitmentService.getCapacityRecruitmentRecommendation(req.user!, {
      weeksAhead: parsed.data.weeks_ahead,
      minimumRepeatedWeeks: parsed.data.minimum_repeated_weeks,
    }));
  }
);

recruitmentRouter.get("/job-openings", requirePermission("recruitment.manage"), async (req, res) => {
  const { status } = req.query;
  res.json(await recruitmentService.listJobOpenings(req.user!, { status: typeof status === "string" ? status : undefined }));
});

recruitmentRouter.get("/job-openings/:id", requirePermission("recruitment.manage"), async (req, res) => {
  const opening = await recruitmentService.getJobOpening(req.user!, req.params.id);
  if (!opening) return res.status(404).json({ error: "JOB_OPENING_NOT_FOUND" });
  res.json(opening);
});

recruitmentRouter.post("/job-openings", requirePermission(CREATE_JOB_OPENING_ACTION.requiredPermission), async (req, res) => {
  const result = await recruitmentService.createJobOpening(req.user!, req.body);
  if (!result.ok) return res.status(result.httpStatus).json({ error: result.error, message: result.message, ...result.extra });
  res.status(result.httpStatus).json(result.data);
});

recruitmentRouter.put("/job-openings/:id", requirePermission(UPDATE_JOB_OPENING_ACTION.requiredPermission), async (req, res) => {
  const result = await recruitmentService.updateJobOpening(req.user!, req.params.id, req.body);
  if (!result.ok) return res.status(result.httpStatus).json({ error: result.error, message: result.message, ...result.extra });
  res.status(result.httpStatus).json(result.data);
});

recruitmentRouter.post(
  "/job-openings/:id/draft-advert",
  requirePermission(DRAFT_JOB_ADVERT_ACTION.requiredPermission),
  async (req, res) => {
    const result = await recruitmentService.draftJobAdvert(req.user!, req.params.id);
    if (!result.ok) return res.status(result.httpStatus).json({ error: result.error, message: result.message, ...result.extra });
    res.status(result.httpStatus).json(result.data);
  }
);

recruitmentRouter.post(
  "/job-openings/:id/candidates",
  requirePermission(CREATE_CANDIDATE_ACTION.requiredPermission),
  async (req, res) => {
    const result = await recruitmentService.createCandidate(req.user!, req.params.id, req.body);
    if (!result.ok) return res.status(result.httpStatus).json({ error: result.error, message: result.message, ...result.extra });
    res.status(result.httpStatus).json(result.data);
  }
);

recruitmentRouter.put("/candidates/:id", requirePermission(UPDATE_CANDIDATE_ACTION.requiredPermission), async (req, res) => {
  const result = await recruitmentService.updateCandidate(req.user!, req.params.id, req.body);
  if (!result.ok) return res.status(result.httpStatus).json({ error: result.error, message: result.message, ...result.extra });
  res.status(result.httpStatus).json(result.data);
});
