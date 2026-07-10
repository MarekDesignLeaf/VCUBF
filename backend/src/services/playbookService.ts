import { z } from "zod";
import { prisma } from "../db.js";
import { recordAudit } from "../lib/audit.js";
import { CREATE_PLAYBOOK_ACTION, UPDATE_PLAYBOOK_ACTION, RUN_PLAYBOOK_ACTION } from "../lib/actionContracts.js";
import { parseTextCommand } from "../lib/commandParser.js";
import { dispatchParsedCommand, type CommandResponse } from "../lib/commandExecutor.js";
import { resolveLearningAliases } from "./learningService.js";
import type { AuthedUser } from "../middleware/auth.js";
import { fail, ok, type ServiceResult } from "./result.js";

// Playbook Engine. A playbook is an ordered list of Voice/Text Command Layer
// templates ("create job {job_title} for {client_name}") with {placeholder}
// variables — the exact same syntax a user could type by hand. Running a
// playbook resolves the placeholders with real, user-supplied values and
// dispatches each step through dispatchParsedCommand, the same Action Engine
// entry point POST /command/text uses — there is no separate, hidden
// execution path and no business logic living only in a prompt.

export const createPlaybookSchema = z.object({
  name: z.string().min(1, "name is required"),
  description: z.string().optional(),
  step_templates: z.array(z.string().min(1)).min(1, "at least one step is required"),
});

export const updatePlaybookSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  step_templates: z.array(z.string().min(1)).min(1).optional(),
  is_active: z.boolean().optional(),
});

export const runPlaybookSchema = z.object({
  variables: z.record(z.string()).optional(),
  confirmed: z.boolean().optional(),
});

const PLACEHOLDER_RE = /\{([a-zA-Z0-9_]+)\}/g;

function resolveTemplate(template: string, variables: Record<string, string>): { text?: string; missing: string[] } {
  const missing: string[] = [];
  const text = template.replace(PLACEHOLDER_RE, (_match, name: string) => {
    if (!(name in variables)) {
      missing.push(name);
      return `{${name}}`;
    }
    return variables[name];
  });
  return missing.length > 0 ? { missing } : { text, missing };
}

export async function listPlaybooks(user: AuthedUser, filters: { activeOnly?: boolean } = {}) {
  return prisma.playbook.findMany({
    where: { companyId: user.companyId, ...(filters.activeOnly ? { isActive: true } : {}) },
    orderBy: { name: "asc" },
  });
}

export async function getPlaybook(user: AuthedUser, id: string) {
  return prisma.playbook.findFirst({ where: { id, companyId: user.companyId } });
}

export async function listPlaybookRuns(user: AuthedUser, playbookId: string) {
  return prisma.playbookRun.findMany({
    where: { companyId: user.companyId, playbookId },
    orderBy: { createdAt: "desc" },
  });
}

// create_playbook — Action Contract driven.
export async function createPlaybook(user: AuthedUser, rawInput: unknown): Promise<ServiceResult<unknown>> {
  const parsed = createPlaybookSchema.safeParse(rawInput);
  if (!parsed.success) {
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: CREATE_PLAYBOOK_ACTION.actionName,
      inputPayload: rawInput,
      riskLevel: CREATE_PLAYBOOK_ACTION.riskLevel,
      confirmationRequired: CREATE_PLAYBOOK_ACTION.confirmationRequired,
      result: "error",
      errorMessage: "VALIDATION_FAILED",
    });
    return fail(400, "VALIDATION_FAILED", parsed.error.message);
  }
  const data = parsed.data;

  const created = await prisma.playbook.create({
    data: {
      companyId: user.companyId,
      name: data.name,
      description: data.description,
      stepTemplates: data.step_templates,
      createdBy: user.id,
    },
  });

  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: CREATE_PLAYBOOK_ACTION.actionName,
    inputPayload: data,
    dataAfter: created,
    riskLevel: CREATE_PLAYBOOK_ACTION.riskLevel,
    confirmationRequired: CREATE_PLAYBOOK_ACTION.confirmationRequired,
    result: "success",
  });

  return ok(201, created);
}

// update_playbook — Action Contract driven.
export async function updatePlaybook(user: AuthedUser, id: string, rawInput: unknown): Promise<ServiceResult<unknown>> {
  const parsed = updatePlaybookSchema.safeParse(rawInput);
  if (!parsed.success) {
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: UPDATE_PLAYBOOK_ACTION.actionName,
      inputPayload: { id, ...(typeof rawInput === "object" && rawInput ? rawInput : {}) },
      riskLevel: UPDATE_PLAYBOOK_ACTION.riskLevel,
      confirmationRequired: UPDATE_PLAYBOOK_ACTION.confirmationRequired,
      result: "error",
      errorMessage: "VALIDATION_FAILED",
    });
    return fail(400, "VALIDATION_FAILED", parsed.error.message);
  }
  const data = parsed.data;

  const existing = await prisma.playbook.findFirst({ where: { id, companyId: user.companyId } });
  if (!existing) {
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: UPDATE_PLAYBOOK_ACTION.actionName,
      inputPayload: { id, ...data },
      riskLevel: UPDATE_PLAYBOOK_ACTION.riskLevel,
      confirmationRequired: UPDATE_PLAYBOOK_ACTION.confirmationRequired,
      result: "error",
      errorMessage: "PLAYBOOK_NOT_FOUND",
    });
    return fail(404, "PLAYBOOK_NOT_FOUND");
  }

  const changes: Record<string, unknown> = {};
  if (data.name !== undefined) changes.name = data.name;
  if (data.description !== undefined) changes.description = data.description;
  if (data.step_templates !== undefined) changes.stepTemplates = data.step_templates;
  if (data.is_active !== undefined) changes.isActive = data.is_active;

  const updated = await prisma.playbook.update({ where: { id: existing.id }, data: changes });

  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: UPDATE_PLAYBOOK_ACTION.actionName,
    inputPayload: { id, changes },
    dataBefore: existing,
    dataAfter: updated,
    riskLevel: UPDATE_PLAYBOOK_ACTION.riskLevel,
    confirmationRequired: UPDATE_PLAYBOOK_ACTION.confirmationRequired,
    result: "success",
  });

  return ok(200, updated);
}

interface StepResult {
  template: string;
  resolvedText: string;
  intent: string;
  ok: boolean;
  httpStatus: number;
  data?: unknown;
  error?: string;
  message?: string;
}

// run_playbook — Action Contract driven, confirmationRequired: true. Without
// confirmed: true, nothing runs and the caller gets back exactly what each
// step would resolve to and how it would be interpreted. Execution stops at
// the first failing step rather than silently continuing (fail safely).
export async function runPlaybook(user: AuthedUser, playbookId: string, rawInput: unknown): Promise<ServiceResult<unknown>> {
  const parsed = runPlaybookSchema.safeParse(rawInput);
  if (!parsed.success) {
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: RUN_PLAYBOOK_ACTION.actionName,
      inputPayload: { playbookId, ...(typeof rawInput === "object" && rawInput ? rawInput : {}) },
      riskLevel: RUN_PLAYBOOK_ACTION.riskLevel,
      confirmationRequired: RUN_PLAYBOOK_ACTION.confirmationRequired,
      result: "error",
      errorMessage: "VALIDATION_FAILED",
    });
    return fail(400, "VALIDATION_FAILED", parsed.error.message);
  }
  const data = parsed.data;
  const variables = data.variables ?? {};

  const playbook = await prisma.playbook.findFirst({ where: { id: playbookId, companyId: user.companyId } });
  if (!playbook) {
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: RUN_PLAYBOOK_ACTION.actionName,
      inputPayload: { playbookId, variables },
      riskLevel: RUN_PLAYBOOK_ACTION.riskLevel,
      confirmationRequired: RUN_PLAYBOOK_ACTION.confirmationRequired,
      result: "error",
      errorMessage: "PLAYBOOK_NOT_FOUND",
    });
    return fail(404, "PLAYBOOK_NOT_FOUND");
  }

  const allMissing = new Set<string>();
  const resolved: { template: string; text: string }[] = [];
  for (const template of playbook.stepTemplates) {
    const result = resolveTemplate(template, variables);
    if (result.missing.length > 0) {
      result.missing.forEach((m) => allMissing.add(m));
    } else {
      // Learning Engine aliases apply here too, so a playbook step is
      // interpreted exactly the way typing the same resolved text into the
      // command bar would be — same preprocessing, same Action Engine call.
      const alias = await resolveLearningAliases(user, result.text!);
      resolved.push({ template, text: alias.resolvedText });
    }
  }
  if (allMissing.size > 0) {
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: RUN_PLAYBOOK_ACTION.actionName,
      inputPayload: { playbookId, variables },
      riskLevel: RUN_PLAYBOOK_ACTION.riskLevel,
      confirmationRequired: RUN_PLAYBOOK_ACTION.confirmationRequired,
      result: "error",
      errorMessage: "MISSING_VARIABLE",
    });
    return fail(400, "MISSING_VARIABLE", `Missing value(s) for: ${Array.from(allMissing).join(", ")}`, {
      missingVariables: Array.from(allMissing),
    });
  }

  const preview = resolved.map((r) => ({
    template: r.template,
    resolvedText: r.text,
    interpretedIntent: parseTextCommand(r.text).intent,
  }));

  if (!data.confirmed) {
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: RUN_PLAYBOOK_ACTION.actionName,
      inputPayload: { playbookId, variables },
      riskLevel: RUN_PLAYBOOK_ACTION.riskLevel,
      confirmationRequired: RUN_PLAYBOOK_ACTION.confirmationRequired,
      confirmed: false,
      result: "error",
      errorMessage: "CONFIRMATION_REQUIRED",
    });
    return fail(409, "CONFIRMATION_REQUIRED", "Review the resolved steps and resend with confirmed: true to run this playbook.", {
      preview: { playbookName: playbook.name, steps: preview },
    });
  }

  const stepResults: StepResult[] = [];
  let overallOk = true;
  for (const step of resolved) {
    const command = parseTextCommand(step.text);
    const result: CommandResponse = await dispatchParsedCommand(user, command);
    stepResults.push({
      template: step.template,
      resolvedText: step.text,
      intent: result.intent,
      ok: result.ok,
      httpStatus: result.httpStatus,
      data: result.data,
      error: result.error,
      message: result.message,
    });
    if (!result.ok) {
      overallOk = false;
      break;
    }
  }

  const run = await prisma.playbookRun.create({
    data: {
      companyId: user.companyId,
      playbookId: playbook.id,
      triggeredBy: user.id,
      variables,
      stepResults: stepResults as never,
      overallOk,
    },
  });

  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: RUN_PLAYBOOK_ACTION.actionName,
    inputPayload: { playbookId, variables },
    dataAfter: { runId: run.id, stepResults },
    riskLevel: RUN_PLAYBOOK_ACTION.riskLevel,
    confirmationRequired: RUN_PLAYBOOK_ACTION.confirmationRequired,
    confirmed: true,
    result: overallOk ? "success" : "error",
    errorMessage: overallOk ? undefined : "STEP_FAILED",
  });

  return ok(200, run);
}
