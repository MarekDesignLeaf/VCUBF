import type { NextFunction, Request, Response } from "express";
import { prisma } from "../db.js";

/**
 * Emergency stop — masterplan layer H, project description §49.
 *
 * An administrator can switch a company into safe mode. From that moment
 * nothing new is changed or sent for the company — no write, no message, no
 * calendar change, no confirmation of a waiting review, no scheduled send —
 * while everything needed to understand and contain the situation keeps
 * working: reading, the audit log, signing in, voice for questions, the
 * administrator's containment steps (below) and the switch itself.
 *
 * Enforced in layers, so a path forgotten by one layer is still caught by the
 * next:
 *   1. HTTP: every authenticated POST/PUT/PATCH/DELETE is refused (423) unless
 *      it is on the short list below (requireAuth).
 *   2. Commands: voice, text and playbook commands that are not pure reads are
 *      refused with a spoken answer (dispatchParsedCommand).
 *   3. Engine: no reviewed action can be claimed (claimReviewedAction), so a
 *      "yes" executes nothing whatever path it came by.
 *   4. Background: the connector sync and the notification digest skip the
 *      company, checked again for every item of a sweep already running.
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

function isAdministratorRole(role: string | undefined) {
  return role === "administrator" || role === "admin";
}

interface MutationRequest {
  method: string;
  /** Mount path + route path, without the query string. */
  path: string;
  body?: unknown;
  role?: string;
}

interface AllowedMutation {
  /** Matched case-insensitively, like Express routes. */
  pattern: RegExp;
  methods?: string[];
  administratorOnly?: boolean;
  body?: (body: unknown) => boolean;
  reason: string;
}

/**
 * Writes that stay possible in safe mode. Each is the way out, the way in, a
 * command endpoint whose commands are judged one by one (layer 2), the voice
 * session's own bookkeeping, or an administrator's step that only takes
 * access away — the things needed to contain an incident without lifting the
 * stop for everything else.
 */
const ALLOWED_IN_SAFE_MODE: AllowedMutation[] = [
  { pattern: /^\/company\/safe-mode$/i, reason: "the switch itself (administrator check in the route)" },
  {
    // Not device approval: that would hand out a new long-lived credential.
    pattern: /^\/auth(?!\/device\/approve(\/|$))(\/|$)/i,
    reason: "signing in, own password and own voice preferences",
  },
  { pattern: /^\/command\/(text|assistant)$/i, reason: "each command is judged by its own mode in dispatchParsedCommand" },
  { pattern: /^\/command\/(transcribe|speak|realtime\/session)$/i, reason: "speech in and out; changes nothing" },
  {
    // Not DELETE: clearing the voice history removes transcripts that may be
    // the only record of what was dictated during the incident.
    pattern: /^\/command\/voice-(state|conversations)(\/|$)/i,
    methods: ["POST", "PUT", "PATCH"],
    reason: "the voice session's own bookkeeping",
  },
  { pattern: /^\/command\/macros\/[^/]+\/ran$/i, methods: ["POST"], reason: "usage counter of a client-side shortcut" },
  // Containment — administrators only, and only steps that take access away.
  {
    pattern: /^\/crm\/employees\/[^/]+\/reset-password$/i,
    methods: ["POST"],
    administratorOnly: true,
    reason: "a new temporary password signs the account out everywhere",
  },
  {
    pattern: /^\/crm\/employees\/[^/]+$/i,
    methods: ["PUT"],
    administratorOnly: true,
    // The deactivation and its confirmation flag only: the service previews
    // first and needs confirmed:true to apply, like every employee change.
    body: (body) => Boolean(body) && typeof body === "object" && !Array.isArray(body)
      && Object.keys(body as object).every((key) => key === "is_active" || key === "confirmed")
      && (body as { is_active?: unknown }).is_active === false,
    reason: "deactivating an account, and nothing else in the same request",
  },
  {
    pattern: /^\/company\/agent-mode$/i,
    methods: ["PUT"],
    administratorOnly: true,
    body: (body) => Boolean(body) && typeof body === "object" && (body as { enabled?: unknown }).enabled === false,
    reason: "switching the agent off; switching it on stays refused",
  },
  {
    pattern: /^\/connectors\/sources\/[^/]+\/disable$/i,
    methods: ["POST"],
    administratorOnly: true,
    reason: "turning a connector off; local only, also drops its pending OAuth states",
  },
];

export function mutationAllowedInSafeMode(request: MutationRequest): boolean {
  if (!MUTATING.has(request.method)) return true;
  return ALLOWED_IN_SAFE_MODE.some((entry) =>
    entry.pattern.test(request.path)
    && (!entry.methods || entry.methods.includes(request.method))
    && (!entry.administratorOnly || isAdministratorRole(request.role))
    && (!entry.body || entry.body(request.body)));
}

/**
 * Layer 1. Runs inside requireAuth, after the idempotency guard: a retry of a
 * request that finished before the stop still gets its original answer, and
 * the idempotency guard never keeps a SAFE_MODE_ACTIVE refusal, so a retry
 * after the stop is lifted is carried out.
 */
export async function safeModeGate(req: Request, res: Response, next: NextFunction) {
  if (!req.user || !MUTATING.has(req.method)) return next();
  const path = `${req.baseUrl}${req.path}`.replace(/\/+$/, "") || "/";
  if (mutationAllowedInSafeMode({ method: req.method, path, body: req.body, role: req.user.role })) return next();
  // requireAuth reads the flag with the user; the lookup is only a fallback.
  const since = req.safeModeSince !== undefined ? req.safeModeSince : await safeModeSince(req.user.companyId);
  if (!since) return next();
  return res.status(423).json({ error: SAFE_MODE_ACTIVE, message: safeModeMessage(req.user.voiceLanguage) });
}
