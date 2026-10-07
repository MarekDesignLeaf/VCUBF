import crypto from "node:crypto";
import { z } from "zod";
import { prisma } from "../db.js";
import type { AuthedUser } from "../middleware/auth.js";

/**
 * Commands the user taught by performing them.
 *
 * When the assistant does not recognise a command, describing it in words is
 * often harder than simply doing it. So the clicks and typing are recorded, the
 * user gives the recording one or two names, and saying either of them replays
 * it.
 *
 * The rule that shapes this file: a recording is stored once. Teaching the same
 * flow again does not create a second copy — it adds the new names to the one
 * already there, and the user is told that is what happened.
 */

/** One recorded interaction. */
export const macroStepSchema = z.object({
  kind: z.enum(["click", "type", "select", "check", "navigate", "submit"]),
  /** Where the step happened, in a form that survives a re-render. */
  target: z.string().trim().min(1).max(400),
  /** Human-readable label, for showing the recording back to the user. */
  label: z.string().trim().max(200).optional(),
  /** What was typed or chosen. Excluded from the fingerprint on purpose. */
  value: z.string().max(2000).optional(),
  /** The page the step happened on, so a replay can get there first. */
  path: z.string().trim().max(300).optional(),
});

export const saveMacroSchema = z.object({
  steps: z.array(macroStepSchema).min(1).max(200),
  // One or two names is what the assistant asks for; a few more is harmless.
  names: z.array(z.string().trim().min(2).max(60)).min(1).max(4),
});

export type MacroStep = z.infer<typeof macroStepSchema>;

/** Diacritics- and punctuation-insensitive, so "Nová zakázka" matches "nova zakazka". */
export function normalisePhrase(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Identity of a recording: what was done, in order, ignoring what was typed.
 *
 * Values are left out so the same flow performed with different text is
 * recognised as one command. Including them would fill the list with
 * near-identical macros whose only difference is a client name.
 */
export function fingerprintSteps(steps: MacroStep[]): string {
  const shape = steps.map((step) => `${step.kind}:${step.target}`).join("|");
  return crypto.createHash("sha256").update(shape).digest("hex");
}

export interface SaveMacroOutcome {
  macroId: string;
  /** True when this recording already existed and the names were added to it. */
  alreadyKnown: boolean;
  /** What that existing command is already called, for telling the user. */
  existingNames: string[];
  /** Names saved now. */
  addedNames: string[];
  /** Names that already pointed at a different command and were not moved. */
  takenNames: { name: string; usedBy: string }[];
}

/**
 * Save a recording under one or more spoken names.
 *
 * Returns what actually happened rather than throwing on a duplicate: the
 * assistant has to be able to say "you already taught me this, it is called X,
 * and I have added Y to it".
 */
export async function saveMacro(user: AuthedUser, rawInput: unknown): Promise<SaveMacroOutcome | null> {
  const parsed = saveMacroSchema.safeParse(rawInput);
  if (!parsed.success) return null;

  const steps = parsed.data.steps;
  const fingerprint = fingerprintSteps(steps);

  // A save can arrive twice at once: the window stops waiting after ten
  // seconds and the user is asked to say "save" again while the first request
  // may still be running. The unique keys decide which insert wins; the other
  // request reads what the winner stored instead of failing, so both answer
  // truthfully and nothing is stored twice.
  let macro = await prisma.voiceMacro.findFirst({ where: { companyId: user.companyId, fingerprint } });
  let alreadyKnown = macro !== null;
  if (!macro) {
    try {
      macro = await prisma.voiceMacro.create({
        data: {
          companyId: user.companyId,
          createdBy: user.id,
          fingerprint,
          steps: steps as never,
          stepCount: steps.length,
        },
      });
    } catch (error) {
      if (!isUniqueConflict(error)) throw error;
      macro = await prisma.voiceMacro.findFirstOrThrow({ where: { companyId: user.companyId, fingerprint } });
      alreadyKnown = true;
    }
  }

  const addedNames: string[] = [];
  const takenNames: { name: string; usedBy: string }[] = [];

  for (const spoken of parsed.data.names) {
    const term = normalisePhrase(spoken);
    if (!term) continue;

    const claimed = await prisma.voiceMacroName.findFirst({
      where: { companyId: user.companyId, term },
      include: { macro: { include: { names: true } } },
    });
    if (!claimed) {
      try {
        await prisma.voiceMacroName.create({
          data: { companyId: user.companyId, macroId: macro.id, term, spoken: spoken.trim() },
        });
        addedNames.push(spoken.trim());
        continue;
      } catch (error) {
        if (!isUniqueConflict(error)) throw error;
        // Claimed by a request that got there first; judged below like any other.
      }
    }
    const owner = claimed ?? await prisma.voiceMacroName.findFirstOrThrow({
      where: { companyId: user.companyId, term },
      include: { macro: { include: { names: true } } },
    });
    // Already this command. For a command this request created, the name can
    // only have come from a simultaneous save of the same recording, so it is
    // reported as saved: the answer must still say what to say next time.
    if (owner.macroId === macro.id) {
      if (!alreadyKnown) addedNames.push(owner.spoken);
      continue;
    }
    // Already another command: leave it where it is, because silently moving a
    // phrase would break the command it names.
    takenNames.push({
      name: spoken,
      usedBy: owner.macro.names[0]?.spoken ?? "jiný příkaz",
    });
  }

  // What the command was already called, read after the names above, so a
  // save that lost the race still reports the names the winner stored.
  const existingNames = alreadyKnown
    ? (await prisma.voiceMacroName.findMany({ where: { macroId: macro.id }, orderBy: { createdAt: "asc" } }))
      .map((name) => name.spoken)
      .filter((name) => !addedNames.includes(name))
    : [];

  return {
    macroId: macro.id,
    alreadyKnown,
    existingNames,
    addedNames,
    takenNames,
  };
}

/** Postgres unique violation, as Prisma reports it. */
function isUniqueConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002";
}

export interface MatchedMacro {
  id: string;
  steps: MacroStep[];
  matchedName: string;
  names: string[];
}

/**
 * The learned command a spoken phrase refers to, if any.
 *
 * Longest name first, so "nova zakazka pro klienta" is not swallowed by a
 * shorter "nova zakazka" that happens to be contained in it.
 */
export async function findMacroForPhrase(user: AuthedUser, spoken: string): Promise<MatchedMacro | null> {
  const text = normalisePhrase(spoken);
  if (!text) return null;

  const names = await prisma.voiceMacroName.findMany({
    where: { companyId: user.companyId, macro: { status: "active" } },
    include: { macro: { include: { names: true } } },
  });

  const sorted = [...names].sort((a, b) => b.term.length - a.term.length);
  const hit = sorted.find((name) => text === name.term || text.includes(name.term));
  if (!hit) return null;

  return {
    id: hit.macroId,
    steps: hit.macro.steps as unknown as MacroStep[],
    matchedName: hit.spoken,
    names: hit.macro.names.map((name) => name.spoken),
  };
}

export async function listMacros(user: AuthedUser) {
  return prisma.voiceMacro.findMany({
    where: { companyId: user.companyId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true, stepCount: true, status: true, lastRunAt: true, createdAt: true,
      names: { select: { spoken: true }, orderBy: { createdAt: "asc" } },
    },
  });
}

export async function deleteMacro(user: AuthedUser, id: string): Promise<boolean> {
  const existing = await prisma.voiceMacro.findFirst({ where: { id, companyId: user.companyId } });
  if (!existing) return false;
  await prisma.voiceMacro.delete({ where: { id } });
  return true;
}

export async function markMacroRun(user: AuthedUser, id: string) {
  await prisma.voiceMacro.updateMany({
    where: { id, companyId: user.companyId },
    data: { lastRunAt: new Date() },
  });
}
