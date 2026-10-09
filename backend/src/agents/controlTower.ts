import { prisma } from "../db.js";
import { buildId } from "../lib/buildInfo.js";
import { pendingReviewsOverview } from "../lib/executionEngine.js";
import { MODEL_TASKS, modelFor } from "../lib/modelGateway.js";
import { safeModeSince } from "../lib/safeMode.js";
import { shadowSettings } from "./shadowAgent.js";

/**
 * Agent Control Tower v1 — masterplan layer I, project description §57.
 *
 * One read-only view of what the AI side of Secretary is doing for a company:
 * which build and models run, whether the shadow agent is on, whether the
 * emergency stop is on, what waits for a yes, and the latest agent runs. It
 * changes nothing and holds no message text: agent runs store fingerprints
 * only (D4), and waiting reviews are shown without their payload.
 *
 * The acceptance verdict of the shadow stays in shadowSummary
 * (GET /audit/agent-shadow); this view links to it rather than repeating it.
 */

const RECENT_RUNS = 50;
const DAY_MS = 24 * 60 * 60 * 1000;

interface StoredProposal {
  tool?: unknown;
  kind?: unknown;
  valid?: unknown;
}

/** Only the names and kinds of proposed tools; their argument fingerprints mean nothing to a reader. */
function proposedToolNames(value: unknown): Array<{ tool: string; kind: string; valid: boolean }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: StoredProposal) =>
    typeof entry?.tool === "string"
      ? [{ tool: entry.tool, kind: typeof entry.kind === "string" ? entry.kind : "unknown", valid: entry.valid === true }]
      : []);
}

export async function controlTowerOverview(companyId: string, now = new Date()) {
  const since = new Date(now.getTime() - DAY_MS);
  const [stop, pendingReviews, runs, lastDay] = await Promise.all([
    safeModeSince(companyId),
    pendingReviewsOverview(companyId, now),
    prisma.agentRun.findMany({
      where: { companyId },
      orderBy: { createdAt: "desc" },
      take: RECENT_RUNS,
      select: {
        id: true, createdAt: true, mode: true, channel: true, language: true, status: true, errorCode: true,
        steps: true, proposedTools: true, parserIntent: true, parserAction: true, agreement: true,
        model: true, build: true, tokensIn: true, tokensOut: true, durationMs: true,
        user: { select: { displayName: true } },
      },
    }),
    prisma.agentRun.groupBy({
      by: ["agreement"],
      where: { companyId, createdAt: { gte: since } },
      _count: { _all: true },
      _sum: { tokensIn: true, tokensOut: true },
    }),
  ]);

  const lastDayTotals = lastDay.reduce(
    (totals, group) => ({
      runs: totals.runs + group._count._all,
      errors: totals.errors + (group.agreement === "error" ? group._count._all : 0),
      tokensIn: totals.tokensIn + (group._sum.tokensIn ?? 0),
      tokensOut: totals.tokensOut + (group._sum.tokensOut ?? 0),
    }),
    { runs: 0, errors: 0, tokensIn: 0, tokensOut: 0 },
  );

  return {
    generatedAt: now,
    build: buildId(),
    safeMode: { enabled: stop !== null, since: stop },
    shadow: shadowSettings(),
    models: MODEL_TASKS.map((task) => ({ task, model: modelFor(task) })),
    pendingReviews,
    lastDay: lastDayTotals,
    recentRuns: runs.map(({ user, proposedTools, ...run }) => ({
      ...run,
      userName: user.displayName,
      proposedTools: proposedToolNames(proposedTools),
    })),
  };
}
