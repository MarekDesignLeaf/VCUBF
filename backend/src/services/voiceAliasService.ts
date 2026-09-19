import { z } from "zod";
import { prisma } from "../db.js";
import type { AuthedUser } from "../middleware/auth.js";

/**
 * Learned voice aliases.
 *
 * Speech recognition mishears the same word the same way every time: "Emma"
 * comes back as "Ema", "Emo", "Ema," and so on. Rather than fighting the
 * recogniser, the phrase actually heard is learned and mapped onto what was
 * meant.
 *
 * Learning rule: a phrase must be heard IDENTICALLY three times before it
 * becomes active. One misrecognition can never create a permanent alias, and
 * three consistent ones are almost certainly how this microphone and this voice
 * really sound.
 *
 * Storage reuses LearningRule, which /command/assistant already applies before
 * parsing, so an alias learned here changes behaviour everywhere at once.
 *   term      what was heard          ("ema")
 *   aliasFor  what it means           ("Emma")
 *   category  "wake_word" | "voice_command"
 */

export const CONFIRMATIONS_REQUIRED = 3;
export const WAKE_WORD = "wake_word";
export const VOICE_COMMAND = "voice_command";

/** Diacritics- and punctuation-insensitive so "Éma," and "ema" are one phrase. */
export function normalisePhrase(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export const learnSchema = z.object({
  heard: z.string().trim().min(1).max(200),
  means: z.string().trim().min(1).max(200),
  category: z.enum([WAKE_WORD, VOICE_COMMAND]).default(VOICE_COMMAND),
});

export const aliasInputSchema = z.object({
  heard: z.string().trim().min(1).max(200),
  means: z.string().trim().min(1).max(200),
  category: z.enum([WAKE_WORD, VOICE_COMMAND]).default(VOICE_COMMAND),
  /** Set when the user adds an alias by hand — no repetitions needed. */
  immediate: z.boolean().default(true),
});

export interface LearnOutcome {
  status: "learning" | "active";
  confirmations: number;
  required: number;
  heard: string;
  means: string;
  category: string;
}

/**
 * Record one occurrence of a heard phrase. Returns how far along the learning
 * is, so the UI can show "2 of 3".
 */
export async function recordHeardPhrase(user: AuthedUser, rawInput: unknown): Promise<LearnOutcome | null> {
  const parsed = learnSchema.safeParse(rawInput);
  if (!parsed.success) return null;
  const heard = normalisePhrase(parsed.data.heard);
  const means = parsed.data.means.trim();
  if (!heard || !means) return null;
  // An alias that maps a phrase onto itself would be a no-op substitution.
  if (heard === normalisePhrase(means)) return null;

  const existing = await prisma.learningRule.findFirst({
    where: { companyId: user.companyId, term: heard, category: parsed.data.category },
  });

  if (!existing) {
    await prisma.learningRule.create({
      data: {
        companyId: user.companyId,
        term: heard,
        meaning: means,
        aliasFor: means,
        category: parsed.data.category,
        // Not active yet: one hearing proves nothing.
        status: "learning",
        confirmations: 1,
        lastHeardAt: new Date(),
        createdBy: user.id,
      },
    });
    return { status: "learning", confirmations: 1, required: CONFIRMATIONS_REQUIRED, heard, means, category: parsed.data.category };
  }

  // A different meaning restarts the count: the user changed their mind.
  const sameMeaning = existing.aliasFor === means;
  const confirmations = sameMeaning ? existing.confirmations + 1 : 1;
  const status = confirmations >= CONFIRMATIONS_REQUIRED ? "active" : "learning";
  await prisma.learningRule.update({
    where: { id: existing.id },
    data: { meaning: means, aliasFor: means, confirmations, status, lastHeardAt: new Date() },
  });
  return { status: status as "learning" | "active", confirmations, required: CONFIRMATIONS_REQUIRED, heard, means, category: existing.category ?? parsed.data.category };
}

/** Add or update an alias directly, bypassing repetitions. */
export async function upsertAlias(user: AuthedUser, rawInput: unknown) {
  const parsed = aliasInputSchema.safeParse(rawInput);
  if (!parsed.success) return null;
  const heard = normalisePhrase(parsed.data.heard);
  const means = parsed.data.means.trim();
  if (!heard || !means || heard === normalisePhrase(means)) return null;

  const existing = await prisma.learningRule.findFirst({
    where: { companyId: user.companyId, term: heard, category: parsed.data.category },
  });
  const data = {
    meaning: means,
    aliasFor: means,
    category: parsed.data.category,
    status: parsed.data.immediate ? "active" : "learning",
    confirmations: parsed.data.immediate ? CONFIRMATIONS_REQUIRED : 1,
    lastHeardAt: new Date(),
  };
  if (existing) return prisma.learningRule.update({ where: { id: existing.id }, data });
  return prisma.learningRule.create({
    data: { companyId: user.companyId, term: heard, createdBy: user.id, ...data },
  });
}

export async function listAliases(user: AuthedUser) {
  return prisma.learningRule.findMany({
    where: { companyId: user.companyId, category: { in: [WAKE_WORD, VOICE_COMMAND] } },
    orderBy: [{ status: "asc" }, { term: "asc" }],
    select: {
      id: true, term: true, aliasFor: true, category: true,
      status: true, confirmations: true, lastHeardAt: true,
    },
  });
}

export async function deleteAlias(user: AuthedUser, id: string) {
  const existing = await prisma.learningRule.findFirst({ where: { id, companyId: user.companyId } });
  if (!existing) return false;
  await prisma.learningRule.delete({ where: { id } });
  return true;
}

/** Active wake-word spellings, so the client accepts every learned variant. */
export async function activeWakeWordAliases(user: AuthedUser): Promise<string[]> {
  const rules = await prisma.learningRule.findMany({
    where: { companyId: user.companyId, category: WAKE_WORD, status: "active" },
    select: { term: true },
  });
  return rules.map((rule) => rule.term);
}

/**
 * Learned phrases handed to Whisper as vocabulary. Biasing the decoder towards
 * words this user actually says is what stops the same word being misheard over
 * and over, instead of only correcting it afterwards.
 */
export async function aliasVocabulary(companyId: string): Promise<string[]> {
  const rules = await prisma.learningRule.findMany({
    where: { companyId, status: "active", category: { in: [WAKE_WORD, VOICE_COMMAND] } },
    select: { aliasFor: true },
    take: 60,
  });
  return [...new Set(rules.map((rule) => rule.aliasFor).filter((value): value is string => Boolean(value)))];
}
