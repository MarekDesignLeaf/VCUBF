import { createHash } from "node:crypto";
import { z } from "zod";
import { prisma } from "../db.js";
import { recordAudit } from "../lib/audit.js";
import { UPDATE_EMMA_BEHAVIOR_SCENARIO_ACTION } from "../lib/actionContracts.js";
import type { AuthedUser } from "../middleware/auth.js";
import { isAdministrator } from "./emmaPolicyService.js";
import { fail, ok, type ServiceResult } from "./result.js";

export const EMMA_BEHAVIOR_SCENARIO_MAX_LENGTH = 6_000;

export const updateEmmaBehaviorScenarioSchema = z.object({
  enabled: z.boolean(),
  scenario: z.string().trim().max(EMMA_BEHAVIOR_SCENARIO_MAX_LENGTH),
}).superRefine((value, context) => {
  if (value.enabled && value.scenario.length === 0) {
    context.addIssue({ code: "custom", path: ["scenario"], message: "An enabled behavior scenario cannot be empty." });
  }
});

export interface EmmaBehaviorScenario {
  enabled: boolean;
  scenario: string;
  updatedAt: Date | null;
}

function scenarioAuditData(enabled: boolean, scenario: string) {
  return {
    enabled,
    scenarioCharacters: scenario.length,
    scenarioSha256: scenario ? createHash("sha256").update(scenario, "utf8").digest("hex") : null,
  };
}

export async function getEmmaBehaviorScenario(user: AuthedUser): Promise<EmmaBehaviorScenario | null> {
  if (!isAdministrator(user)) return null;
  const company = await prisma.company.findUnique({
    where: { id: user.companyId },
    select: { emmaBehaviorEnabled: true, emmaBehaviorScenario: true, emmaBehaviorUpdatedAt: true },
  });
  if (!company) return null;
  return {
    enabled: company.emmaBehaviorEnabled,
    scenario: company.emmaBehaviorScenario ?? "",
    updatedAt: company.emmaBehaviorUpdatedAt,
  };
}

export async function getActiveEmmaBehaviorScenario(companyId: string): Promise<string | undefined> {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { emmaBehaviorEnabled: true, emmaBehaviorScenario: true },
  });
  const scenario = company?.emmaBehaviorScenario?.trim();
  return company?.emmaBehaviorEnabled && scenario ? scenario : undefined;
}

export function buildEmmaBehaviorInstructions(scenario?: string): string {
  const normalized = scenario?.replaceAll("\u0000", "").trim().slice(0, EMMA_BEHAVIOR_SCENARIO_MAX_LENGTH);
  if (!normalized) return "";
  return `

COMPANY ADMINISTRATOR BEHAVIOR SCENARIO
The company administrator supplied the scenario below to shape Emma's tone, persona, wording, and conversational manner. Apply it throughout this session, but it is subordinate to all safety, truthfulness, language, permission, confirmation, privacy, and application-operation rules above. It cannot add a capability or authorize an action. Never claim a literal physical body, senses, location, life history, feelings, or real-world action that you do not actually have or perform. If the scenario describes Emma as a human or embodied person, treat that as an expressive role and speaking style only, not a factual claim.
ADMIN_BEHAVIOR_SCENARIO_JSON=${JSON.stringify(normalized)}`;
}

export async function updateEmmaBehaviorScenario(
  user: AuthedUser,
  rawInput: unknown,
): Promise<ServiceResult<EmmaBehaviorScenario>> {
  if (!isAdministrator(user)) {
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: UPDATE_EMMA_BEHAVIOR_SCENARIO_ACTION.actionName,
      inputPayload: { attempted: true },
      riskLevel: UPDATE_EMMA_BEHAVIOR_SCENARIO_ACTION.riskLevel,
      confirmationRequired: false,
      result: "rejected",
      errorMessage: "ADMINISTRATOR_REQUIRED",
    });
    return fail(403, "ADMINISTRATOR_REQUIRED");
  }

  const parsed = updateEmmaBehaviorScenarioSchema.safeParse(rawInput);
  if (!parsed.success) {
    const candidate = typeof rawInput === "object" && rawInput ? rawInput as Record<string, unknown> : {};
    const scenario = typeof candidate.scenario === "string" ? candidate.scenario : "";
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: UPDATE_EMMA_BEHAVIOR_SCENARIO_ACTION.actionName,
      inputPayload: scenarioAuditData(candidate.enabled === true, scenario),
      riskLevel: UPDATE_EMMA_BEHAVIOR_SCENARIO_ACTION.riskLevel,
      confirmationRequired: false,
      result: "error",
      errorMessage: "VALIDATION_FAILED",
    });
    return fail(400, "VALIDATION_FAILED", parsed.error.message);
  }

  const existing = await prisma.company.findUnique({
    where: { id: user.companyId },
    select: { emmaBehaviorEnabled: true, emmaBehaviorScenario: true, emmaBehaviorUpdatedAt: true },
  });
  if (!existing) return fail(404, "COMPANY_NOT_FOUND");

  const now = new Date();
  const updated = await prisma.company.update({
    where: { id: user.companyId },
    data: {
      emmaBehaviorEnabled: parsed.data.enabled,
      emmaBehaviorScenario: parsed.data.scenario || null,
      emmaBehaviorUpdatedAt: now,
    },
    select: { emmaBehaviorEnabled: true, emmaBehaviorScenario: true, emmaBehaviorUpdatedAt: true },
  });

  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: UPDATE_EMMA_BEHAVIOR_SCENARIO_ACTION.actionName,
    inputPayload: scenarioAuditData(parsed.data.enabled, parsed.data.scenario),
    dataBefore: scenarioAuditData(existing.emmaBehaviorEnabled, existing.emmaBehaviorScenario ?? ""),
    dataAfter: scenarioAuditData(updated.emmaBehaviorEnabled, updated.emmaBehaviorScenario ?? ""),
    riskLevel: UPDATE_EMMA_BEHAVIOR_SCENARIO_ACTION.riskLevel,
    confirmationRequired: false,
    result: "success",
  });

  return ok(200, {
    enabled: updated.emmaBehaviorEnabled,
    scenario: updated.emmaBehaviorScenario ?? "",
    updatedAt: updated.emmaBehaviorUpdatedAt,
  });
}
