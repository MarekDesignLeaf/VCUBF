import { prisma } from "../db.js";
import type { AuthedUser } from "../middleware/auth.js";
import { computeEmployeeCapacity } from "./capacityService.js";

// Employee and Permission Model — read-side helpers for the Job Allocation
// and Capacity Management Module. This slice does not add employee
// creation/editing (that already exists implicitly via the User model and
// seeding); it adds visibility into who exists and what their real
// workload is, which is required before any capacity-aware assignment can
// happen safely.

export async function listEmployees(user: AuthedUser, reference: Date = new Date()) {
  const employees = await prisma.user.findMany({
    where: { companyId: user.companyId, isActive: true },
    select: { id: true, displayName: true, email: true, role: true, skills: true, weeklyCapacityHours: true },
    orderBy: { displayName: "asc" },
  });

  return Promise.all(
    employees.map(async (e) => ({
      ...e,
      capacity: await computeEmployeeCapacity(user, e.id, reference),
    }))
  );
}

export async function getEmployee(user: AuthedUser, id: string) {
  return prisma.user.findFirst({
    where: { id, companyId: user.companyId, isActive: true },
    select: { id: true, displayName: true, email: true, role: true, skills: true, weeklyCapacityHours: true },
  });
}

// Case-insensitive substring match on display name — used by the Text
// Command Layer to resolve "assign job X to Y" to a specific employee.
export async function findEmployeesByName(user: AuthedUser, name: string) {
  return prisma.user.findMany({
    where: { companyId: user.companyId, isActive: true, displayName: { contains: name, mode: "insensitive" } },
    select: { id: true, displayName: true, email: true, role: true, skills: true, weeklyCapacityHours: true },
  });
}

// --- Employee creation and management (Employee and Permission Model) ---

import { z } from "zod";
import bcrypt from "bcryptjs";
import { recordAudit } from "../lib/audit.js";
import { CREATE_EMPLOYEE_ACTION, KNOWN_PERMISSIONS, RESET_EMPLOYEE_PASSWORD_ACTION, UPDATE_EMPLOYEE_ACTION } from "../lib/actionContracts.js";
import { fail, ok, type ServiceResult } from "./result.js";

export const createEmployeeSchema = z.object({
  display_name: z.string().min(1, "display_name is required"),
  email: z.string().email("a valid email is required"),
  password: z.string().min(12).regex(/[a-z]/).regex(/[A-Z]/).regex(/[0-9]/),
  role: z.string().min(1).default("worker"),
  permissions: z.array(z.enum(KNOWN_PERMISSIONS)).default([]),
  skills: z.array(z.string()).default([]),
  weekly_capacity_hours: z.number().int().positive().default(40),
  confirmed: z.boolean().optional(),
});

export const resetEmployeePasswordSchema = z.object({
  temporary_password: z.string().min(12).regex(/[a-z]/).regex(/[A-Z]/).regex(/[0-9]/),
  confirmed: z.boolean().optional(),
});

export const updateEmployeeSchema = z.object({
  display_name: z.string().min(1).optional(),
  role: z.string().min(1).optional(),
  permissions: z.array(z.enum(KNOWN_PERMISSIONS)).optional(),
  skills: z.array(z.string()).optional(),
  weekly_capacity_hours: z.number().int().positive().optional(),
  is_active: z.boolean().optional(),
  confirmed: z.boolean().optional(),
});

// Fetches an employee for management purposes (unlike getEmployee, this
// includes inactive employees so an admin can review and reactivate them).
export async function getEmployeeForManagement(user: AuthedUser, id: string) {
  return prisma.user.findFirst({
    where: { id, companyId: user.companyId },
    select: {
      id: true,
      displayName: true,
      email: true,
      role: true,
      permissions: true,
      skills: true,
      weeklyCapacityHours: true,
      isActive: true,
      mustChangePassword: true,
    },
  });
}

// create_employee — Action Contract driven, confirmationRequired: true.
// Without `confirmed: true` in the body, returns a 409 CONFIRMATION_REQUIRED
// with a preview of exactly what would be created — nothing is written.
// This is the generic pattern for any risk-3+ action in this codebase.
export async function createEmployee(user: AuthedUser, rawInput: unknown): Promise<ServiceResult<unknown>> {
  const parsed = createEmployeeSchema.safeParse(rawInput);
  if (!parsed.success) {
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: CREATE_EMPLOYEE_ACTION.actionName,
      inputPayload: rawInput,
      riskLevel: CREATE_EMPLOYEE_ACTION.riskLevel,
      confirmationRequired: CREATE_EMPLOYEE_ACTION.confirmationRequired,
      result: "error",
      errorMessage: "VALIDATION_FAILED",
    });
    return fail(400, "VALIDATION_FAILED", parsed.error.message);
  }
  const data = parsed.data;

  const existing = await prisma.user.findUnique({ where: { email: data.email } });
  if (existing) {
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: CREATE_EMPLOYEE_ACTION.actionName,
      inputPayload: { ...data, password: "[redacted]" },
      riskLevel: CREATE_EMPLOYEE_ACTION.riskLevel,
      confirmationRequired: CREATE_EMPLOYEE_ACTION.confirmationRequired,
      result: "error",
      errorMessage: "EMAIL_ALREADY_EXISTS",
    });
    return fail(409, "EMAIL_ALREADY_EXISTS", "A user with this email already exists.");
  }

  const preview = {
    display_name: data.display_name,
    email: data.email,
    role: data.role,
    permissions: data.permissions,
    skills: data.skills,
    weekly_capacity_hours: data.weekly_capacity_hours,
  };

  if (!data.confirmed) {
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: CREATE_EMPLOYEE_ACTION.actionName,
      inputPayload: { ...preview },
      riskLevel: CREATE_EMPLOYEE_ACTION.riskLevel,
      confirmationRequired: CREATE_EMPLOYEE_ACTION.confirmationRequired,
      result: "error",
      errorMessage: "CONFIRMATION_REQUIRED",
    });
    return fail(409, "CONFIRMATION_REQUIRED", "Review the preview and resubmit with confirmed: true.", { preview });
  }

  const passwordHash = await bcrypt.hash(data.password, 12);
  const created = await prisma.user.create({
    data: {
      companyId: user.companyId,
      displayName: data.display_name,
      email: data.email,
      passwordHash,
      role: data.role,
      permissions: data.permissions,
      skills: data.skills,
      weeklyCapacityHours: data.weekly_capacity_hours,
      mustChangePassword: true,
    },
    select: {
      id: true,
      displayName: true,
      email: true,
      role: true,
      permissions: true,
      skills: true,
      weeklyCapacityHours: true,
      isActive: true,
      mustChangePassword: true,
    },
  });

  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: CREATE_EMPLOYEE_ACTION.actionName,
    inputPayload: { ...preview },
    dataAfter: created,
    riskLevel: CREATE_EMPLOYEE_ACTION.riskLevel,
    confirmationRequired: CREATE_EMPLOYEE_ACTION.confirmationRequired,
    confirmed: true,
    result: "success",
  });

  return ok(201, created);
}

// update_employee — Action Contract driven, same confirm-preview pattern.
export async function updateEmployee(
  user: AuthedUser,
  employeeId: string,
  rawInput: unknown
): Promise<ServiceResult<unknown>> {
  const parsed = updateEmployeeSchema.safeParse(rawInput);
  if (!parsed.success) {
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: UPDATE_EMPLOYEE_ACTION.actionName,
      inputPayload: { employeeId, ...(typeof rawInput === "object" && rawInput ? rawInput : {}) },
      riskLevel: UPDATE_EMPLOYEE_ACTION.riskLevel,
      confirmationRequired: UPDATE_EMPLOYEE_ACTION.confirmationRequired,
      result: "error",
      errorMessage: "VALIDATION_FAILED",
    });
    return fail(400, "VALIDATION_FAILED", parsed.error.message);
  }
  const data = parsed.data;

  const existing = await prisma.user.findFirst({ where: { id: employeeId, companyId: user.companyId } });
  if (!existing) {
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: UPDATE_EMPLOYEE_ACTION.actionName,
      inputPayload: { employeeId, ...data },
      riskLevel: UPDATE_EMPLOYEE_ACTION.riskLevel,
      confirmationRequired: UPDATE_EMPLOYEE_ACTION.confirmationRequired,
      result: "error",
      errorMessage: "EMPLOYEE_NOT_FOUND",
    });
    return fail(404, "EMPLOYEE_NOT_FOUND");
  }

  const changes: Record<string, unknown> = {};
  if (data.display_name !== undefined) changes.displayName = data.display_name;
  if (data.role !== undefined) changes.role = data.role;
  if (data.permissions !== undefined) changes.permissions = data.permissions;
  if (data.skills !== undefined) changes.skills = data.skills;
  if (data.weekly_capacity_hours !== undefined) changes.weeklyCapacityHours = data.weekly_capacity_hours;
  if (data.is_active !== undefined) changes.isActive = data.is_active;

  const before = {
    displayName: existing.displayName,
    role: existing.role,
    permissions: existing.permissions,
    skills: existing.skills,
    weeklyCapacityHours: existing.weeklyCapacityHours,
    isActive: existing.isActive,
  };

  if (!data.confirmed) {
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: UPDATE_EMPLOYEE_ACTION.actionName,
      inputPayload: { employeeId, changes },
      dataBefore: before,
      riskLevel: UPDATE_EMPLOYEE_ACTION.riskLevel,
      confirmationRequired: UPDATE_EMPLOYEE_ACTION.confirmationRequired,
      result: "error",
      errorMessage: "CONFIRMATION_REQUIRED",
    });
    return fail(409, "CONFIRMATION_REQUIRED", "Review the preview and resubmit with confirmed: true.", {
      preview: { before, changes },
    });
  }

  const updated = await prisma.user.update({
    where: { id: existing.id },
    data: changes,
    select: {
      id: true,
      displayName: true,
      email: true,
      role: true,
      permissions: true,
      skills: true,
      weeklyCapacityHours: true,
      isActive: true,
      mustChangePassword: true,
    },
  });

  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: UPDATE_EMPLOYEE_ACTION.actionName,
    inputPayload: { employeeId, changes },
    dataBefore: before,
    dataAfter: updated,
    riskLevel: UPDATE_EMPLOYEE_ACTION.riskLevel,
    confirmationRequired: UPDATE_EMPLOYEE_ACTION.confirmationRequired,
    confirmed: true,
    result: "success",
  });

  return ok(200, updated);
}

export async function resetEmployeePassword(user: AuthedUser, employeeId: string, rawInput: unknown): Promise<ServiceResult<unknown>> {
  const parsed = resetEmployeePasswordSchema.safeParse(rawInput);
  const auditBase = {
    companyId: user.companyId,
    userId: user.id,
    actionName: RESET_EMPLOYEE_PASSWORD_ACTION.actionName,
    inputPayload: { employeeId, passwordFieldsRedacted: true },
    riskLevel: RESET_EMPLOYEE_PASSWORD_ACTION.riskLevel,
    confirmationRequired: RESET_EMPLOYEE_PASSWORD_ACTION.confirmationRequired,
  } as const;
  if (!parsed.success) {
    await recordAudit({ ...auditBase, result: "error", errorMessage: "VALIDATION_FAILED" });
    return fail(400, "VALIDATION_FAILED", parsed.error.message);
  }
  const employee = await prisma.user.findFirst({ where: { id: employeeId, companyId: user.companyId } });
  if (!employee) {
    await recordAudit({ ...auditBase, result: "error", errorMessage: "EMPLOYEE_NOT_FOUND" });
    return fail(404, "EMPLOYEE_NOT_FOUND");
  }
  if (employee.id === user.id) {
    await recordAudit({ ...auditBase, result: "rejected", errorMessage: "SELF_PASSWORD_RESET_NOT_ALLOWED" });
    return fail(409, "SELF_PASSWORD_RESET_NOT_ALLOWED", "Use Account to change your own password.");
  }
  if (!employee.isActive) {
    await recordAudit({ ...auditBase, result: "rejected", errorMessage: "EMPLOYEE_INACTIVE" });
    return fail(409, "EMPLOYEE_INACTIVE");
  }
  const preview = { employeeId: employee.id, email: employee.email, displayName: employee.displayName, invalidatesExistingSessions: true, requiresPasswordChange: true };
  if (!parsed.data.confirmed) {
    await recordAudit({ ...auditBase, dataBefore: { authVersion: employee.authVersion, mustChangePassword: employee.mustChangePassword }, result: "rejected", errorMessage: "CONFIRMATION_REQUIRED" });
    return fail(409, "CONFIRMATION_REQUIRED", "Review the preview and resubmit with confirmed: true.", { preview });
  }
  await prisma.user.update({
    where: { id: employee.id },
    data: { passwordHash: await bcrypt.hash(parsed.data.temporary_password, 12), authVersion: { increment: 1 }, mustChangePassword: true },
  });
  const result = { employeeId: employee.id, passwordReset: true, mustChangePassword: true };
  await recordAudit({ ...auditBase, dataBefore: { authVersion: employee.authVersion, mustChangePassword: employee.mustChangePassword }, dataAfter: { authVersion: employee.authVersion + 1, mustChangePassword: true }, confirmed: true, result: "success" });
  return ok(200, result);
}
