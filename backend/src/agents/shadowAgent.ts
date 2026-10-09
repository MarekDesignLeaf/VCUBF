/**
 * The agent in shadow (masterplan F1, layers B, C, G).
 *
 * After the deterministic parser has handled a request, the agent is shown the
 * same request and asked which tools it would use. It proposes; nothing it
 * proposes is executed — not a write, not a read, not a send. The run records
 * how the proposal compares with what the parser actually did, so the agent
 * earns its switch-on (F2) with a measured agreement rate (≥ 95 % on ≥ 100
 * real requests) instead of a demo.
 *
 * What the agent may propose is exactly what Secretary can already do:
 *  - every executable action of the versioned tool catalogue (F0.2), as its
 *    own function tool with the catalogue's JSON Schema;
 *  - a bridge to the parser, run_command, which takes one canonical command
 *    from the same list the voice interpretation uses. Its proposal is parsed
 *    by the deterministic parser, so the agent cannot invent a command and the
 *    comparison is intent against intent.
 *
 * Off unless switched on: AGENT_SHADOW_SAMPLE_RATE (0–1, default 0) is the
 * share of eligible requests that get a shadow run. Every shadow run is a paid
 * model call of roughly ten thousand input tokens, so turning it on is the
 * owner's decision. Decision D4: no message text is stored anywhere — the
 * request is a keyed fingerprint, proposed arguments are fingerprints.
 */

import { createHash, createHmac } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { CANONICAL_COMMAND_FORMS } from "../lib/canonicalCommands.js";
import { CANONICAL_COMMAND, parseTextCommand, type ParsedCommand } from "../lib/commandParser.js";
import { modelFor, modelRequest, recordUsage } from "../lib/modelGateway.js";
import { validateVoiceActionParameters } from "../lib/voiceActionCatalogue.js";
import { AGENT_TOOL_CATALOGUE, TOOL_CATALOGUE_FINGERPRINT, TOOL_CATALOGUE_VERSION } from "./toolCatalogue.js";

/**
 * Run budgets (decision D5). The 15-second limit is the agent_plan task's
 * timeout in the model gateway. The $0.10 cost cap cannot be enforced before a
 * per-token price is configured — it is not guessed here — so the output is
 * capped instead and the tokens of every run are recorded for the cost ledger.
 */
export const AGENT_RUN_BUDGET = { maxSteps: 6, maxOutputTokens: 600 } as const;

/** Shadow runs in flight per process; beyond this a request simply gets none. */
const MAX_IN_FLIGHT = 2;

const COMMAND_BRIDGE = "run_command";

type FunctionTool = { type: "function"; name: string; description: string; parameters: Record<string, unknown> };

const TOOLS: readonly FunctionTool[] = [
  {
    type: "function",
    name: COMMAND_BRIDGE,
    description:
      "Run one Secretary command, written in exactly one of the canonical forms below. Fill the placeholders only with " +
      "values the user gave; keep names and message text exactly as said.\n" + CANONICAL_COMMAND_FORMS,
    parameters: {
      type: "object",
      properties: { canonical_command: { type: "string", description: "One canonical command from the list." } },
      required: ["canonical_command"],
      additionalProperties: false,
    },
  },
  ...AGENT_TOOL_CATALOGUE.map((tool): FunctionTool => ({
    type: "function",
    name: tool.name,
    description: `${tool.description} [${tool.kind}${tool.confirmation === "service_preview" ? ", reviewed before a yes" : ""}]`,
    parameters: tool.parameters,
  })),
];

/** The exact tool list the model is shown, fingerprinted for every run. */
export const AGENT_TOOLSET_FINGERPRINT = createHash("sha256").update(JSON.stringify(TOOLS)).digest("hex");

const catalogueKinds = new Map(AGENT_TOOL_CATALOGUE.map((tool) => [tool.name as string, tool.kind as string]));

export type ShadowAgreement =
  | "match"
  | "extra_calls"
  | "mismatch"
  | "both_none"
  | "agent_only"
  | "parser_only"
  | "invalid_proposal"
  | "error";

/** What the parser did, reduced to names: the intent, and a key to compare on. */
export interface ParserOutcome {
  intent: string;
  /** "execute_action:NAME" for an executable action, the intent otherwise, null when nothing was to be done. */
  key: string | null;
}

export interface ProposedTool {
  tool: string;
  kind: string;
  /** The comparable key of what this call would do; null when it would do nothing recognisable. */
  key: string | null;
  valid: boolean;
  argumentsFingerprint: string;
}

export interface ShadowInput {
  user: { id: string; companyId: string };
  channel: "assistant" | "text";
  language: string;
  /** The request as the parser saw it. Sent to the model, never stored. */
  text: string;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  actual: ParserOutcome;
}

export function parserOutcomeOf(command: ParsedCommand): ParserOutcome {
  if (command.intent === "unrecognized") return { intent: command.intent, key: null };
  if (command.intent === "execute_action") return { intent: command.intent, key: `execute_action:${command.entities.action}` };
  return { intent: command.intent, key: command.intent };
}

/** Confirmation turns ("yes", "cancel email") mean nothing without the review they answer. */
function isApprovalTurn(intent: string) {
  return intent.startsWith("confirm_") || intent.startsWith("cancel_");
}

function fingerprintKey() {
  return `agent-run:${process.env.JWT_SECRET ?? "dev-secret-change-me"}`;
}

/** Keyed, so a short request cannot be recovered by hashing guesses. */
export function requestFingerprint(text: string): string {
  return createHmac("sha256", fingerprintKey()).update(text.trim().replace(/\s+/g, " ").toLowerCase()).digest("hex");
}

function argumentsFingerprint(raw: string): string {
  return createHmac("sha256", fingerprintKey()).update(raw).digest("hex");
}

function proposalFrom(name: string, rawArguments: string): ProposedTool {
  const fingerprint = argumentsFingerprint(rawArguments);
  let args: unknown;
  try {
    args = JSON.parse(rawArguments);
  } catch {
    args = undefined;
  }
  if (name === COMMAND_BRIDGE) {
    const canonical = args && typeof args === "object" ? (args as { canonical_command?: unknown }).canonical_command : undefined;
    if (typeof canonical !== "string" || !canonical.trim()) return { tool: name, kind: "command", key: null, valid: false, argumentsFingerprint: fingerprint };
    // The parser is the authority on what a canonical command means.
    const parsed = parseTextCommand(canonical, CANONICAL_COMMAND);
    const outcome = parserOutcomeOf(parsed);
    return { tool: name, kind: "command", key: outcome.key, valid: outcome.key !== null, argumentsFingerprint: fingerprint };
  }
  const kind = catalogueKinds.get(name);
  if (!kind) return { tool: name, kind: "unknown", key: null, valid: false, argumentsFingerprint: fingerprint };
  const validated = validateVoiceActionParameters(name, args);
  return { tool: name, kind, key: `execute_action:${name}`, valid: validated.success, argumentsFingerprint: fingerprint };
}

/**
 * Strict on purpose: the rate this feeds decides whether the agent may act.
 * Any call the parser or the action's schema would refuse makes the whole
 * proposal invalid, and a match means exactly the one thing the parser did —
 * the right action with further calls beside it is "extra_calls", which counts
 * against the rate like a mismatch.
 */
export function compareWithParser(proposals: ProposedTool[], actual: ParserOutcome): ShadowAgreement {
  if (proposals.some((proposal) => !proposal.valid || proposal.key === null)) return "invalid_proposal";
  const proposedKeys = proposals.map((proposal) => proposal.key);
  if (actual.key === null) return proposedKeys.length === 0 ? "both_none" : "agent_only";
  if (proposedKeys.length === 0) return "parser_only";
  if (!proposedKeys.includes(actual.key)) return "mismatch";
  return proposedKeys.length === 1 ? "match" : "extra_calls";
}

function instructions(language: string) {
  return `You are the planning layer of Secretary, a business operating system. Decide which tools would carry out the user's request.
You only propose: nothing you call is executed, and you will not see results.
For a request that matches a Secretary command, call ${COMMAND_BRIDGE} with that canonical command. For an action offered as its own tool, call that tool with only the facts the user gave.
A request that needs several steps gets several calls, in order. Use at most ${AGENT_RUN_BUDGET.maxSteps} calls.
Conversation, greetings, questions about yourself, or requests that no tool fits: call no tool.
Never invent names, identifiers, addresses, dates, amounts or message text. Keep names and message text exactly as the user said them.
The user speaks ${language}.`;
}

interface Plan {
  proposals: ProposedTool[];
  tokensIn?: number;
  tokensOut?: number;
  overBudget: boolean;
}

async function plan(input: ShadowInput): Promise<Plan> {
  const model = modelFor("agent_plan");
  const response = await modelRequest("agent_plan", "/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      store: false,
      ...(model.startsWith("gpt-5") ? { reasoning: { effort: model.startsWith("gpt-5.4") ? "none" : "minimal" } } : {}),
      max_output_tokens: AGENT_RUN_BUDGET.maxOutputTokens,
      instructions: instructions(input.language),
      input: [...(input.history ?? []), { role: "user", content: input.text }],
      tools: TOOLS,
      tool_choice: "auto",
      parallel_tool_calls: true,
    }),
  });
  if (!response.ok) throw new Error(`HTTP_${response.status}`);
  const body = (await response.json()) as {
    output?: Array<{ type?: string; name?: string; arguments?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  recordUsage("agent_plan", body.usage);
  const calls = (body.output ?? []).filter((item) => item.type === "function_call" && typeof item.name === "string");
  const proposals = calls
    .slice(0, AGENT_RUN_BUDGET.maxSteps)
    .map((call) => proposalFrom(call.name!, typeof call.arguments === "string" ? call.arguments : ""));
  return {
    proposals,
    tokensIn: typeof body.usage?.input_tokens === "number" ? body.usage.input_tokens : undefined,
    tokensOut: typeof body.usage?.output_tokens === "number" ? body.usage.output_tokens : undefined,
    overBudget: calls.length > AGENT_RUN_BUDGET.maxSteps,
  };
}

function errorCode(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") return "TIMEOUT";
    if (error.message === "OPENAI_NOT_CONFIGURED" || error.message.startsWith("HTTP_")) return error.message;
    return error.name || "ERROR";
  }
  return "ERROR";
}

/** One shadow run, recorded. Never throws: the shadow must not touch the request it watches. */
export async function runShadow(input: ShadowInput): Promise<void> {
  const startedAt = Date.now();
  let planned: Plan | undefined;
  let failure: string | undefined;
  try {
    planned = await plan(input);
  } catch (error) {
    failure = errorCode(error);
  }
  try {
    await prisma.agentRun.create({
      data: {
        companyId: input.user.companyId,
        userId: input.user.id,
        mode: "shadow",
        channel: input.channel,
        language: input.language,
        inputFingerprint: requestFingerprint(input.text),
        catalogueVersion: TOOL_CATALOGUE_VERSION,
        catalogueFingerprint: TOOL_CATALOGUE_FINGERPRINT,
        toolsetFingerprint: AGENT_TOOLSET_FINGERPRINT,
        model: modelFor("agent_plan"),
        status: failure ? "error" : planned!.overBudget ? "budget_exceeded" : "completed",
        errorCode: failure ?? (planned!.overBudget ? "STEP_BUDGET" : null),
        steps: planned ? planned.proposals.length : 0,
        proposedTools: (planned?.proposals ?? []) as unknown as Prisma.InputJsonValue,
        parserIntent: input.actual.intent,
        parserAction: input.actual.key,
        agreement: failure ? "error" : compareWithParser(planned!.proposals, input.actual),
        tokensIn: planned?.tokensIn ?? null,
        tokensOut: planned?.tokensOut ?? null,
        durationMs: Date.now() - startedAt,
      },
    });
  } catch (error) {
    console.error("[agent-shadow] could not record the run", error instanceof Error ? error.message : error);
  }
}

const inFlight = new Set<Promise<void>>();

function sampleRate(): number {
  const rate = Number(process.env.AGENT_SHADOW_SAMPLE_RATE ?? "0");
  return Number.isFinite(rate) ? Math.max(0, Math.min(1, rate)) : 0;
}

/**
 * Give a handled request a shadow run, in the background. Returns at once;
 * the returned promise exists for tests. Nothing happens when the shadow is
 * off, the request is a confirmation turn, no model key is configured, or two
 * runs are already in flight.
 */
export function observeShadow(input: ShadowInput): Promise<void> | undefined {
  const rate = sampleRate();
  if (rate <= 0 || Math.random() >= rate) return undefined;
  if (isApprovalTurn(input.actual.intent)) return undefined;
  if (!process.env.OPENAI_API_KEY?.trim()) return undefined;
  if (inFlight.size >= MAX_IN_FLIGHT) return undefined;
  const run: Promise<void> = runShadow(input).finally(() => inFlight.delete(run));
  inFlight.add(run);
  return run;
}

/** Wait for every shadow run in flight (tests, graceful shutdown). */
export async function settleShadowRuns(): Promise<void> {
  await Promise.allSettled([...inFlight]);
}

const AGREEING: ShadowAgreement[] = ["match", "both_none"];

/**
 * The acceptance view of the shadow (F1): how often the agent's proposal
 * agrees with what the parser did. Errors are counted but excluded from the
 * rate; everything else — including an invalid proposal — counts against it.
 */
export async function shadowSummary(companyId: string, since?: Date) {
  const groups = await prisma.agentRun.groupBy({
    by: ["agreement"],
    where: { companyId, mode: "shadow", ...(since ? { createdAt: { gte: since } } : {}) },
    _count: { _all: true },
    _sum: { tokensIn: true, tokensOut: true },
  });
  const byAgreement: Record<string, number> = {};
  let total = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  for (const group of groups) {
    byAgreement[group.agreement] = group._count._all;
    total += group._count._all;
    tokensIn += group._sum.tokensIn ?? 0;
    tokensOut += group._sum.tokensOut ?? 0;
  }
  const errors = byAgreement.error ?? 0;
  const compared = total - errors;
  const agreeing = AGREEING.reduce((sum, agreement) => sum + (byAgreement[agreement] ?? 0), 0);
  return {
    total,
    compared,
    errors,
    byAgreement,
    agreementRate: compared > 0 ? agreeing / compared : null,
    tokensIn,
    tokensOut,
    acceptance: { requiredRate: 0.95, requiredSample: 100, met: compared >= 100 && agreeing / compared >= 0.95 },
  };
}
