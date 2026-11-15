/**
 * The owner's phone (SMS Bridge), PC (PC Control Plus) and WhatsApp Business
 * delivery status for Secretary's own assistant and its agent (the executable
 * actions of emmaExecutableActionCatalogue, which the agent tool catalogue is
 * generated from). The MCP gateway serves the same systems through
 * modules/mcp/deviceTools.ts; both use the same adapters, company binding,
 * PC tool definitions and text-state rule.
 *
 * The executable-action flow does the rest, exactly as for every other action:
 * the caller's permission and the administrator's switch (evaluateEmmaCommand),
 * the preview and the person's yes (a reviewed action, or the agent proposal as
 * a whole), each step validated again before it runs. Here:
 *
 * - reads run at once (the emergency stop does not stop reading);
 * - a send or a PC step first answers CONFIRMATION_REQUIRED with the exact
 *   preview and the operation that will run (confirmInput), and runs only
 *   with confirmed: true, after checking the emergency stop again;
 * - an SMS or chat reply carries a bridge request id fixed in the preview, so
 *   one approval can never send twice; an outcome Secretary cannot know is
 *   answered OUTCOME_UNKNOWN, audited, and never retried by itself. It is
 *   reconciled by preparing the same message with reuse_request_id: SMS Bridge
 *   de-duplicates on it, so nothing is sent twice;
 * - every send and PC step is audited under its own Action Contract, without
 *   message text.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { prisma } from "../db.js";
import { recordAudit } from "../lib/audit.js";
import {
  OPERATE_PC_ACTION,
  REPLY_PHONE_CHAT_ACTION,
  SEND_PHONE_SMS_ACTION,
  type ActionContract,
} from "../lib/actionContracts.js";
import { SafeModeActiveError, SAFE_MODE_ACTIVE, assertNotInSafeMode } from "../lib/safeMode.js";
import type { AuthedUser } from "../middleware/auth.js";
import { PC_READ_TOOLS, pcReviewedToolsByName } from "../modules/mcp/deviceTools.js";
import { PcOutcomeUnknownError } from "./pcControlPlusService.js";
import { fail, ok, type ServiceResult } from "./result.js";
import * as phone from "./smsBridgeService.js";
import * as whatsapp from "./whatsappBusinessConnectorService.js";

type Params = Record<string, unknown>;

function parse<T extends z.ZodTypeAny>(schema: T, params: unknown): ServiceResult<z.infer<T>> {
  const parsed = schema.safeParse(params ?? {});
  return parsed.success
    ? ok(200, parsed.data)
    : fail(400, "VALIDATION_FAILED", parsed.error.issues.map((issue) => `${issue.path.join(".") || "parameters"}: ${issue.message}`).join("; "));
}

const confirmationRequired = (message: string, preview: unknown, confirmInput: Params) =>
  fail(409, "CONFIRMATION_REQUIRED", message, { preview, confirmInput });

async function notStopped(user: AuthedUser): Promise<ServiceResult<true>> {
  try {
    await assertNotInSafeMode(user.companyId);
    return ok(200, true);
  } catch (error) {
    if (error instanceof SafeModeActiveError) return fail(423, SAFE_MODE_ACTIVE, "Emergency stop is on: nothing is sent or changed.");
    throw error;
  }
}

async function audit(user: AuthedUser, contract: ActionContract, inputPayload: Params, result: "success" | "error" | "rejected", extra: { dataAfter?: Params; errorMessage?: string } = {}) {
  await recordAudit({
    companyId: user.companyId, userId: user.id, actionName: contract.actionName, inputPayload,
    riskLevel: contract.riskLevel, confirmationRequired: true, confirmed: true, result, ...extra,
  });
}

// ─── Phone: reads ───────────────────────────────────────────────────────────

const smsFilters = z.object({
  address: z.string().trim().max(100).optional(),
  text: z.string().trim().max(200).optional(),
  direction: z.enum(["in", "out"]).optional(),
  since: z.string().datetime({ offset: true }).optional(),
  limit: z.number().int().min(1).max(100).optional(),
}).strict();
const chatFilters = z.object({
  channel: z.enum(phone.PHONE_CHAT_CHANNELS).optional(),
  since: z.string().datetime({ offset: true }).optional(),
  limit: z.number().int().min(1).max(200).optional(),
}).strict();

export async function phoneStatus(user: AuthedUser, params: Params) {
  const parsed = parse(z.object({}).strict(), params);
  return parsed.ok ? phone.phoneStatus(user) : parsed;
}

export async function listPhoneSms(user: AuthedUser, params: Params) {
  const parsed = parse(smsFilters, params);
  return parsed.ok ? phone.readPhoneSms(user, parsed.data) : parsed;
}

export async function listPhoneChats(user: AuthedUser, params: Params) {
  const parsed = parse(chatFilters, params);
  return parsed.ok ? phone.readPhoneChats(user, parsed.data) : parsed;
}

// ─── Phone: sends ───────────────────────────────────────────────────────────

/** A request id of this company in the form bridgeRequestId makes. */
function companyRequestId(user: AuthedUser, value: unknown): value is string {
  return typeof value === "string" && value.startsWith(`vcubf-${user.companyId.slice(0, 8)}-`) && /^vcubf-[0-9a-f-]{8}-[0-9a-f-]{36}$/i.test(value);
}

/**
 * A request id Secretary itself recorded as an unknown outcome of this person's
 * own send, in this company, under this contract. Nobody settles another
 * person's send (the MCP gateway's status and resubmit are per person too).
 */
async function unknownRequest(user: AuthedUser, contract: ActionContract, requestId: string): Promise<boolean> {
  const unknown = await prisma.auditLog.findFirst({
    where: { companyId: user.companyId, userId: user.id, actionName: contract.actionName, errorMessage: "OUTCOME_UNKNOWN", inputPayload: { path: ["request_id"], equals: requestId } },
    select: { id: true },
  });
  return Boolean(unknown);
}

const smsSend = z.object({
  to: z.string().trim(),
  text: z.string(),
  request_id: z.string().optional(),
  reuse_request_id: z.string().optional(),
}).strict();
const chatReply = z.object({
  channel: z.enum(phone.PHONE_CHAT_CHANNELS),
  chat: z.string().trim().min(1).max(200),
  text: z.string().min(1).max(phone.CHAT_REPLY_MAX_CHARS),
  request_id: z.string().optional(),
  reuse_request_id: z.string().optional(),
}).strict();

async function previewRequestId(user: AuthedUser, contract: ActionContract, reuse: string | undefined): Promise<ServiceResult<{ requestId: string; reused: boolean }>> {
  if (reuse === undefined) return ok(200, { requestId: phone.bridgeRequestId(user.companyId, randomUUID()), reused: false });
  if (!companyRequestId(user, reuse) || !await unknownRequest(user, contract, reuse)) {
    return fail(409, "NOT_RESUBMITTABLE", "reuse_request_id must be the request id of one of your own sends whose outcome is unknown.");
  }
  return ok(200, { requestId: reuse, reused: true });
}

/** Runs a bridge send under the request id fixed in the preview, and audits it. */
async function bridgeSend(user: AuthedUser, contract: ActionContract, requestId: string, input: Params, send: () => Promise<ServiceResult<phone.BridgeSendOutcome>>) {
  const stopped = await notStopped(user);
  if (!stopped.ok) {
    await audit(user, contract, { ...input, request_id: requestId }, "rejected", { errorMessage: SAFE_MODE_ACTIVE });
    return stopped;
  }
  let result: ServiceResult<phone.BridgeSendOutcome>;
  try {
    result = await send();
  } catch (error) {
    if (!(error instanceof phone.SmsBridgeNetworkError)) throw error;
    if (!error.delivered) {
      await audit(user, contract, { ...input, request_id: requestId }, "error", { errorMessage: "PROVIDER_UNAVAILABLE" });
      return fail(502, "PROVIDER_UNAVAILABLE", `${error.message}. Nothing was sent.`);
    }
    await audit(user, contract, { ...input, request_id: requestId }, "error", { errorMessage: "OUTCOME_UNKNOWN" });
    return fail(502, "OUTCOME_UNKNOWN", "SMS Bridge did not answer: the message may or may not have been taken. It is not sent again by itself; ask for its status with phone_message_status, or prepare the same message with reuse_request_id, which can never send it twice.", { request_id: requestId });
  }
  if (!result.ok) {
    await audit(user, contract, { ...input, request_id: requestId }, "error", { errorMessage: result.error });
    return result;
  }
  await audit(user, contract, { ...input, request_id: requestId }, "success", { dataAfter: { remote_id: result.data.remote_id, status: result.data.status, created: result.data.created } });
  return result;
}

export async function sendPhoneSms(user: AuthedUser, params: Params, confirmed: boolean): Promise<ServiceResult<unknown>> {
  const parsed = parse(smsSend, params);
  if (!parsed.ok) return parsed;
  const valid = phone.validateSms(parsed.data.to, parsed.data.text);
  if (!valid.ok) return valid;
  const input = { recipientLength: valid.data.to.length, textLength: valid.data.text.length };
  if (!confirmed) {
    const preview = await phone.previewPhoneSms(user, valid.data);
    if (!preview.ok) return preview;
    const id = await previewRequestId(user, SEND_PHONE_SMS_ACTION, parsed.data.reuse_request_id);
    if (!id.ok) return id;
    return confirmationRequired(
      "Review the exact number and text; the SMS is sent from the owner's phone only after a yes.",
      { ...(preview.data as Params), request_id: id.data.requestId, ...(id.data.reused ? { reconciles: "If SMS Bridge already has this request id, nothing new is sent." } : {}) },
      { to: valid.data.to, text: valid.data.text, request_id: id.data.requestId },
    );
  }
  if (!companyRequestId(user, parsed.data.request_id)) return fail(400, "VALIDATION_FAILED", "Confirm the reviewed SMS; it carries its request id.");
  const requestId = parsed.data.request_id;
  return bridgeSend(user, SEND_PHONE_SMS_ACTION, requestId, input, () => phone.sendPhoneSms(user, valid.data, requestId));
}

export async function replyPhoneChat(user: AuthedUser, params: Params, confirmed: boolean): Promise<ServiceResult<unknown>> {
  const parsed = parse(chatReply, params);
  if (!parsed.ok) return parsed;
  const { channel, chat, text } = parsed.data;
  const input = { channel, textLength: text.length };
  // The chat must still have a notification on the phone, at the preview and at the yes.
  const preview = await phone.previewPhoneChatReply(user, { channel, chat, text });
  if (!preview.ok) return preview;
  if (!confirmed) {
    const id = await previewRequestId(user, REPLY_PHONE_CHAT_ACTION, parsed.data.reuse_request_id);
    if (!id.ok) return id;
    return confirmationRequired(
      "Review the chat and the exact reply; the phone answers through the notification only after a yes.",
      { ...(preview.data as Params), request_id: id.data.requestId },
      { channel, chat, text, request_id: id.data.requestId },
    );
  }
  if (!companyRequestId(user, parsed.data.request_id)) return fail(400, "VALIDATION_FAILED", "Confirm the reviewed reply; it carries its request id.");
  const requestId = parsed.data.request_id;
  return bridgeSend(user, REPLY_PHONE_CHAT_ACTION, requestId, input, () => phone.replyPhoneChat(user, { channel, chat, text }, requestId));
}

/** What became of the caller's own phone send, by the request id its preview showed, from the audit and SMS Bridge. */
export async function phoneMessageStatus(user: AuthedUser, params: Params): Promise<ServiceResult<unknown>> {
  const parsed = parse(z.object({ request_id: z.string() }).strict(), params);
  if (!parsed.ok) return parsed;
  const requestId = parsed.data.request_id;
  if (!companyRequestId(user, requestId)) return fail(400, "VALIDATION_FAILED", "request_id must be a request id of this company's phone send.");
  const entries = await prisma.auditLog.findMany({
    where: { companyId: user.companyId, userId: user.id, actionName: { in: [SEND_PHONE_SMS_ACTION.actionName, REPLY_PHONE_CHAT_ACTION.actionName] }, inputPayload: { path: ["request_id"], equals: requestId } },
    orderBy: { createdAt: "desc" },
    select: { actionName: true, result: true, errorMessage: true, dataAfter: true },
  });
  const accepted = entries.find((entry) => entry.result === "success");
  if (accepted) {
    const remoteId = String((accepted.dataAfter as { remote_id?: unknown } | null)?.remote_id ?? "");
    const live = accepted.actionName === SEND_PHONE_SMS_ACTION.actionName ? await phone.phoneSmsStatus(user, remoteId) : await phone.phoneChatReplyStatus(user, remoteId);
    return live.ok ? ok(200, { request_id: requestId, ...(live.data as Params) }) : live;
  }
  const latest = entries[0];
  if (!latest) return ok(200, { request_id: requestId, status: "not_sent", meaning: "You confirmed no send with this request id." });
  if (latest.errorMessage === "OUTCOME_UNKNOWN") {
    return ok(200, { request_id: requestId, status: "unknown", meaning: "Secretary could not learn whether SMS Bridge took this message. It is never sent again by itself; prepare the same message with reuse_request_id to settle it without a second send." });
  }
  return ok(200, { request_id: requestId, status: "refused", error: latest.errorMessage, meaning: "The send was refused; nothing was sent." });
}

// ─── WhatsApp Business delivery status ──────────────────────────────────────

export async function whatsAppMessageStatus(user: AuthedUser, params: Params): Promise<ServiceResult<unknown>> {
  const parsed = parse(z.object({ message_id: z.string().trim().min(1).max(250).optional() }).strict(), params);
  if (!parsed.ok) return parsed;
  const messageId = parsed.data.message_id ?? await whatsapp.latestWhatsAppBusinessSend(user);
  if (!messageId) return fail(404, "WHATSAPP_MESSAGE_NOT_FOUND", "You have not sent a WhatsApp Business message from Secretary yet.");
  return whatsapp.whatsAppDeliveryStatus(user, messageId);
}

// ─── PC: catalogue tools only ───────────────────────────────────────────────

const pcCall = z.object({ tool: z.string().trim().min(1).max(80), arguments: z.record(z.unknown()).optional() }).strict();
const PC_READS = new Map(PC_READ_TOOLS.map((tool) => [tool.name, tool]));
let pcSteps: ReturnType<typeof pcReviewedToolsByName> | undefined;
const pcStep = (name: string) => (pcSteps ??= pcReviewedToolsByName()).get(name);

/** The PC's read tools by name: exactly the MCP gateway's (text state only). */
export const PC_READ_TOOL_NAMES = [...PC_READS.keys()];
export function pcStepToolNames(): string[] {
  return [...(pcSteps ??= pcReviewedToolsByName()).keys()];
}

export async function readPc(user: AuthedUser, params: Params): Promise<ServiceResult<unknown>> {
  const parsed = parse(pcCall, params);
  if (!parsed.ok) return parsed;
  const tool = PC_READS.get(parsed.data.tool);
  if (!tool) return fail(400, "VALIDATION_FAILED", `${parsed.data.tool} is not a PC read tool. Read tools: ${PC_READ_TOOL_NAMES.join(", ")}.`);
  return tool.run(user, parsed.data.arguments ?? {});
}

export async function operatePc(user: AuthedUser, params: Params, confirmed: boolean): Promise<ServiceResult<unknown>> {
  const parsed = parse(pcCall, params);
  if (!parsed.ok) return parsed;
  const tool = pcStep(parsed.data.tool);
  if (!tool || !tool.preview) return fail(400, "VALIDATION_FAILED", `${parsed.data.tool} is not a PC step Secretary offers. Steps: ${pcStepToolNames().join(", ")}.`);
  const args = parse(z.object(tool.fields).strict(), parsed.data.arguments ?? {});
  if (!args.ok) return args;
  // The step is previewed again at the yes, so what runs is what was shown.
  const preview = await tool.preview(user, args.data);
  if (!preview.ok) return preview;
  if (!confirmed) {
    return confirmationRequired(
      `Review the step on the owner's PC. It runs only after a yes, and the PC asks its owner again. ${tool.sideEffects}`,
      preview.data,
      { tool: tool.name, arguments: args.data },
    );
  }
  const input = { tool: tool.name, argumentNames: Object.keys(args.data).sort() };
  const stopped = await notStopped(user);
  if (!stopped.ok) {
    await audit(user, OPERATE_PC_ACTION, input, "rejected", { errorMessage: SAFE_MODE_ACTIVE });
    return stopped;
  }
  try {
    const result = await tool.run(user, args.data, preview.data);
    await audit(user, OPERATE_PC_ACTION, input, result.ok ? "success" : "error", result.ok ? {} : { errorMessage: result.error });
    return result;
  } catch (error) {
    if (!(error instanceof PcOutcomeUnknownError)) throw error;
    await audit(user, OPERATE_PC_ACTION, input, "error", { errorMessage: "OUTCOME_UNKNOWN" });
    return fail(502, "OUTCOME_UNKNOWN", `${error.message} It is not repeated by itself; check the PC before asking again.`);
  }
}

/** Every PC tool the assistant may use, with its parameters, and what is not offered and why. */
export async function listPcTools(user: AuthedUser, params: Params): Promise<ServiceResult<unknown>> {
  const parsed = parse(z.object({}).strict(), params);
  if (!parsed.ok) return parsed;
  const { zodToJsonSchema } = await import("zod-to-json-schema");
  const { PC_TOOLS_NOT_OFFERED_THROUGH_SECRETARY, PC_TEXT_STATE_RULE } = await import("../modules/mcp/deviceTools.js");
  return ok(200, {
    rule: PC_TEXT_STATE_RULE,
    read_with: "read_pc {tool, arguments}",
    change_with: "operate_pc {tool, arguments}: previewed, then a yes; the PC asks its owner again",
    reads: PC_READ_TOOLS.map((tool) => ({ tool: tool.name, description: tool.description, arguments: tool.inputSchema })),
    steps: [...(pcSteps ??= pcReviewedToolsByName()).values()].map((tool) => {
      const schema = zodToJsonSchema(z.object(tool.fields).strict(), { $refStrategy: "none" }) as Record<string, unknown>;
      delete schema.$schema;
      return { tool: tool.name, description: tool.description, arguments: schema };
    }),
    not_offered: PC_TOOLS_NOT_OFFERED_THROUGH_SECRETARY,
    available: PC_READ_TOOLS[0]?.available(user) ?? false,
  });
}
