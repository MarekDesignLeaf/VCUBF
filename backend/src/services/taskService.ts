import { z } from "zod";
import { prisma } from "../db.js";
import { recordAudit } from "../lib/audit.js";
import {
  CREATE_TASK_ACTION,
  TASK_CATEGORIES,
  TASK_PRIORITIES,
  TASK_SOURCES,
  TASK_STATUSES,
  UPDATE_TASK_ACTION,
} from "../lib/actionContracts.js";
import type { AuthedUser } from "../middleware/auth.js";
import { computeEmployeeCapacity } from "./capacityService.js";
import { fail, ok, type ServiceResult } from "./result.js";

export const createTaskSchema = z.object({
  client_id: z.string().uuid().optional(),
  job_id: z.string().uuid().optional(),
  communication_record_id: z.string().uuid().optional(),
  assigned_user_id: z.string().uuid().optional(),
  title: z.string().trim().min(1, "title is required").max(300),
  description: z.string().max(5_000).optional(),
  priority: z.enum(TASK_PRIORITIES).default("normal"),
  category: z.enum(TASK_CATEGORIES).default("administrative"),
  source: z.enum(TASK_SOURCES).default("user_input"),
  due_at: z.string().datetime().optional(),
  estimated_duration_hours: z.number().positive().max(168).optional(),
});

export const updateTaskSchema = z
  .object({
    assigned_user_id: z.string().uuid().nullable().optional(),
    title: z.string().trim().min(1).max(300).optional(),
    description: z.string().max(5_000).nullable().optional(),
    task_status: z.enum(TASK_STATUSES).optional(),
    priority: z.enum(TASK_PRIORITIES).optional(),
    category: z.enum(TASK_CATEGORIES).optional(),
    due_at: z.string().datetime().nullable().optional(),
    estimated_duration_hours: z.number().positive().max(168).nullable().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, "At least one field is required");

const taskInclude = {
  client: { select: { id: true, displayName: true } },
  job: { select: { id: true, jobTitle: true } },
  communicationRecord: { select: { id: true, channel: true, summary: true } },
  assignedUser: { select: { id: true, displayName: true } },
};

async function auditError(
  user: AuthedUser,
  action: typeof CREATE_TASK_ACTION | typeof UPDATE_TASK_ACTION,
  inputPayload: unknown,
  errorMessage: string,
  dataBefore?: unknown
) {
  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: action.actionName,
    inputPayload,
    dataBefore,
    riskLevel: action.riskLevel,
    confirmationRequired: action.confirmationRequired,
    result: "error",
    errorMessage,
  });
}

async function buildCapacityWarning(user: AuthedUser, task: { assignedUserId: string | null; dueAt: Date | null }) {
  if (!task.assignedUserId || !task.dueAt) return null;
  const capacity = await computeEmployeeCapacity(user, task.assignedUserId, task.dueAt);
  if (!capacity || !capacity.overloaded) return null;
  return {
    type: "OVERLOAD",
    employeeId: capacity.employeeId,
    employeeName: capacity.employeeName,
    weekStart: capacity.weekStart,
    currentLoadHours: capacity.currentLoadHours,
    weeklyCapacityHours: capacity.weeklyCapacityHours,
    utilizationPct: capacity.utilizationPct,
  };
}

export interface TaskFilters {
  status?: string;
  priority?: string;
  assignedUserId?: string;
  clientId?: string;
  jobId?: string;
  dueFrom?: Date;
  dueTo?: Date;
  overdue?: boolean;
}

export async function listTasks(user: AuthedUser, filters: TaskFilters = {}) {
  const dueRange =
    filters.dueFrom || filters.dueTo
      ? { ...(filters.dueFrom ? { gte: filters.dueFrom } : {}), ...(filters.dueTo ? { lt: filters.dueTo } : {}) }
      : undefined;
  return prisma.task.findMany({
    where: {
      companyId: user.companyId,
      ...(filters.status ? { taskStatus: filters.status } : {}),
      ...(filters.priority ? { priority: filters.priority } : {}),
      ...(filters.assignedUserId ? { assignedUserId: filters.assignedUserId } : {}),
      ...(filters.clientId ? { clientId: filters.clientId } : {}),
      ...(filters.jobId ? { jobId: filters.jobId } : {}),
      ...(dueRange ? { dueAt: dueRange } : {}),
      ...(filters.overdue
        ? { taskStatus: { notIn: ["completed", "cancelled"] }, dueAt: { lt: new Date() } }
        : {}),
    },
    include: taskInclude,
    orderBy: [{ dueAt: "asc" }, { createdAt: "desc" }],
  });
}

export async function getTask(user: AuthedUser, id: string) {
  return prisma.task.findFirst({
    where: { id, companyId: user.companyId },
    include: taskInclude,
  });
}

export async function createTask(user: AuthedUser, rawInput: unknown): Promise<ServiceResult<unknown>> {
  const parsed = createTaskSchema.safeParse(rawInput);
  if (!parsed.success) {
    await auditError(user, CREATE_TASK_ACTION, rawInput, "VALIDATION_FAILED");
    return fail(400, "VALIDATION_FAILED", parsed.error.message);
  }
  const input = parsed.data;

  const [client, job, communicationRecord, assignedUser] = await Promise.all([
    input.client_id
      ? prisma.client.findFirst({ where: { id: input.client_id, companyId: user.companyId, isActive: true } })
      : Promise.resolve(null),
    input.job_id
      ? prisma.job.findFirst({ where: { id: input.job_id, companyId: user.companyId } })
      : Promise.resolve(null),
    input.communication_record_id
      ? prisma.communicationRecord.findFirst({
          where: { id: input.communication_record_id, companyId: user.companyId },
        })
      : Promise.resolve(null),
    input.assigned_user_id
      ? prisma.user.findFirst({
          where: { id: input.assigned_user_id, companyId: user.companyId, isActive: true },
        })
      : Promise.resolve(null),
  ]);

  if (input.client_id && !client) {
    await auditError(user, CREATE_TASK_ACTION, input, "CLIENT_NOT_FOUND");
    return fail(404, "CLIENT_NOT_FOUND");
  }
  if (input.job_id && !job) {
    await auditError(user, CREATE_TASK_ACTION, input, "JOB_NOT_FOUND");
    return fail(404, "JOB_NOT_FOUND");
  }
  if (input.communication_record_id && !communicationRecord) {
    await auditError(user, CREATE_TASK_ACTION, input, "COMMUNICATION_RECORD_NOT_FOUND");
    return fail(404, "COMMUNICATION_RECORD_NOT_FOUND");
  }
  if (input.assigned_user_id && !assignedUser) {
    await auditError(user, CREATE_TASK_ACTION, input, "EMPLOYEE_NOT_FOUND");
    return fail(404, "EMPLOYEE_NOT_FOUND");
  }

  const linkedClientId = communicationRecord?.clientId ?? job?.clientId ?? client?.id;
  const linkedJobId = communicationRecord?.jobId ?? job?.id;
  if (
    (client && linkedClientId && client.id !== linkedClientId) ||
    (job && communicationRecord?.jobId && job.id !== communicationRecord.jobId) ||
    (job && communicationRecord && job.clientId !== communicationRecord.clientId)
  ) {
    await auditError(user, CREATE_TASK_ACTION, input, "RELATED_RECORD_MISMATCH");
    return fail(
      409,
      "RELATED_RECORD_MISMATCH",
      "The selected client, job and communication record do not describe the same CRM work."
    );
  }

  const created = await prisma.task.create({
    data: {
      companyId: user.companyId,
      clientId: linkedClientId,
      jobId: linkedJobId,
      communicationRecordId: input.communication_record_id,
      assignedUserId: input.assigned_user_id,
      title: input.title,
      description: input.description,
      priority: input.priority,
      category: input.category,
      source: input.source,
      dueAt: input.due_at ? new Date(input.due_at) : undefined,
      estimatedDurationHours: input.estimated_duration_hours,
      createdBy: user.id,
    },
    include: taskInclude,
  });

  const capacityWarning = await buildCapacityWarning(user, created);
  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: CREATE_TASK_ACTION.actionName,
    inputPayload: input,
    dataAfter: created,
    riskLevel: CREATE_TASK_ACTION.riskLevel,
    confirmationRequired: CREATE_TASK_ACTION.confirmationRequired,
    result: "success",
  });
  return ok(201, { task: created, capacityWarning });
}

export async function updateTask(user: AuthedUser, id: string, rawInput: unknown): Promise<ServiceResult<unknown>> {
  const parsed = updateTaskSchema.safeParse(rawInput);
  if (!parsed.success) {
    await auditError(user, UPDATE_TASK_ACTION, { id, input: rawInput }, "VALIDATION_FAILED");
    return fail(400, "VALIDATION_FAILED", parsed.error.message);
  }
  const input = parsed.data;
  const existing = await prisma.task.findFirst({ where: { id, companyId: user.companyId } });
  if (!existing) {
    await auditError(user, UPDATE_TASK_ACTION, { id, ...input }, "TASK_NOT_FOUND");
    return fail(404, "TASK_NOT_FOUND");
  }

  if (input.assigned_user_id) {
    const employee = await prisma.user.findFirst({
      where: { id: input.assigned_user_id, companyId: user.companyId, isActive: true },
    });
    if (!employee) {
      await auditError(user, UPDATE_TASK_ACTION, { id, ...input }, "EMPLOYEE_NOT_FOUND", existing);
      return fail(404, "EMPLOYEE_NOT_FOUND");
    }
  }

  const changes: Record<string, unknown> = {};
  if (input.assigned_user_id !== undefined) changes.assignedUserId = input.assigned_user_id;
  if (input.title !== undefined) changes.title = input.title;
  if (input.description !== undefined) changes.description = input.description;
  if (input.priority !== undefined) changes.priority = input.priority;
  if (input.category !== undefined) changes.category = input.category;
  if (input.due_at !== undefined) changes.dueAt = input.due_at ? new Date(input.due_at) : null;
  if (input.estimated_duration_hours !== undefined)
    changes.estimatedDurationHours = input.estimated_duration_hours;
  if (input.task_status !== undefined) {
    changes.taskStatus = input.task_status;
    changes.completedAt = input.task_status === "completed" ? new Date() : null;
  }

  const updated = await prisma.task.update({
    where: { id: existing.id },
    data: changes,
    include: taskInclude,
  });
  const capacityWarning = await buildCapacityWarning(user, updated);

  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: UPDATE_TASK_ACTION.actionName,
    inputPayload: { id, changes },
    dataBefore: existing,
    dataAfter: updated,
    riskLevel: UPDATE_TASK_ACTION.riskLevel,
    confirmationRequired: UPDATE_TASK_ACTION.confirmationRequired,
    result: "success",
  });
  return ok(200, { task: updated, capacityWarning });
}
