import { z } from "zod";
import { prisma } from "../db.js";
import { recordAudit } from "../lib/audit.js";
import {
  CREATE_JOB_OPENING_ACTION,
  UPDATE_JOB_OPENING_ACTION,
  DRAFT_JOB_ADVERT_ACTION,
  CREATE_CANDIDATE_ACTION,
  UPDATE_CANDIDATE_ACTION,
  JOB_OPENING_STATUSES,
  JOB_OPENING_URGENCY_LEVELS,
  CANDIDATE_STAGES,
} from "../lib/actionContracts.js";
import type { AuthedUser } from "../middleware/auth.js";
import { fail, ok, type ServiceResult } from "./result.js";

// Recruitment and Workforce Expansion Module. Every field is what the user
// typed in — reason, urgency, required skills, experience and language
// requirements are never invented. This module never legally hires anyone,
// never sets a wage, and never confirms employment terms; it only tracks
// openings/candidates and drafts content for the user to review and place
// manually (no job-board connector exists).

export const createJobOpeningSchema = z.object({
  title: z.string().min(1, "title is required"),
  reason: z.string().optional(),
  urgency: z.enum(JOB_OPENING_URGENCY_LEVELS).default("medium"),
  skills_required: z.array(z.string()).optional(),
  expected_tasks: z.string().optional(),
  min_experience_years: z.number().nonnegative().optional(),
  preferred_experience_years: z.number().nonnegative().optional(),
  language_requirements: z.array(z.string()).optional(),
  availability_requirements: z.string().optional(),
  description: z.string().optional(),
});

export const updateJobOpeningSchema = z.object({
  title: z.string().min(1).optional(),
  reason: z.string().optional(),
  urgency: z.enum(JOB_OPENING_URGENCY_LEVELS).optional(),
  opening_status: z.enum(JOB_OPENING_STATUSES).optional(),
  skills_required: z.array(z.string()).optional(),
  expected_tasks: z.string().optional(),
  min_experience_years: z.number().nonnegative().nullable().optional(),
  preferred_experience_years: z.number().nonnegative().nullable().optional(),
  language_requirements: z.array(z.string()).optional(),
  availability_requirements: z.string().optional(),
  description: z.string().optional(),
});

export const createCandidateSchema = z.object({
  name: z.string().min(1, "name is required"),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  notes: z.string().optional(),
});

export const updateCandidateSchema = z.object({
  name: z.string().min(1).optional(),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  stage: z.enum(CANDIDATE_STAGES).optional(),
  notes: z.string().optional(),
});

const jobOpeningInclude = { candidates: { orderBy: { createdAt: "desc" as const } } };

export async function listJobOpenings(user: AuthedUser, filters: { status?: string } = {}) {
  return prisma.jobOpening.findMany({
    where: { companyId: user.companyId, ...(filters.status ? { openingStatus: filters.status } : {}) },
    include: jobOpeningInclude,
    orderBy: { createdAt: "desc" },
  });
}

export async function getJobOpening(user: AuthedUser, id: string) {
  return prisma.jobOpening.findFirst({ where: { id, companyId: user.companyId }, include: jobOpeningInclude });
}

export async function findJobOpeningsByTitle(user: AuthedUser, title: string) {
  return prisma.jobOpening.findMany({
    where: { companyId: user.companyId, title: { contains: title, mode: "insensitive" } },
  });
}

// create_job_opening — Action Contract driven.
export async function createJobOpening(user: AuthedUser, rawInput: unknown): Promise<ServiceResult<unknown>> {
  const parsed = createJobOpeningSchema.safeParse(rawInput);
  if (!parsed.success) {
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: CREATE_JOB_OPENING_ACTION.actionName,
      inputPayload: rawInput,
      riskLevel: CREATE_JOB_OPENING_ACTION.riskLevel,
      confirmationRequired: CREATE_JOB_OPENING_ACTION.confirmationRequired,
      result: "error",
      errorMessage: "VALIDATION_FAILED",
    });
    return fail(400, "VALIDATION_FAILED", parsed.error.message);
  }
  const data = parsed.data;

  const created = await prisma.jobOpening.create({
    data: {
      companyId: user.companyId,
      title: data.title,
      reason: data.reason,
      urgency: data.urgency,
      skillsRequired: data.skills_required ?? [],
      expectedTasks: data.expected_tasks,
      minExperienceYears: data.min_experience_years,
      preferredExperienceYears: data.preferred_experience_years,
      languageRequirements: data.language_requirements ?? [],
      availabilityRequirements: data.availability_requirements,
      description: data.description,
      createdBy: user.id,
    },
    include: jobOpeningInclude,
  });

  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: CREATE_JOB_OPENING_ACTION.actionName,
    inputPayload: data,
    dataAfter: created,
    riskLevel: CREATE_JOB_OPENING_ACTION.riskLevel,
    confirmationRequired: CREATE_JOB_OPENING_ACTION.confirmationRequired,
    result: "success",
  });

  return ok(201, created);
}

// update_job_opening — Action Contract driven. Also the only way an opening
// moves between draft/open/closed — a status change is just a field update,
// not a separate action, matching the service-catalogue update pattern.
export async function updateJobOpening(user: AuthedUser, id: string, rawInput: unknown): Promise<ServiceResult<unknown>> {
  const parsed = updateJobOpeningSchema.safeParse(rawInput);
  if (!parsed.success) {
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: UPDATE_JOB_OPENING_ACTION.actionName,
      inputPayload: { id, ...(typeof rawInput === "object" && rawInput ? rawInput : {}) },
      riskLevel: UPDATE_JOB_OPENING_ACTION.riskLevel,
      confirmationRequired: UPDATE_JOB_OPENING_ACTION.confirmationRequired,
      result: "error",
      errorMessage: "VALIDATION_FAILED",
    });
    return fail(400, "VALIDATION_FAILED", parsed.error.message);
  }
  const data = parsed.data;

  const existing = await prisma.jobOpening.findFirst({ where: { id, companyId: user.companyId } });
  if (!existing) {
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: UPDATE_JOB_OPENING_ACTION.actionName,
      inputPayload: { id, ...data },
      riskLevel: UPDATE_JOB_OPENING_ACTION.riskLevel,
      confirmationRequired: UPDATE_JOB_OPENING_ACTION.confirmationRequired,
      result: "error",
      errorMessage: "JOB_OPENING_NOT_FOUND",
    });
    return fail(404, "JOB_OPENING_NOT_FOUND");
  }

  const changes: Record<string, unknown> = {};
  if (data.title !== undefined) changes.title = data.title;
  if (data.reason !== undefined) changes.reason = data.reason;
  if (data.urgency !== undefined) changes.urgency = data.urgency;
  if (data.opening_status !== undefined) changes.openingStatus = data.opening_status;
  if (data.skills_required !== undefined) changes.skillsRequired = data.skills_required;
  if (data.expected_tasks !== undefined) changes.expectedTasks = data.expected_tasks;
  if (data.min_experience_years !== undefined) changes.minExperienceYears = data.min_experience_years;
  if (data.preferred_experience_years !== undefined) changes.preferredExperienceYears = data.preferred_experience_years;
  if (data.language_requirements !== undefined) changes.languageRequirements = data.language_requirements;
  if (data.availability_requirements !== undefined) changes.availabilityRequirements = data.availability_requirements;
  if (data.description !== undefined) changes.description = data.description;

  const updated = await prisma.jobOpening.update({ where: { id: existing.id }, data: changes, include: jobOpeningInclude });

  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: UPDATE_JOB_OPENING_ACTION.actionName,
    inputPayload: { id, changes },
    dataBefore: existing,
    dataAfter: updated,
    riskLevel: UPDATE_JOB_OPENING_ACTION.riskLevel,
    confirmationRequired: UPDATE_JOB_OPENING_ACTION.confirmationRequired,
    result: "success",
  });

  return ok(200, updated);
}

// Pure template — every sentence is built only from fields the opening
// actually has. Missing fields are stated as missing, not filled in, and
// nothing about pay or terms is ever generated (per "do not promise wages").
export function buildAdvertText(opening: {
  title: string;
  reason: string | null;
  skillsRequired: string[];
  expectedTasks: string | null;
  minExperienceYears: number | null;
  preferredExperienceYears: number | null;
  languageRequirements: string[];
  availabilityRequirements: string | null;
  description: string | null;
}): string {
  const lines: string[] = [];
  lines.push(`We're hiring: ${opening.title}`);
  lines.push("");
  lines.push(opening.description ? opening.description : "(No role description entered yet.)");
  lines.push("");
  if (opening.expectedTasks) {
    lines.push(`What you'll do: ${opening.expectedTasks}`);
  }
  if (opening.skillsRequired.length > 0) {
    lines.push(`Skills required: ${opening.skillsRequired.join(", ")}`);
  } else {
    lines.push("Skills required: not specified yet.");
  }
  if (opening.minExperienceYears != null || opening.preferredExperienceYears != null) {
    const min = opening.minExperienceYears != null ? `${opening.minExperienceYears}+ years minimum` : null;
    const preferred = opening.preferredExperienceYears != null ? `${opening.preferredExperienceYears}+ years preferred` : null;
    lines.push(`Experience: ${[min, preferred].filter(Boolean).join(", ")}`);
  }
  if (opening.languageRequirements.length > 0) {
    lines.push(`Languages required: ${opening.languageRequirements.join(", ")}`);
  }
  if (opening.availabilityRequirements) {
    lines.push(`Availability: ${opening.availabilityRequirements}`);
  }
  lines.push("");
  lines.push(
    "(Draft only — pay, benefits and employment terms are deliberately not included here; add them yourself before placing this advert, and confirm terms with the candidate directly before any offer.)"
  );
  return lines.join("\n");
}

// draft_job_advert — Action Contract driven. Drafting only; never publishes.
export async function draftJobAdvert(user: AuthedUser, id: string): Promise<ServiceResult<unknown>> {
  const existing = await prisma.jobOpening.findFirst({ where: { id, companyId: user.companyId } });
  if (!existing) {
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: DRAFT_JOB_ADVERT_ACTION.actionName,
      inputPayload: { id },
      riskLevel: DRAFT_JOB_ADVERT_ACTION.riskLevel,
      confirmationRequired: DRAFT_JOB_ADVERT_ACTION.confirmationRequired,
      result: "error",
      errorMessage: "JOB_OPENING_NOT_FOUND",
    });
    return fail(404, "JOB_OPENING_NOT_FOUND");
  }

  const advertText = buildAdvertText(existing);
  const updated = await prisma.jobOpening.update({
    where: { id: existing.id },
    data: { draftAdvertText: advertText },
    include: jobOpeningInclude,
  });

  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: DRAFT_JOB_ADVERT_ACTION.actionName,
    inputPayload: { id },
    dataBefore: { draftAdvertText: existing.draftAdvertText },
    dataAfter: { draftAdvertText: advertText },
    riskLevel: DRAFT_JOB_ADVERT_ACTION.riskLevel,
    confirmationRequired: DRAFT_JOB_ADVERT_ACTION.confirmationRequired,
    result: "success",
  });

  return ok(200, updated);
}

// create_candidate — Action Contract driven.
export async function createCandidate(user: AuthedUser, jobOpeningId: string, rawInput: unknown): Promise<ServiceResult<unknown>> {
  const parsed = createCandidateSchema.safeParse(rawInput);
  if (!parsed.success) {
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: CREATE_CANDIDATE_ACTION.actionName,
      inputPayload: { jobOpeningId, ...(typeof rawInput === "object" && rawInput ? rawInput : {}) },
      riskLevel: CREATE_CANDIDATE_ACTION.riskLevel,
      confirmationRequired: CREATE_CANDIDATE_ACTION.confirmationRequired,
      result: "error",
      errorMessage: "VALIDATION_FAILED",
    });
    return fail(400, "VALIDATION_FAILED", parsed.error.message);
  }
  const data = parsed.data;

  const opening = await prisma.jobOpening.findFirst({ where: { id: jobOpeningId, companyId: user.companyId } });
  if (!opening) {
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: CREATE_CANDIDATE_ACTION.actionName,
      inputPayload: { jobOpeningId, ...data },
      riskLevel: CREATE_CANDIDATE_ACTION.riskLevel,
      confirmationRequired: CREATE_CANDIDATE_ACTION.confirmationRequired,
      result: "error",
      errorMessage: "JOB_OPENING_NOT_FOUND",
    });
    return fail(404, "JOB_OPENING_NOT_FOUND");
  }

  const created = await prisma.candidate.create({
    data: {
      companyId: user.companyId,
      jobOpeningId,
      name: data.name,
      email: data.email,
      phone: data.phone,
      notes: data.notes,
      createdBy: user.id,
    },
  });

  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: CREATE_CANDIDATE_ACTION.actionName,
    inputPayload: { jobOpeningId, ...data },
    dataAfter: created,
    riskLevel: CREATE_CANDIDATE_ACTION.riskLevel,
    confirmationRequired: CREATE_CANDIDATE_ACTION.confirmationRequired,
    result: "success",
  });

  return ok(201, created);
}

// update_candidate — Action Contract driven. Moving to "hired" is still only
// a pipeline record; it does not create a user account or confirm terms.
export async function updateCandidate(user: AuthedUser, candidateId: string, rawInput: unknown): Promise<ServiceResult<unknown>> {
  const parsed = updateCandidateSchema.safeParse(rawInput);
  if (!parsed.success) {
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: UPDATE_CANDIDATE_ACTION.actionName,
      inputPayload: { candidateId, ...(typeof rawInput === "object" && rawInput ? rawInput : {}) },
      riskLevel: UPDATE_CANDIDATE_ACTION.riskLevel,
      confirmationRequired: UPDATE_CANDIDATE_ACTION.confirmationRequired,
      result: "error",
      errorMessage: "VALIDATION_FAILED",
    });
    return fail(400, "VALIDATION_FAILED", parsed.error.message);
  }
  const data = parsed.data;

  const existing = await prisma.candidate.findFirst({ where: { id: candidateId, companyId: user.companyId } });
  if (!existing) {
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: UPDATE_CANDIDATE_ACTION.actionName,
      inputPayload: { candidateId, ...data },
      riskLevel: UPDATE_CANDIDATE_ACTION.riskLevel,
      confirmationRequired: UPDATE_CANDIDATE_ACTION.confirmationRequired,
      result: "error",
      errorMessage: "CANDIDATE_NOT_FOUND",
    });
    return fail(404, "CANDIDATE_NOT_FOUND");
  }

  const changes: Record<string, unknown> = {};
  if (data.name !== undefined) changes.name = data.name;
  if (data.email !== undefined) changes.email = data.email;
  if (data.phone !== undefined) changes.phone = data.phone;
  if (data.stage !== undefined) changes.stage = data.stage;
  if (data.notes !== undefined) changes.notes = data.notes;

  const updated = await prisma.candidate.update({ where: { id: existing.id }, data: changes });

  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: UPDATE_CANDIDATE_ACTION.actionName,
    inputPayload: { candidateId, changes },
    dataBefore: existing,
    dataAfter: updated,
    riskLevel: UPDATE_CANDIDATE_ACTION.riskLevel,
    confirmationRequired: UPDATE_CANDIDATE_ACTION.confirmationRequired,
    result: "success",
  });

  return ok(200, updated);
}
