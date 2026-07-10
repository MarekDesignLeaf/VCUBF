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
