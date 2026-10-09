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
import { z } from "zod";
import { prisma } from "../db.js";
import { buildId } from "../lib/buildInfo.js";
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
/** The bridge's arguments, held to the same shape the tool declares to the model. */
const bridgeArgumentsSchema = z.object({ canonical_command: z.string().trim().min(1) }).strict();

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
  | "arguments_differ"
  | "mismatch"
  | "both_none"
  | "agent_only"
  | "parser_only"
  | "invalid_proposal"
  | "error";

/** What the parser did: the intent, a key to compare on, and — in memory only — its entities. */
export interface ParserOutcome {
  intent: string;
  /** "execute_action:NAME" for an executable action, the intent otherwise, null when nothing was to be done. */
  key: string | null;
  /** What the command was given. Compared in memory, never stored (D4). */
  entities?: unknown;
}

export interface ProposedTool {
  tool: string;
  kind: string;
  /** The comparable key of what this call would do; null when it would do nothing recognisable. */
  key: string | null;
  valid: boolean;
  argumentsFingerprint: string;
}

/** A proposal as compared: the stored record plus, in memory only, what it would be given. */
export interface Proposal extends ProposedTool {
  entities?: unknown;
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

/** An executable action's parameters as its schema reads them, so both sides compare alike. */
function actionEntities(action: string, parameters: unknown) {
  const validated = validateVoiceActionParameters(action, parameters);
  return { action, parameters: validated.success ? validated.data : parameters };
}

export function parserOutcomeOf(command: ParsedCommand): ParserOutcome {
  if (command.intent === "unrecognized") return { intent: command.intent, key: null };
  if (command.intent === "execute_action") {
    return {
      intent: command.intent,
      key: `execute_action:${command.entities.action}`,
      entities: actionEntities(command.entities.action, command.entities.parameters),
    };
  }
  return { intent: command.intent, key: command.intent, entities: command.entities };
}

/**
 * Values compared exactly as given — a message body that differs only in case
 * or spacing is a different message. Only key order and absent values are set
 * aside, because they change nothing that would be sent or written.
 */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
        .sort()
        .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

function sameEntities(left: unknown, right: unknown) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
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

function proposalFrom(name: string, rawArguments: string): Proposal {
  const fingerprint = argumentsFingerprint(rawArguments);
  let args: unknown;
  try {
    args = JSON.parse(rawArguments);
  } catch {
    args = undefined;
  }
  if (name === COMMAND_BRIDGE) {
    // The whole argument object, as declared: one canonical command, nothing beside it.
    const bridge = bridgeArgumentsSchema.safeParse(args);
    if (!bridge.success) return { tool: name, kind: "command", key: null, valid: false, argumentsFingerprint: fingerprint };
    // The parser is the authority on what a canonical command means.
    const parsed = parseTextCommand(bridge.data.canonical_command, CANONICAL_COMMAND);
    const outcome = parserOutcomeOf(parsed);
    return { tool: name, kind: "command", key: outcome.key, valid: outcome.key !== null, argumentsFingerprint: fingerprint, entities: outcome.entities };
  }
  const kind = catalogueKinds.get(name);
  if (!kind) return { tool: name, kind: "unknown", key: null, valid: false, argumentsFingerprint: fingerprint };
  const validated = validateVoiceActionParameters(name, args);
  return {
    tool: name,
    kind,
    key: `execute_action:${name}`,
    valid: validated.success,
    argumentsFingerprint: fingerprint,
    entities: actionEntities(name, args),
  };
}

/**
 * Strict on purpose: the rate this feeds decides whether the agent may act.
 * Any call the parser or the action's schema would refuse makes the whole
 * proposal invalid. A match means exactly the one thing the parser did, given
 * the same values — schemas alone cannot tell, because many actions are
 * validated only by their owning service, so the proposal's arguments are
 * compared, exactly, with what the parser actually received
 * ("arguments_differ" otherwise). The right action with further calls beside it is "extra_calls".
 * All of these count against the rate.
 */
export function compareWithParser(proposals: Proposal[], actual: ParserOutcome): ShadowAgreement {
  if (proposals.some((proposal) => !proposal.valid || proposal.key === null)) return "invalid_proposal";
  const proposedKeys = proposals.map((proposal) => proposal.key);
  if (actual.key === null) return proposedKeys.length === 0 ? "both_none" : "agent_only";
  if (proposedKeys.length === 0) return "parser_only";
  if (!proposedKeys.includes(actual.key)) return "mismatch";
  if (proposedKeys.length > 1) return "extra_calls";
  if (actual.entities !== undefined && !sameEntities(proposals[0].entities, actual.entities)) return "arguments_differ";
  return "match";
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

/** The model stopped before finishing — most often the output budget. Never compared as a plan. */
class IncompletePlan extends Error {
  constructor(readonly reason: string, readonly tokensIn?: number, readonly tokensOut?: number) {
    super(`INCOMPLETE_${reason}`);
  }
}

interface Plan {
  proposals: Proposal[];
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
    status?: string;
    incomplete_details?: { reason?: string } | null;
    output?: Array<{ type?: string; name?: string; arguments?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  recordUsage("agent_plan", body.usage);
  const tokensIn = typeof body.usage?.input_tokens === "number" ? body.usage.input_tokens : undefined;
  const tokensOut = typeof body.usage?.output_tokens === "number" ? body.usage.output_tokens : undefined;
  // A truncated answer is not a plan: an empty one would otherwise score as
  // "neither would act", and a partial one as if it were complete.
  if (body.status !== undefined && body.status !== "completed") {
    throw new IncompletePlan(body.incomplete_details?.reason ?? body.status, tokensIn, tokensOut);
  }
  const calls = (body.output ?? []).filter((item) => item.type === "function_call" && typeof item.name === "string");
  const proposals = calls
    .slice(0, AGENT_RUN_BUDGET.maxSteps)
    .map((call) => proposalFrom(call.name!, typeof call.arguments === "string" ? call.arguments : ""));
  return { proposals, tokensIn, tokensOut, overBudget: calls.length > AGENT_RUN_BUDGET.maxSteps };
}

function errorCode(error: unknown): string {
  if (error instanceof IncompletePlan) return error.reason === "max_output_tokens" ? "OUTPUT_BUDGET" : error.message;
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
  let tokensIn: number | undefined;
  let tokensOut: number | undefined;
  try {
    planned = await plan(input);
    ({ tokensIn, tokensOut } = planned);
  } catch (error) {
    failure = errorCode(error);
    if (error instanceof IncompletePlan) ({ tokensIn, tokensOut } = error);
  }
  const budgetExceeded = failure === "OUTPUT_BUDGET" || (!failure && planned!.overBudget);
  // Only the record of each call is kept; what it would have been given stays in memory (D4).
  const stored: ProposedTool[] = (planned?.proposals ?? []).map(({ tool, kind, key, valid, argumentsFingerprint }) => ({
    tool,
    kind,
    key,
    valid,
    argumentsFingerprint,
  }));
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
        build: buildId(),
        model: modelFor("agent_plan"),
        status: budgetExceeded ? "budget_exceeded" : failure ? "error" : "completed",
        errorCode: failure ?? (planned!.overBudget ? "STEP_BUDGET" : null),
        steps: stored.length,
        proposedTools: stored as unknown as Prisma.InputJsonValue,
        parserIntent: input.actual.intent,
        parserAction: input.actual.key,
        agreement: failure ? "error" : compareWithParser(planned!.proposals, input.actual),
        tokensIn: tokensIn ?? null,
        tokensOut: tokensOut ?? null,
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
 *
 * Only the current cohort counts: runs of the model, the exact tool set and
 * the deployed build in use now. The build covers everything a fingerprint of
 * selected functions cannot — the prompt, how proposals are read and judged,
 * and everything those call (the parser, the action schemas). Proposal values
 * are deliberately not stored, so old runs cannot be judged again; a new
 * build therefore starts from zero, and acceptance needs its 100 compared
 * requests on one build. Earlier observations never vouch for unmeasured code.
 */
export async function shadowSummary(companyId: string, since?: Date) {
  const cohort = { model: modelFor("agent_plan"), toolsetFingerprint: AGENT_TOOLSET_FINGERPRINT, build: buildId() };
  const scope = { companyId, mode: "shadow", ...(since ? { createdAt: { gte: since } } : {}) };
  const [groups, allRuns] = await Promise.all([
    prisma.agentRun.groupBy({
      by: ["agreement"],
      where: { ...scope, ...cohort },
      _count: { _all: true },
      _sum: { tokensIn: true, tokensOut: true },
    }),
    prisma.agentRun.count({ where: scope }),
  ]);
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
    cohort,
    total,
    compared,
    errors,
    byAgreement,
    agreementRate: compared > 0 ? agreeing / compared : null,
    tokensIn,
    tokensOut,
    /** Runs of earlier models or tool sets: shown, never counted. */
    otherCohortRuns: allRuns - total,
    acceptance: { requiredRate: 0.95, requiredSample: 100, met: compared >= 100 && agreeing / compared >= 0.95 },
  };
}
