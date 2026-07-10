import { prisma } from "../db.js";
import type { AuthedUser } from "../middleware/auth.js";

// Memory Model — Pattern Detection (read-only foundation only).
//
// This is explicitly a different, lower-trust layer than the Learning
// Engine (learningService.ts / LearningRule): the Learning Engine only ever
// creates a rule from an explicit user statement/correction. This module
// instead looks for *repeated manual action sequences* in the real
// AuditLog — a much weaker signal — so per the vcubf-programmer-skill
// Learning rule ("the strongest learning signal is explicit user
// correction... do not create permanent rules from one weak signal"),
// detectRepeatedActionPatterns() NEVER creates a Playbook, a LearningRule,
// or any other persisted record. It only returns a structured analysis for
// a human to review. Turning a surfaced pattern into a real Playbook is a
// deliberate, separate, user-initiated action via the Playbook Engine
// (see playbookService.ts) — this module never calls it automatically.
//
// Candidate patterns for human review only — never auto-creates a
// Playbook, matching the Learning Engine's explicit-correction-only rule.

// Fixed, conservative starting point — deliberately not user-configurable
// yet. 30 days mirrors the short, rolling-window convention already used
// elsewhere in this codebase for time-bounded analysis (e.g.
// notificationService.QUOTE_EXPIRY_WARNING_WINDOW_DAYS uses a similar fixed,
// documented constant instead of an arbitrary unbounded scan).
export const PATTERN_DETECTION_WINDOW_DAYS = 30;

// A sequence must recur at least this many times before it is even
// surfaced for review. 3 is a fixed, conservative starting point chosen so
// a single coincidental pair of actions (a "one weak signal" case) can
// never be reported as a candidate pattern. This threshold is intentionally
// hardcoded here, not configurable per company, until real usage data
// justifies tuning it.
export const MIN_PATTERN_OCCURRENCES = 3;

// How many consecutive distinct actions form one candidate sequence. Kept
// at 2 for this foundational slice (the simplest possible "A then B"
// pattern) — longer sequences are a natural future extension of the same
// grouping logic, not implemented here.
const SEQUENCE_LENGTH = 2;

export interface RepeatedActionPattern {
  actionSequence: string[];
  occurrenceCount: number;
  exampleTimestamps: string[];
}

// detect_action_patterns — risk 0, read-only. Scans this company's own
// AuditLog entries (never another company's — multi-tenant scoping matches
// every other service in this codebase) over the last
// PATTERN_DETECTION_WINDOW_DAYS, orders them chronologically per user, and
// looks at every consecutive pair of distinct actionName values performed
// by the same user. A pair that recurs at least MIN_PATTERN_OCCURRENCES
// times across the window is returned as a candidate pattern. This is pure
// analysis: it never writes anything, never creates a Playbook, and never
// changes any other record.
export async function detectRepeatedActionPatterns(user: AuthedUser): Promise<RepeatedActionPattern[]> {
  const windowStart = new Date(Date.now() - PATTERN_DETECTION_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const logs = await prisma.auditLog.findMany({
    where: {
      companyId: user.companyId,
      createdAt: { gte: windowStart },
      result: "success",
    },
    orderBy: [{ userId: "asc" }, { createdAt: "asc" }],
    select: { userId: true, actionName: true, createdAt: true },
  });

  // Group by userId first — a "repeated pattern" is a sequence one real
  // person actually performed manually, twice or more, not an artefact of
  // interleaving two different users' unrelated actions in a single global
  // timeline.
  const byUser = new Map<string, { actionName: string; createdAt: Date }[]>();
  for (const log of logs) {
    const key = log.userId ?? "unknown";
    if (!byUser.has(key)) byUser.set(key, []);
    byUser.get(key)!.push({ actionName: log.actionName, createdAt: log.createdAt });
  }

  // sequenceKey -> occurrences (each occurrence keeps the timestamp of the
  // first action in that occurrence, for exampleTimestamps).
  const occurrences = new Map<string, { actionSequence: string[]; timestamps: Date[] }>();

  for (const entries of byUser.values()) {
    for (let i = 0; i + SEQUENCE_LENGTH <= entries.length; i++) {
      const window = entries.slice(i, i + SEQUENCE_LENGTH);
      const actionSequence = window.map((e) => e.actionName);

      // Only consecutive *distinct* action names count as a "sequence" —
      // repeating the exact same action back-to-back (e.g. two quick
      // corrections of the same record) is not the kind of workflow pattern
      // a Playbook is meant to capture.
      const allDistinct = new Set(actionSequence).size === actionSequence.length;
      if (!allDistinct) continue;

      const key = actionSequence.join(">");
      if (!occurrences.has(key)) occurrences.set(key, { actionSequence, timestamps: [] });
      occurrences.get(key)!.timestamps.push(window[0].createdAt);
    }
  }

  const patterns: RepeatedActionPattern[] = [];
  for (const { actionSequence, timestamps } of occurrences.values()) {
    if (timestamps.length < MIN_PATTERN_OCCURRENCES) continue;
    patterns.push({
      actionSequence,
      occurrenceCount: timestamps.length,
      exampleTimestamps: timestamps.map((t) => t.toISOString()),
    });
  }

  patterns.sort((a, b) => b.occurrenceCount - a.occurrenceCount);

  return patterns;
}
