import { prisma } from "../db.js";
import type { AuthedUser } from "../middleware/auth.js";
import { ACTIVE_JOB_STATUSES, computeEmployeeCapacity, getWeekRange, projectCapacityWithJob } from "./capacityService.js";

// Calendar and Scheduling Intelligence Module.
//
// This module deliberately does NOT build a full calendar-grid/day-level
// scheduler. It answers the two real business questions the architecture
// asks for: "what is actually happening in the coming weeks" (agenda) and
// "are we about to be overloaded, and what are our real options" (overload
// detection) — both computed from real job/employee data, never invented.

export interface CalendarJobsFilter {
  from: Date;
  to: Date;
}

// Real agenda of jobs with a planned date in the given window — the backing
// data for a calendar view. Includes jobs regardless of whether they have an
// estimate, because an agenda must show all planned work, not just the work
// capacity math can use.
export async function getCalendarJobs(user: AuthedUser, filter: CalendarJobsFilter) {
  return prisma.job.findMany({
    where: {
      companyId: user.companyId,
      plannedStartAt: { gte: filter.from, lt: filter.to },
    },
    include: {
      client: { select: { id: true, displayName: true } },
      assignedUser: { select: { id: true, displayName: true } },
    },
    orderBy: { plannedStartAt: "asc" },
  });
}

// The standard menu of realistic mitigation options for overload, taken
// directly from the VCUF master documentation / project instructions
// (section 6). This is structured operational guidance, not a fabricated
// business fact — it is attached to every overload finding so the user has
// real options to choose from, rather than just a red flag.
export const OVERLOAD_MITIGATIONS = [
  "Reschedule lower-priority work to a less busy week",
  "Split the job into stages across multiple weeks",
  "Assign the extra work to another employee with spare capacity",
  "Use a subcontractor for this job",
  "Hire a temporary worker",
  "Start recruitment for an additional employee in this skill area",
  "Increase prices for less desirable/lower-priority work to reduce demand",
  "Temporarily stop accepting this type of work",
  "Create a waiting list and offer the next real available week",
  "Improve material/equipment preparation lead time if that is the bottleneck",
] as const;

export interface OverloadFinding {
  employeeId: string;
  employeeName: string;
  weekStart: string;
  weekEnd: string;
  weeklyCapacityHours: number;
  currentLoadHours: number;
  utilizationPct: number;
}

export interface OverloadReport {
  generatedAt: string;
  weeksAhead: number;
  overloadedWeeks: OverloadFinding[];
  suggestions: readonly string[];
}

// Scans the next `weeksAhead` weeks (starting this week) for every active
// employee and reports every week where their real computed load exceeds
// their declared weekly capacity. Detection only — nothing is changed.
export async function detectUpcomingOverload(user: AuthedUser, weeksAhead: number = 4): Promise<OverloadReport> {
  const employees = await prisma.user.findMany({
    where: { companyId: user.companyId, isActive: true },
    select: { id: true },
  });

  const { weekStart: thisWeekStart } = getWeekRange(new Date());
  const overloadedWeeks: OverloadFinding[] = [];

  for (const employee of employees) {
    for (let w = 0; w < weeksAhead; w++) {
      const reference = new Date(thisWeekStart);
      reference.setUTCDate(reference.getUTCDate() + w * 7);
      const capacity = await computeEmployeeCapacity(user, employee.id, reference);
      if (capacity && capacity.overloaded) {
        overloadedWeeks.push({
          employeeId: capacity.employeeId,
          employeeName: capacity.employeeName,
          weekStart: capacity.weekStart,
          weekEnd: capacity.weekEnd,
          weeklyCapacityHours: capacity.weeklyCapacityHours,
          currentLoadHours: capacity.currentLoadHours,
          utilizationPct: capacity.utilizationPct,
        });
      }
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    weeksAhead,
    overloadedWeeks,
    suggestions: overloadedWeeks.length > 0 ? OVERLOAD_MITIGATIONS : [],
  };
}

export interface SuggestedEmployee {
  employeeId: string;
  employeeName: string;
  hasAllRequiredSkills: boolean;
  missingSkills: string[];
  earliestAvailableWeekStart: string | null;
  earliestAvailableWeekLoadHours: number | null;
  weeklyCapacityHours: number;
}

// Ranks active employees for a hypothetical new job by REAL spare capacity —
// the earliest upcoming week in which adding this job would not overload
// them — and by whether they hold the job's required skills. Employees with
// no non-overloaded week in the window get earliestAvailableWeekStart: null
// (never silently omitted, and never assigned a date that isn't real).
export async function suggestEmployeesForJob(
  user: AuthedUser,
  input: { estimatedDurationHours: number | null; requiredSkills: string[]; weeksAhead?: number }
): Promise<SuggestedEmployee[]> {
  const weeksAhead = input.weeksAhead ?? 4;
  const employees = await prisma.user.findMany({
    where: { companyId: user.companyId, isActive: true },
    select: { id: true, displayName: true, skills: true, weeklyCapacityHours: true },
  });

  const { weekStart: thisWeekStart } = getWeekRange(new Date());
  const results: SuggestedEmployee[] = [];

  for (const employee of employees) {
    const missingSkills = input.requiredSkills.filter((s) => !employee.skills.includes(s));
    let earliestAvailableWeekStart: string | null = null;
    let earliestAvailableWeekLoadHours: number | null = null;

    for (let w = 0; w < weeksAhead; w++) {
      const reference = new Date(thisWeekStart);
      reference.setUTCDate(reference.getUTCDate() + w * 7);
      const projection = await projectCapacityWithJob(user, employee.id, input.estimatedDurationHours, reference);
      if (projection && !projection.wouldBeOverloaded) {
        earliestAvailableWeekStart = projection.weekStart;
        earliestAvailableWeekLoadHours = projection.projectedLoadHours;
        break;
      }
    }

    results.push({
      employeeId: employee.id,
      employeeName: employee.displayName,
      hasAllRequiredSkills: missingSkills.length === 0,
      missingSkills,
      earliestAvailableWeekStart,
      earliestAvailableWeekLoadHours,
      weeklyCapacityHours: employee.weeklyCapacityHours,
    });
  }

  // Best candidates first: has all required skills, then has a real
  // available week at all, then soonest available week.
  results.sort((a, b) => {
    if (a.hasAllRequiredSkills !== b.hasAllRequiredSkills) return a.hasAllRequiredSkills ? -1 : 1;
    const aAvail = a.earliestAvailableWeekStart;
    const bAvail = b.earliestAvailableWeekStart;
    if (!!aAvail !== !!bAvail) return aAvail ? -1 : 1;
    if (aAvail && bAvail) return aAvail.localeCompare(bAvail);
    return 0;
  });

  return results;
}
