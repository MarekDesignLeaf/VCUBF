import { z } from "zod";
import { prisma } from "../db.js";
import { recordAudit } from "../lib/audit.js";
import { CREATE_LEARNING_RULE_ACTION, UPDATE_LEARNING_RULE_ACTION, LEARNING_RULE_STATUSES } from "../lib/actionContracts.js";
import type { AuthedUser } from "../middleware/auth.js";
import { fail, ok, type ServiceResult } from "./result.js";

// Learning Engine. Every rule is created from an explicit user statement —
// never inferred from a single weak signal — and stays visible, editable
// and reversible (archive, not silent hard-delete). A rule with aliasFor set
// doubles as a real text-substitution step, applied before the Voice/Text
// Command Layer parses a command, so what gets learned actually changes how
// commands are interpreted rather than sitting in an unused glossary.

export const createLearningRuleSchema = z.object({
  term: z.string().min(1, "term is required"),
  meaning: z.string().min(1, "meaning is required"),
  alias_for: z.string().min(1).optional(),
  category: z.string().optional(),
});

export const updateLearningRuleSchema = z.object({
  term: z.string().min(1).optional(),
  meaning: z.string().min(1).optional(),
  alias_for: z.string().min(1).nullable().optional(),
  category: z.string().optional(),
  status: z.enum(LEARNING_RULE_STATUSES).optional(),
});

export async function listLearningRules(user: AuthedUser, filters: { status?: string } = {}) {
  return prisma.learningRule.findMany({
    where: { companyId: user.companyId, ...(filters.status ? { status: filters.status } : {}) },
    orderBy: { createdAt: "desc" },
  });
}

export async function getLearningRule(user: AuthedUser, id: string) {
  return prisma.learningRule.findFirst({ where: { id, companyId: user.companyId } });
}

// create_learning_rule — Action Contract driven.
export async function createLearningRule(user: AuthedUser, rawInput: unknown): Promise<ServiceResult<unknown>> {
  const parsed = createLearningRuleSchema.safeParse(rawInput);
  if (!parsed.success) {
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: CREATE_LEARNING_RULE_ACTION.actionName,
      inputPayload: rawInput,
      riskLevel: CREATE_LEARNING_RULE_ACTION.riskLevel,
      confirmationRequired: CREATE_LEARNING_RULE_ACTION.confirmationRequired,
      result: "error",
      errorMessage: "VALIDATION_FAILED",
    });
    return fail(400, "VALIDATION_FAILED", parsed.error.message);
  }
  const data = parsed.data;

  const created = await prisma.learningRule.create({
    data: {
      companyId: user.companyId,
      term: data.term,
      meaning: data.meaning,
      aliasFor: data.alias_for,
      category: data.category,
      createdBy: user.id,
    },
  });

  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: CREATE_LEARNING_RULE_ACTION.actionName,
    inputPayload: data,
    dataAfter: created,
    riskLevel: CREATE_LEARNING_RULE_ACTION.riskLevel,
    confirmationRequired: CREATE_LEARNING_RULE_ACTION.confirmationRequired,
    result: "success",
  });

  return ok(201, created);
}

// update_learning_rule — Action Contract driven.
export async function updateLearningRule(user: AuthedUser, id: string, rawInput: unknown): Promise<ServiceResult<unknown>> {
  const parsed = updateLearningRuleSchema.safeParse(rawInput);
  if (!parsed.success) {
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: UPDATE_LEARNING_RULE_ACTION.actionName,
      inputPayload: { id, ...(typeof rawInput === "object" && rawInput ? rawInput : {}) },
      riskLevel: UPDATE_LEARNING_RULE_ACTION.riskLevel,
      confirmationRequired: UPDATE_LEARNING_RULE_ACTION.confirmationRequired,
      result: "error",
      errorMessage: "VALIDATION_FAILED",
    });
    return fail(400, "VALIDATION_FAILED", parsed.error.message);
  }
  const data = parsed.data;

  const existing = await prisma.learningRule.findFirst({ where: { id, companyId: user.companyId } });
  if (!existing) {
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: UPDATE_LEARNING_RULE_ACTION.actionName,
      inputPayload: { id, ...data },
      riskLevel: UPDATE_LEARNING_RULE_ACTION.riskLevel,
      confirmationRequired: UPDATE_LEARNING_RULE_ACTION.confirmationRequired,
      result: "error",
      errorMessage: "LEARNING_RULE_NOT_FOUND",
    });
    return fail(404, "LEARNING_RULE_NOT_FOUND");
  }

  const changes: Record<string, unknown> = {};
  if (data.term !== undefined) changes.term = data.term;
  if (data.meaning !== undefined) changes.meaning = data.meaning;
  if (data.alias_for !== undefined) changes.aliasFor = data.alias_for;
  if (data.category !== undefined) changes.category = data.category;
  if (data.status !== undefined) changes.status = data.status;

  const updated = await prisma.learningRule.update({ where: { id: existing.id }, data: changes });

  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: UPDATE_LEARNING_RULE_ACTION.actionName,
    inputPayload: { id, changes },
    dataBefore: existing,
    dataAfter: updated,
    riskLevel: UPDATE_LEARNING_RULE_ACTION.riskLevel,
    confirmationRequired: UPDATE_LEARNING_RULE_ACTION.confirmationRequired,
    result: "success",
  });

  return ok(200, updated);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface AppliedAlias {
  term: string;
  aliasFor: string;
}

export interface AliasResolution {
  originalText: string;
  resolvedText: string;
  appliedRules: AppliedAlias[];
}

// Applied before parseTextCommand in both the /command/text route and
// playbook step execution, so a learned alias genuinely changes how a
// command is interpreted — not just a glossary entry nobody reads. Only
// active rules with aliasFor set participate; longer terms are matched
// first so a more specific alias wins over a shorter one it contains.
export async function resolveLearningAliases(user: AuthedUser, text: string): Promise<AliasResolution> {
  const rules = await prisma.learningRule.findMany({
    where: { companyId: user.companyId, status: "active", aliasFor: { not: null } },
  });
  if (rules.length === 0) {
    return { originalText: text, resolvedText: text, appliedRules: [] };
  }

  // Single left-to-right pass over the ORIGINAL text using one combined
  // regex, longest term first, so a more specific alias ("Oak Home") wins
  // over a shorter one it contains ("Oak") without ever re-scanning text
  // that a previous substitution already produced (which could otherwise
  // cause a term to match again inside its own replacement).
  // Longest term first, so a more specific alias ("Oak Home") wins over a
  // shorter one it contains ("Oak").
  const sorted = [...rules].sort((a, b) => b.term.length - a.term.length);

  // Match against a diacritics-folded copy of the text. Learned voice aliases
  // are stored folded, so without this a phrase could be learned and then never
  // recognised. The fold preserves length, so indices into the folded text
  // address the original text directly and untouched words keep their accents.
  const folded = foldForMatch(text);
  if (folded.length !== text.length) {
    return { originalText: text, resolvedText: text, appliedRules: [] };
  }

  // Spoken input has unpredictable spacing, so a stored "ukaz zakazniky"
  // must still match "ukaz  zakazniky".
  const pattern = sorted
    .map((rule) => escapeRegExp(foldForMatch(rule.term)).replace(/\\?\s+/g, "\\s+"))
    .join("|");
  const combined = new RegExp(`(?<![\\p{L}\\p{N}])(${pattern})(?![\\p{L}\\p{N}])`, "gu");

  const appliedRules: AppliedAlias[] = [];
  let resolvedText = "";
  let cursor = 0;
  for (const match of folded.matchAll(combined)) {
    const index = match.index ?? 0;
    const hit = collapseSpaces(match[0]);
    const rule = sorted.find((r) => collapseSpaces(foldForMatch(r.term)) === hit);
    if (!rule) continue;
    // Single left-to-right pass over the ORIGINAL text: text a previous
    // substitution produced is never re-scanned, so a term cannot match again
    // inside its own replacement.
    resolvedText += text.slice(cursor, index) + rule.aliasFor!;
    appliedRules.push({ term: rule.term, aliasFor: rule.aliasFor! });
    cursor = index + match[0].length;
  }
  resolvedText += text.slice(cursor);

  return { originalText: text, resolvedText, appliedRules };
}


/**
 * Lowercases and strips Czech diacritics for comparison, one character in and
 * one character out. Length must be preserved: the caller relies on indices
 * into the folded string pointing at the same place in the original.
 */
const DIACRITICS: Record<string, string> = {
  "á": "a", "ä": "a", "â": "a", "à": "a", "å": "a", "ã": "a",
  "č": "c", "ć": "c", "ç": "c",
  "ď": "d", "đ": "d",
  "é": "e", "ě": "e", "ë": "e", "ê": "e", "è": "e",
  "í": "i", "ï": "i", "î": "i", "ì": "i",
  "ĺ": "l", "ľ": "l", "ł": "l",
  "ň": "n", "ń": "n", "ñ": "n",
  "ó": "o", "ö": "o", "ô": "o", "ò": "o", "õ": "o", "ø": "o",
  "ŕ": "r", "ř": "r",
  "š": "s", "ś": "s", "ş": "s",
  "ť": "t",
  "ú": "u", "ů": "u", "ü": "u", "û": "u", "ù": "u",
  "ý": "y", "ÿ": "y",
  "ž": "z", "ź": "z", "ż": "z",
};

export function foldForMatch(value: string): string {
  let out = "";
  for (const char of value.toLowerCase()) out += DIACRITICS[char] ?? char;
  return out;
}

function collapseSpaces(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}