/**
 * The owner's PC through the PC Control Plus relay (MarekDesignLeaf/pc-control-plus).
 *
 * The relay owns the PC: its Windows agent asks the PC owner locally before
 * every sensitive step, keeps its read-only profile, opens only public HTTPS
 * addresses, and runs the shared pc_engine. Secretary does not duplicate any
 * of that. It calls the relay's server API (POST /v1/call) with a server-side
 * token, only with tool names from the engine catalogue (engine_<name>), the
 * relay tools Secretary's policy offers (pcRelayPolicy.ts) and the read-only
 * browser_connection_status, never a shell, command or raw passthrough; the
 * relay additionally runs only tools in its own allowlist.
 *
 * Configuration (environment, never in code or the database):
 *   PCP_RELAY_URL, PCP_CLIENT_TOKEN (secret), PCP_COMPANY_ID.
 */
import type { AuthedUser } from "../middleware/auth.js";
import { PC_ENGINE_CATALOGUE } from "../modules/mcp/pcEngineCatalogue.generated.js";
import { PCP_RELAY_CATALOGUE } from "../modules/mcp/pcpRelayCatalogue.generated.js";
import { PC_RELAY_POLICY } from "../modules/mcp/pcRelayPolicy.js";
import { fail, ok, type ServiceResult } from "./result.js";
import { networkErrorCode } from "./smsBridgeService.js";

/** The relay waits 75 s for the agent; Secretary waits a little longer. */
export const PCP_TIMEOUT_MS = 80_000;
export const PC_STATUS_TOOL = "browser_connection_status";
const ENGINE_NAMES = new Set<string>(PC_ENGINE_CATALOGUE.tools.map((tool) => tool.name));
/** Relay jobs Secretary may send: in the relay's catalogue and offered by Secretary's policy. */
const OFFERED_RELAY_JOBS = new Set<string>(PCP_RELAY_CATALOGUE.tools.map((tool) => tool.relay_tool)
  .filter((job) => PC_RELAY_POLICY[job] && PC_RELAY_POLICY[job].kind !== "not_offered"));

export interface PcControlPlusConfig {
  url: string;
  token: string;
  companyId: string;
}

export function pcControlPlusConfig(env: NodeJS.ProcessEnv = process.env): PcControlPlusConfig | null {
  const url = env.PCP_RELAY_URL?.trim().replace(/\/+$/, "");
  const token = env.PCP_CLIENT_TOKEN?.trim();
  const companyId = env.PCP_COMPANY_ID?.trim();
  if (!url || !token || !companyId) return null;
  if (!/^https:\/\//.test(url) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(url)) return null;
  return { url, token, companyId };
}

export function pcControlPlusAvailableFor(companyId: string | undefined): boolean {
  const config = pcControlPlusConfig();
  return Boolean(config && companyId && config.companyId === companyId);
}

/** The relay may have handed the step to the PC: the outcome is not known. */
export class PcOutcomeUnknownError extends Error {}

/**
 * Call one PC tool. `engineTool` is a pc_engine catalogue name (sent as
 * engine_<name>) or PC_STATUS_TOOL. Anything else is refused here, before
 * any request.
 */
export async function callPc(user: AuthedUser, engineTool: string, args: Record<string, unknown>,
  options: { mayHaveEffect: boolean }): Promise<ServiceResult<unknown>> {
  const config = pcControlPlusConfig();
  if (!config || config.companyId !== user.companyId) {
    return fail(409, "CONNECTOR_NOT_CONFIGURED", "The owner's PC (PC Control Plus) is not set up for this company.");
  }
  const relayTool = engineTool === PC_STATUS_TOOL ? PC_STATUS_TOOL : ENGINE_NAMES.has(engineTool) ? `engine_${engineTool}` : null;
  if (!relayTool) return fail(400, "VALIDATION_FAILED", `${engineTool} is not a PC Control Plus engine tool.`);
  return send(config, relayTool, args, options);
}

/**
 * Call one of the relay's own tools by its relay job name (pcpRelayCatalogue),
 * only when Secretary's policy offers it. Anything else is refused here,
 * before any request.
 */
export async function callPcRelay(user: AuthedUser, relayJob: string, args: Record<string, unknown>,
  options: { mayHaveEffect: boolean }): Promise<ServiceResult<unknown>> {
  const config = pcControlPlusConfig();
  if (!config || config.companyId !== user.companyId) {
    return fail(409, "CONNECTOR_NOT_CONFIGURED", "The owner's PC (PC Control Plus) is not set up for this company.");
  }
  if (!OFFERED_RELAY_JOBS.has(relayJob)) return fail(400, "VALIDATION_FAILED", `${relayJob} is not offered through Secretary.`);
  return send(config, relayJob, args, options);
}

async function send(config: PcControlPlusConfig, relayTool: string, args: Record<string, unknown>,
  options: { mayHaveEffect: boolean }): Promise<ServiceResult<unknown>> {

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PCP_TIMEOUT_MS);
  let status: number;
  let body: any;
  try {
    const response = await fetch(`${config.url}/v1/call`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ tool: relayTool, args }),
      signal: controller.signal,
      redirect: "error",
    });
    status = response.status;
    const text = await response.text();
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { detail: text.slice(0, 200) };
    }
  } catch (error) {
    const code = networkErrorCode(error);
    const refused = code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EAI_AGAIN";
    if (options.mayHaveEffect && !refused) {
      throw new PcOutcomeUnknownError("The PC Control Plus relay did not answer; the step may or may not have run on the PC.");
    }
    return fail(502, "PROVIDER_UNAVAILABLE", refused ? "The PC Control Plus relay cannot be reached." : "The PC Control Plus relay did not answer.");
  } finally {
    clearTimeout(timer);
  }

  const detail = typeof body?.detail === "string" ? body.detail : `HTTP ${status}`;
  if (status === 503) return fail(503, "PC_AGENT_OFFLINE", "The PC is offline: the PC Control Plus agent is not connected to its relay.");
  if (status === 409) return fail(409, "PC_AGENT_BUSY", "The PC is busy with a previous step; try again when it has finished.");
  if (status === 401) return fail(502, "CONNECTOR_AUTHORIZATION_REQUIRED", "The PC Control Plus relay refused Secretary's token.");
  if (status === 403) return fail(403, "NOT_ALLOWED", `The PC Control Plus relay does not allow ${relayTool} (${detail}).`);
  if (status === 429) return fail(429, "RATE_LIMITED", "The PC Control Plus relay queue is full.");
  if (status === 504) {
    if (options.mayHaveEffect) throw new PcOutcomeUnknownError("The PC did not answer within 75 seconds; the step may or may not have run.");
    return fail(504, "PROVIDER_UNAVAILABLE", "The PC did not answer within 75 seconds.");
  }
  if (status < 200 || status >= 300) return fail(502, "PROVIDER_UNAVAILABLE", `The PC Control Plus relay answered ${detail}.`);
  // The agent's own answer: { ok, data } or { ok: false, error } (a refusal on the PC, e.g. the owner said no).
  if (body && body.ok === false) {
    const error = String(body.error ?? "The PC refused the step.");
    const code = /denied|approv|owner/i.test(error) ? "PC_OWNER_DENIED" : /read only/i.test(error) ? "NOT_ALLOWED" : "PC_STEP_FAILED";
    return fail(409, code, error.slice(0, 500));
  }
  return ok(200, body && "data" in body ? body.data : body);
}
