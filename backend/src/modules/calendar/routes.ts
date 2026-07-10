import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/permissions.js";
import { DETECT_OVERLOAD_ACTION, SUGGEST_SCHEDULE_ACTION } from "../../lib/actionContracts.js";
import * as calendarService from "../../services/calendarService.js";

export const calendarRouter = Router();

calendarRouter.use(requireAuth);

const jobsQuerySchema = z.object({
  from: z.string().datetime(),
  to: z.string().datetime(),
});

// Real agenda of planned jobs in a date window — the data behind a calendar view.
calendarRouter.get("/jobs", requirePermission("crm.read"), async (req, res) => {
  const parsed = jobsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "VALIDATION_FAILED", message: parsed.error.message });
  }
  const jobs = await calendarService.getCalendarJobs(req.user!, {
    from: new Date(parsed.data.from),
    to: new Date(parsed.data.to),
  });
  res.json(jobs);
});

// detect_overload — Action Contract driven, read-only.
calendarRouter.get("/overload", requirePermission(DETECT_OVERLOAD_ACTION.requiredPermission), async (req, res) => {
  const weeksAhead = req.query.weeks_ahead ? Number(req.query.weeks_ahead) : undefined;
  const report = await calendarService.detectUpcomingOverload(req.user!, weeksAhead);
  res.json(report);
});

const suggestSchema = z.object({
  estimated_duration_hours: z.coerce.number().positive().nullable().optional(),
  required_skills: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : [])),
  weeks_ahead: z.coerce.number().int().positive().optional(),
});

// suggest_schedule — Action Contract driven, read-only.
calendarRouter.get("/suggest", requirePermission(SUGGEST_SCHEDULE_ACTION.requiredPermission), async (req, res) => {
  const parsed = suggestSchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "VALIDATION_FAILED", message: parsed.error.message });
  }
  const suggestions = await calendarService.suggestEmployeesForJob(req.user!, {
    estimatedDurationHours: parsed.data.estimated_duration_hours ?? null,
    requiredSkills: parsed.data.required_skills,
    weeksAhead: parsed.data.weeks_ahead,
  });
  res.json(suggestions);
});
