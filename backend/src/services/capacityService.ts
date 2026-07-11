import { prisma } from "../db.js";
import type { AuthedUser } from "../middleware/auth.js";

// Job Allocation and Capacity Management Module.
//
// The system must not offer or assign dates only because a calendar slot is
// empty — a real available date/capacity must be calculated from actual
// company data (see VCUF master documentation section 24A). This service is
// the one place that computation happens; nothing here is invented or
// estimated by a prompt.

export interface WeekRange {
  weekStart: Date;
  weekEnd: Date;
}

// ISO week: Monday 00:00:00 (UTC) through the following Monday (exclusive).
export function getWeekRange(reference: Date = new Date()): WeekRange {
  const d = new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth(), reference.getUTCDate()));
  const day = d.getUTCDay(); // 0 = Sunday
  const diffToMonday = (day + 6) % 7;
  d.setUTCDate(d.getUTCDate() - diffToMonday);
  const weekStart = d;
  const weekEnd = new Date(weekStart);
  weekEnd.setUTCDate(weekEnd.getUTCDate() + 7);
  return { weekStart, weekEnd };
}

export const ACTIVE_JOB_STATUSES = ["nova", "naplanovano", "v_realizaci", "ceka_na_material", "ceka_na_klienta"];
export const ACTIVE_TASK_STATUSES = ["open", "in_progress"];

export interface CapacityResult {
  employeeId: string;
  employeeName: string;
  weekStart: string;
  weekEnd: string;
  weeklyCapacityHours: number;
  currentLoadHours: number;
  jobsCountedInLoad: number;
  jobsMissingEstimate: number;
  tasksCountedInLoad: number;
  tasksMissingEstimate: number;
  utilizationPct: number;
  overloaded: boolean;
}

// Computes an employee's real workload for a week from active jobs and active
// Secretary tasks. Both must have a date in the week and an entered duration.
// Missing estimates are reported separately rather than silently guessed.
export async function computeEmployeeCapacity(
  user: AuthedUser,
  employeeId: string,
  reference: Date = new Date()
): Promise<CapacityResult | null> {
  const employee = await prisma.user.findFirst({ where: { id: employeeId, companyId: user.companyId } });
  if (!employee) return null;

  const { weekStart, weekEnd } = getWeekRange(reference);

  const [jobsInWeek, tasksInWeek] = await Promise.all([
    prisma.job.findMany({
      where: {
        companyId: user.companyId,
        assignedUserId: employeeId,
        jobStatus: { in: ACTIVE_JOB_STATUSES },
        plannedStartAt: { gte: weekStart, lt: weekEnd },
      },
      select: { id: true, estimatedDurationHours: true },
    }),
    prisma.task.findMany({
      where: {
        companyId: user.companyId,
        assignedUserId: employeeId,
        taskStatus: { in: ACTIVE_TASK_STATUSES },
        dueAt: { gte: weekStart, lt: weekEnd },
      },
      select: { id: true, estimatedDurationHours: true },
    }),
  ]);

  let currentLoadHours = 0;
  let jobsCountedInLoad = 0;
  let jobsMissingEstimate = 0;
  for (const job of jobsInWeek) {
    if (job.estimatedDurationHours == null) {
      jobsMissingEstimate += 1;
      continue;
    }
    currentLoadHours += job.estimatedDurationHours;
    jobsCountedInLoad += 1;
  }

  let tasksCountedInLoad = 0;
  let tasksMissingEstimate = 0;
  for (const task of tasksInWeek) {
    if (task.estimatedDurationHours == null) {
      tasksMissingEstimate += 1;
      continue;
    }
    currentLoadHours += task.estimatedDurationHours;
    tasksCountedInLoad += 1;
  }

  const utilizationPct = employee.weeklyCapacityHours > 0
    ? Math.round((currentLoadHours / employee.weeklyCapacityHours) * 100)
    : 0;

  return {
    employeeId: employee.id,
    employeeName: employee.displayName,
    weekStart: weekStart.toISOString(),
    weekEnd: weekEnd.toISOString(),
    weeklyCapacityHours: employee.weeklyCapacityHours,
    currentLoadHours,
    jobsCountedInLoad,
    jobsMissingEstimate,
    tasksCountedInLoad,
    tasksMissingEstimate,
    utilizationPct,
    overloaded: currentLoadHours > employee.weeklyCapacityHours,
  };
}

// Projects what an employee's load WOULD be if a given job (with its own
// estimated_duration_hours) were added, without writing anything. Used by
// assign_job to decide whether to surface an overload warning before
// committing the assignment.
export async function projectCapacityWithJob(
  user: AuthedUser,
  employeeId: string,
  additionalHours: number | null,
  reference: Date
): Promise<(CapacityResult & { projectedLoadHours: number; wouldBeOverloaded: boolean }) | null> {
  const base = await computeEmployeeCapacity(user, employeeId, reference);
  if (!base) return null;
  const projectedLoadHours = base.currentLoadHours + (additionalHours ?? 0);
  return {
    ...base,
    projectedLoadHours,
    wouldBeOverloaded: projectedLoadHours > base.weeklyCapacityHours,
  };
}
