import type { NextFunction, Request, Response } from "express";
import { prisma } from "../db.js";

/**
 * Emergency stop — masterplan layer H, project description §49.
 *
 * An administrator can switch a company into safe mode. From that moment
 * nothing new is changed or sent for the company — no write, no message, no
 * calendar change, no confirmation of a waiting review, no scheduled send —
 * while everything needed to understand the situation keeps working: reading,
 * the audit log, signing in, voice for questions, and the switch itself.
 *
 * Enforced in layers, so a path forgotten by one layer is still caught by the
 * next:
 *   1. HTTP: every authenticated POST/PUT/PATCH/DELETE is refused (423) unless
 *      its path is on the short list below (requireAuth).
 *   2. Commands: voice, text and playbook commands that are not pure reads are
 *      refused with a spoken answer (dispatchParsedCommand).
 *   3. Engine: no reviewed action can be claimed (claimReviewedAction), so a
 *      "yes" executes nothing whatever path it came by.
 *   4. Background: the connector sync and the notification digest skip the
 *      company.
 *
 * Secretary has no tool for this switch: it is an administrator's decision in
 * Company settings and is audited at risk 4.
 */

export const SAFE_MODE_ACTIVE = "SAFE_MODE_ACTIVE";

/** Thrown where a refusal cannot be answered in place; the error handler answers 423. */
export class SafeModeActiveError extends Error {
  readonly code = SAFE_MODE_ACTIVE;
  constructor() {
    super("Emergency stop is on for this company.");
  }
}

export async function safeModeSince(companyId: string): Promise<Date | null> {
  const company = await prisma.company.findUnique({ where: { id: companyId }, select: { safeModeSince: true } });
  return company?.safeModeSince ?? null;
}

export async function assertNotInSafeMode(companyId: string): Promise<void> {
  if (await safeModeSince(companyId)) throw new SafeModeActiveError();
}

export function safeModeMessage(language: string | undefined): string {
  const locale = (language ?? "en").slice(0, 2).toLowerCase();
  if (locale === "cs") return "Nouzové zastavení je zapnuté: nic neměním ani neodesílám. Číst a odpovídat na otázky můžu dál. Vypnout ho může správce v nastavení firmy.";
  if (locale === "pl") return "Awaryjne zatrzymanie jest włączone: niczego nie zmieniam ani nie wysyłam. Nadal mogę czytać i odpowiadać na pytania. Wyłączyć je może administrator w ustawieniach firmy.";
  return "Emergency stop is on: I am not changing or sending anything. I can still read and answer questions. An administrator can switch it off in Company settings.";
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Writes that stay possible in safe mode. Each is either the way out, the way
 * in, a command endpoint whose commands are judged one by one (layer 2), or
 * bookkeeping of the voice session itself, which changes no business data.
 */
const ALLOWED_IN_SAFE_MODE: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /^\/company\/safe-mode$/, reason: "the switch itself" },
  { pattern: /^\/auth(\/|$)/, reason: "signing in, own password and own voice preferences" },
  { pattern: /^\/command\/(text|assistant)$/, reason: "each command is judged by its own mode in dispatchParsedCommand" },
  { pattern: /^\/command\/(transcribe|speak|realtime\/session)$/, reason: "speech in and out; changes nothing" },
  { pattern: /^\/command\/voice-(state|conversations)(\/|$)/, reason: "the voice session's own bookkeeping; clearing the history only withdraws" },
  { pattern: /^\/command\/macros\/[^/]+\/ran$/, reason: "usage counter of a client-side shortcut" },
];

export function mutationAllowedInSafeMode(method: string, path: string): boolean {
  if (!MUTATING.has(method)) return true;
  return ALLOWED_IN_SAFE_MODE.some((entry) => entry.pattern.test(path));
}

/** Layer 1. Runs inside requireAuth, where the company becomes known. */
export async function safeModeGate(req: Request, res: Response, next: NextFunction) {
  const path = `${req.baseUrl}${req.path}`.replace(/\/+$/, "") || "/";
  if (!req.user || mutationAllowedInSafeMode(req.method, path)) return next();
  if (!(await safeModeSince(req.user.companyId))) return next();
  return res.status(423).json({ error: SAFE_MODE_ACTIVE, message: safeModeMessage(req.user.voiceLanguage) });
}
