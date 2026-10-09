import { prisma } from "../db.js";
import { shadowSummary } from "./shadowAgent.js";

/**
 * The per-company agent switch — masterplan F2, project description §39.
 *
 * Three conditions must all hold before the agent may act for a request:
 *  1. an administrator switched the agent on for the company (agentEnabledAt);
 *  2. the request's language and path (assistant or typed text) passed the
 *     shadow acceptance on the current build, model and tool set — English
 *     never vouches for Czech, typed commands never vouch for voice;
 *  3. the company is not in an emergency stop.
 *
 * Secretary has no tool for the switch, so it cannot raise its own autonomy.
 * Even when it may act, the agent only proposes; every write still goes
 * through a reviewed proposal and the user's yes (F2b).
 */

export type AgentChannel = "assistant" | "text";
export type AgentRefusal = "AGENT_OFF" | "SAFE_MODE" | "NOT_ACCEPTED";

export interface AgentSegment {
  language: string;
  channel: string;
}

export async function agentModeState(companyId: string) {
  const [company, summary] = await Promise.all([
    prisma.company.findUnique({ where: { id: companyId }, select: { agentEnabledAt: true, safeModeSince: true } }),
    shadowSummary(companyId),
  ]);
  const enabled = Boolean(company?.agentEnabledAt);
  const safeMode = Boolean(company?.safeModeSince);
  const accepted: AgentSegment[] = summary.acceptance.accepted;
  return {
    enabled,
    since: company?.agentEnabledAt ?? null,
    safeMode,
    /** Language and path pairs that passed the shadow acceptance. */
    accepted,
    /** Where the agent may act right now: switched on, accepted, no emergency stop. */
    effective: enabled && !safeMode ? accepted : [],
    cohort: summary.cohort,
  };
}

export async function agentMayActFor(
  companyId: string,
  language: string,
  channel: AgentChannel,
): Promise<{ allowed: true } | { allowed: false; reason: AgentRefusal }> {
  const company = await prisma.company.findUnique({ where: { id: companyId }, select: { agentEnabledAt: true, safeModeSince: true } });
  if (!company?.agentEnabledAt) return { allowed: false, reason: "AGENT_OFF" };
  if (company.safeModeSince) return { allowed: false, reason: "SAFE_MODE" };
  const summary = await shadowSummary(companyId);
  const accepted = summary.acceptance.accepted.some((segment) => segment.language === language && segment.channel === channel);
  return accepted ? { allowed: true } : { allowed: false, reason: "NOT_ACCEPTED" };
}
