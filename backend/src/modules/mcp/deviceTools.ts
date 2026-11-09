/**
 * MCP tools for the owner's phone (SMS Bridge) and PC (PC Control Plus).
 *
 * Reads run at once under their Action Contract (permission, administrator
 * switch, company binding of the device). Everything that leaves the company
 * or acts on the PC is a reviewed write of writeTools.ts: preview, the user's
 * explicit yes through confirm_action, then one request whose id is derived
 * from the confirmation, so the same yes can never send twice. An outcome
 * that cannot be known is kept as OUTCOME_UNKNOWN and never retried by
 * itself; get_outbound_message_status reports it, and resubmit_phone_message
 * is a new, previewed decision that reuses the original request id.
 *
 * The PC tools are generated from the pc_engine catalogue
 * (pcEngineCatalogue.generated.ts: names, parameters and guidance are the
 * engine's, prefixed pc_) and from the PC Control Plus relay's own tools
 * (pcpRelayCatalogue.generated.ts, with Secretary's decision per tool in
 * pcRelayPolicy.ts). There is no generic execute or shell tool; the tools
 * Secretary does not offer are described with the reason
 * (PC_TOOLS_NOT_OFFERED_THROUGH_SECRETARY).
 */
import { z } from "zod";
import { prisma } from "../../db.js";
import type { AuthedUser } from "../../middleware/auth.js";
import {
  OPERATE_PC_ACTION,
  READ_PC_ACTION,
  READ_PHONE_MESSAGES_ACTION,
  REPLY_PHONE_CHAT_ACTION,
  REPLY_WHATSAPP_MESSAGE_ACTION,
  SEND_PHONE_SMS_ACTION,
  SEND_WHATSAPP_MESSAGE_ACTION,
  type ActionContract,
} from "../../lib/actionContracts.js";
import { reviewedActionById } from "../../lib/executionEngine.js";
import { evaluateEmmaCapabilities } from "../../services/emmaPolicyService.js";
import * as pc from "../../services/pcControlPlusService.js";
import * as phone from "../../services/smsBridgeService.js";
import * as whatsapp from "../../services/whatsappBusinessConnectorService.js";
import { whatsAppConfigurationAvailable } from "../../connectors/whatsappBusinessAdapter.js";
import { fail, ok, type ServiceResult } from "../../services/result.js";
import { PC_ENGINE_CATALOGUE } from "./pcEngineCatalogue.generated.js";
import { PC_RELAY_POLICY, type PcRelayDecision } from "./pcRelayPolicy.js";
import { PCP_RELAY_CATALOGUE } from "./pcpRelayCatalogue.generated.js";
import { RESERVED_IDEMPOTENCY_PREFIX } from "../../middleware/idempotency.js";
import { ordinalCompare } from "../../lib/ordinalCompare.js";
import type { StoredOperation, WriteToolDefinition } from "./writeTools.js";

/** The keys under which writeTools stores each confirmation's answer. */
const RESERVED_CONFIRM_PREFIX = `${RESERVED_IDEMPOTENCY_PREFIX}confirm:`;

const REVIEW_ACTION_TYPE = "mcp_write_review";

/** A read tool of the devices: what the gateway lists, checks and runs. */
export interface DeviceReadTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  contract: ActionContract;
  available: (user: AuthedUser) => boolean;
  limitations: string[];
  run: (user: AuthedUser, args: unknown) => Promise<ServiceResult<unknown>>;
}

const phoneAvailable = (user: AuthedUser) => phone.smsBridgeAvailableFor(user.companyId);
const pcAvailable = (user: AuthedUser) => pc.pcControlPlusAvailableFor(user.companyId);

/** The contract may run now for this person: permission, password, administrator switch. */
export async function contractAllowed(user: AuthedUser, contract: ActionContract): Promise<ServiceResult<true>> {
  if (user.mustChangePassword) return fail(403, "PASSWORD_CHANGE_REQUIRED", "Change the temporary password in Secretary first.");
  if (contract.requiredPermission !== "authenticated" && !user.permissions.includes(contract.requiredPermission)) {
    return fail(403, "MISSING_PERMISSION", `Missing required permission: ${contract.requiredPermission}`);
  }
  const decision = await evaluateEmmaCapabilities(user, [`action.${contract.actionName}`]);
  return decision.allowed ? ok(200, true) : fail(403, "NOT_ALLOWED", decision.message);
}

function parse<T extends z.ZodTypeAny>(schema: T, args: unknown): ServiceResult<z.infer<T>> {
  const parsed = schema.safeParse(args ?? {});
  return parsed.success
    ? ok(200, parsed.data)
    : fail(400, "VALIDATION_FAILED", parsed.error.issues.map((issue) => `${issue.path.join(".") || "arguments"}: ${issue.message}`).join("; "));
}

// ─── The phone: reads ───────────────────────────────────────────────────────

const smsListArgs = z.object({
  address: z.string().trim().max(100).optional(),
  text: z.string().trim().max(200).optional(),
  direction: z.enum(["in", "out"]).optional(),
  since: z.string().datetime({ offset: true }).optional(),
  until: z.string().datetime({ offset: true }).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.string().max(500).optional(),
}).strict();
const chatListArgs = z.object({
  channel: z.enum(phone.PHONE_CHAT_CHANNELS).optional(),
  since: z.string().datetime({ offset: true }).optional(),
  limit: z.number().int().min(1).max(200).optional(),
  cursor: z.string().max(500).optional(),
}).strict();
const statusArgs = z.object({ confirmation_id: z.string().uuid() }).strict();

export const DEVICE_READ_TOOLS: DeviceReadTool[] = [
  {
    name: "phone_status",
    title: "Owner phone status (SMS Bridge)",
    description: "Whether the owner's phone is online for Secretary through SMS Bridge: last contact, SMS synchronised, outgoing SMS by status, queued phone actions, health, and whether the notification listener for WhatsApp/Messenger is on.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    contract: READ_PHONE_MESSAGES_ACTION,
    available: phoneAvailable,
    limitations: ["Reports what the phone last told SMS Bridge; an offline phone keeps queued messages until it returns."],
    run: async (user, args) => {
      const parsed = parse(z.object({}).strict(), args);
      return parsed.ok ? phone.phoneStatus(user) : parsed;
    },
  },
  {
    name: "list_phone_sms",
    title: "Read SMS from the owner's phone",
    description: "Read SMS the phone owner synchronised to SMS Bridge, newest first: address, text, time, received or sent. Filters: address, text, direction (in/out), since/until (ISO time), limit, cursor (next page).",
    inputSchema: {
      type: "object",
      properties: {
        address: { type: "string", description: "Only this phone number or sender name." },
        text: { type: "string", description: "Only SMS containing this text." },
        direction: { type: "string", enum: ["in", "out"] },
        since: { type: "string", format: "date-time" },
        until: { type: "string", format: "date-time" },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        cursor: { type: "string", description: "next_cursor from the previous page." },
      },
      additionalProperties: false,
    },
    contract: READ_PHONE_MESSAGES_ACTION,
    available: phoneAvailable,
    limitations: ["Only SMS the phone owner synchronised to SMS Bridge (the phone decides how many and from when); not the whole phone history."],
    run: async (user, args) => {
      const parsed = parse(smsListArgs, args);
      return parsed.ok ? phone.readPhoneSms(user, parsed.data) : parsed;
    },
  },
  {
    name: "list_phone_chat_messages",
    title: "Read WhatsApp/Messenger messages seen in the phone's notifications",
    description: "Read WhatsApp and Messenger messages the owner's phone captured from its notifications, newest first: chat, sender, text, time. " + phone.PHONE_CHAT_LIMITATION + " For the business WhatsApp number use list_whatsapp_senders and the communications tools instead.",
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string", enum: [...phone.PHONE_CHAT_CHANNELS] },
        since: { type: "string", format: "date-time" },
        limit: { type: "integer", minimum: 1, maximum: 200 },
        cursor: { type: "string" },
      },
      additionalProperties: false,
    },
    contract: READ_PHONE_MESSAGES_ACTION,
    available: phoneAvailable,
    limitations: [phone.PHONE_CHAT_LIMITATION],
    run: async (user, args) => {
      const parsed = parse(chatListArgs, args);
      return parsed.ok ? phone.readPhoneChats(user, parsed.data) : parsed;
    },
  },
  {
    name: "get_outbound_message_status",
    title: "Status of an SMS or phone chat reply sent through Secretary",
    description: "What SMS Bridge knows about a message sent with send_phone_sms, reply_phone_chat or resubmit_phone_message, by the confirmation_id of that send: queued, sent, failed, uncertain, or unknown when Secretary could not learn whether the bridge received it.",
    inputSchema: { type: "object", properties: { confirmation_id: { type: "string", format: "uuid" } }, required: ["confirmation_id"], additionalProperties: false },
    contract: READ_PHONE_MESSAGES_ACTION,
    available: phoneAvailable,
    limitations: ["Reads only; never sends again. An unknown outcome is resolved only by resubmit_phone_message, a new previewed decision that cannot send twice."],
    run: async (user, args) => {
      const parsed = parse(statusArgs, args);
      return parsed.ok ? outboundStatus(user, parsed.data.confirmation_id) : parsed;
    },
  },
];

// ─── Outbound operations: status and the original send ──────────────────────

const PHONE_SEND_TOOLS = new Set(["send_phone_sms", "reply_phone_chat"]);

interface OriginalSend {
  tool: "send_phone_sms" | "reply_phone_chat";
  args: Record<string, any>;
  requestId: string;
  stored: { status: string; remoteId?: string; error?: string } | null;
}

/**
 * The caller's own confirmed phone send, by its confirmation_id, inside the
 * company. What was sent comes from the confirmation's idempotency record
 * (the review's payload is cleared once it resolves); a review that is still
 * waiting or executing has its payload and no finished record yet.
 */
async function originalSend(user: AuthedUser, confirmationId: string, depth = 0): Promise<ServiceResult<OriginalSend>> {
  const own = await prisma.idempotencyRecord.findFirst({
    where: { companyId: user.companyId, userId: user.id, key: { startsWith: RESERVED_CONFIRM_PREFIX, endsWith: `:${user.id}:${confirmationId}` } },
    orderBy: { createdAt: "desc" },
  });
  const ownBody = own?.responseBody as { operation?: StoredOperation } | null;
  let operation: StoredOperation | undefined = ownBody?.operation;
  if (!operation) {
    const review = await reviewedActionById(user, REVIEW_ACTION_TYPE, confirmationId);
    const payload = review?.payload as { tool?: string; arguments?: Record<string, unknown> } | null | undefined;
    if (payload?.tool) operation = { tool: payload.tool, arguments: payload.arguments ?? {} };
  }
  if (!operation) return fail(404, "CONFIRMATION_NOT_FOUND", "No phone message was prepared or confirmed with this confirmation_id.");
  const args = operation.arguments as Record<string, any>;
  if (operation.tool === "resubmit_phone_message") {
    // A resubmission carries on the original send and its request id.
    if (depth > 3) return fail(400, "VALIDATION_FAILED", "This resubmission does not lead to a phone send.");
    return originalSend(user, String(args.confirmation_id), depth + 1);
  }
  if (!PHONE_SEND_TOOLS.has(operation.tool)) return fail(400, "VALIDATION_FAILED", "This confirmation_id belongs to another kind of change.");
  const requestId = phone.bridgeRequestId(user.companyId, confirmationId);
  // Any confirmation of this user that reached the bridge with this request id
  // (the original send, or a later resubmission) carries the bridge's id.
  const accepted = await prisma.idempotencyRecord.findFirst({
    where: { companyId: user.companyId, userId: user.id, status: "completed", key: { startsWith: RESERVED_CONFIRM_PREFIX },
      responseBody: { path: ["outcome", "payload", "data", "request_id"], equals: requestId } },
    orderBy: { createdAt: "desc" },
  });
  const record = accepted ?? own;
  const outcome = (record?.responseBody as { outcome?: { ok?: boolean; payload?: any } } | null)?.outcome;
  const stored = record
    ? {
        status: record.status,
        remoteId: outcome?.payload?.data?.remote_id ? String(outcome.payload.data.remote_id) : undefined,
        error: outcome?.payload?.error ? String(outcome.payload.error) : undefined,
      }
    : null;
  return ok(200, { tool: operation.tool as OriginalSend["tool"], args, requestId, stored });
}

async function outboundStatus(user: AuthedUser, confirmationId: string): Promise<ServiceResult<unknown>> {
  const original = await originalSend(user, confirmationId);
  if (!original.ok) return original;
  const { tool, stored, requestId } = original.data;
  if (!stored) {
    return ok(200, { confirmation_id: confirmationId, tool, status: "not_confirmed", meaning: "This send was previewed but not confirmed, so nothing was sent." });
  }
  if (stored.remoteId) {
    const live = tool === "send_phone_sms" ? await phone.phoneSmsStatus(user, stored.remoteId) : await phone.phoneChatReplyStatus(user, stored.remoteId);
    return live.ok ? ok(200, { confirmation_id: confirmationId, tool, request_id: requestId, ...(live.data as object) }) : live;
  }
  if (stored.status === "unknown" || stored.error === "OUTCOME_UNKNOWN") {
    return ok(200, {
      confirmation_id: confirmationId, tool, request_id: requestId, status: "unknown",
      meaning: "Secretary could not learn whether SMS Bridge received this send. It is not retried by itself. resubmit_phone_message (previewed, needs the user's yes) asks the bridge again with the same request id: if the bridge already has it, nothing new is sent.",
    });
  }
  return ok(200, { confirmation_id: confirmationId, tool, request_id: requestId, status: stored.error ? "refused" : stored.status, error: stored.error ?? null,
    meaning: stored.error ? "The send was refused before anything left Secretary or SMS Bridge refused it." : "Recorded without a bridge id." });
}

// ─── The phone: reviewed sends ──────────────────────────────────────────────

const PHONE_LIMITS = [
  "Sent from the owner's phone by SMS Bridge: the phone must be online; while it is offline the message waits on the bridge.",
  "One confirmation is one bridge request id: confirming again, or a retry, can never send it twice. An unknown outcome is never retried by itself.",
];

async function runPhoneSend(user: AuthedUser, tool: OriginalSend["tool"], args: Record<string, any>, requestId: string): Promise<ServiceResult<unknown>> {
  // Network errors are thrown (writeTools keeps the outcome unknown, never retried).
  const result = tool === "send_phone_sms"
    ? await phone.sendPhoneSms(user, { to: args.to, text: args.text }, requestId)
    : await phone.replyPhoneChat(user, { channel: args.channel, chat: args.chat, text: args.text }, requestId);
  if (!result.ok) return result;
  const { remote_id, status, created } = result.data;
  return ok(202, {
    remote_id, status, request_id: requestId, already_known_to_bridge: !created,
    next: "Use get_outbound_message_status with this confirmation_id to see whether the phone sent it.",
  });
}

function unwrapThrownNetwork<T>(work: () => Promise<T>): Promise<T> {
  // SmsBridgeNetworkError with delivered=false cannot have reached the bridge:
  // it is answered (nothing sent, safe to confirm again later) instead of being
  // kept as an unknown outcome.
  return work().catch((error) => {
    if (error instanceof phone.SmsBridgeNetworkError && !error.delivered) {
      return fail(502, "PROVIDER_UNAVAILABLE", `${error.message}. Nothing was sent.`) as unknown as T;
    }
    throw error;
  });
}

export function deviceWriteTools(id: (what: string) => z.ZodTypeAny): WriteToolDefinition[] {
  return [
    {
      name: "send_phone_sms",
      title: "Send an SMS from the owner's phone (preview first)",
      description: "Prepare one SMS from the owner's phone SIM through SMS Bridge to an explicit international number. Returns the exact number and text and a confirmation_id; nothing is sent until confirm_action after the user's explicit yes. Only send what the user asked for; never invent a recipient or text.",
      contract: SEND_PHONE_SMS_ACTION,
      sideEffects: "After confirmation, one SMS is queued on the owner's phone and sent from its SIM to the previewed number. It cannot be recalled once the phone has taken it.",
      kind: "reviewed",
      reviewReason: "irreversible",
      external: true,
      available: phoneAvailable,
      limitations: [...PHONE_LIMITS, `At most ${phone.SMS_MAX_CHARS} characters; SMS Bridge enforces a daily sending cap.`],
      fields: {
        to: z.string().trim().regex(phone.E164, "to must be an international number such as +447700900123").describe("The recipient's number in international E.164 form, exactly as the user gave it."),
        text: z.string().min(1).max(phone.SMS_MAX_CHARS).describe("The exact SMS text the user wants sent."),
      },
      preview: (user, a) => phone.previewPhoneSms(user, a as { to: string; text: string }),
      run: (user, a, _verified, context) => unwrapThrownNetwork(() =>
        runPhoneSend(user, "send_phone_sms", a, phone.bridgeRequestId(user.companyId, context?.confirmationId ?? "missing"))),
    },
    {
      name: "reply_phone_chat",
      title: "Reply in a WhatsApp/Messenger chat from the owner's phone (preview first)",
      description: "Prepare a reply in a WhatsApp or Messenger chat that the owner's phone captured a notification of (see list_phone_chat_messages), sent through that notification's reply action. Returns the exact chat and text and a confirmation_id; nothing is sent until confirm_action after the user's explicit yes. This is not the WhatsApp Business API: it cannot start new chats, send media or reach a chat without a notification.",
      contract: REPLY_PHONE_CHAT_ACTION,
      sideEffects: "After confirmation, the phone answers in the previewed chat through its notification's reply action. It cannot be recalled; WhatsApp and Messenger report no delivery to Secretary.",
      kind: "reviewed",
      reviewReason: "irreversible",
      external: true,
      available: phoneAvailable,
      limitations: [...PHONE_LIMITS, phone.PHONE_CHAT_LIMITATION],
      fields: {
        channel: z.enum(phone.PHONE_CHAT_CHANNELS).describe("whatsapp or messenger."),
        chat: z.string().trim().min(1).max(200).describe("The chat name exactly as list_phone_chat_messages returned it."),
        text: z.string().min(1).max(phone.CHAT_REPLY_MAX_CHARS).describe("The exact reply the user wants sent."),
      },
      preview: (user, a) => phone.previewPhoneChatReply(user, a as { channel: string; chat: string; text: string }),
      run: (user, a, _verified, context) => unwrapThrownNetwork(() =>
        runPhoneSend(user, "reply_phone_chat", a, phone.bridgeRequestId(user.companyId, context?.confirmationId ?? "missing"))),
    },
    {
      name: "resubmit_phone_message",
      title: "Resolve an SMS or chat reply whose outcome is unknown (preview first)",
      description: "For a send whose outcome get_outbound_message_status reports as unknown: prepare asking SMS Bridge again with the original request id. If the bridge already has the message nothing new is sent and its status is returned; if it never arrived, it is sent once. Returns the original recipient and text and a confirmation_id; nothing happens until confirm_action after the user's explicit yes.",
      contract: SEND_PHONE_SMS_ACTION,
      sideEffects: "After confirmation, at most one message is sent: the original one, only if SMS Bridge never received it.",
      kind: "reviewed",
      reviewReason: "irreversible",
      external: true,
      available: phoneAvailable,
      limitations: ["Only for the user's own send with an unknown outcome; a send the bridge accepted, or one that was refused, is not resubmitted."],
      fields: { confirmation_id: id("confirmation_id").describe("The confirmation_id of the original send_phone_sms or reply_phone_chat.") },
      preview: async (user, a) => {
        const original = await originalSend(user, a.confirmation_id);
        if (!original.ok) return original;
        const { tool, args, requestId, stored } = original.data;
        if (!stored) return fail(409, "NOT_CONFIRMED", "That send was never confirmed, so nothing is unknown about it.");
        if (stored.remoteId) return fail(409, "OUTCOME_KNOWN", "SMS Bridge has this message; use get_outbound_message_status instead.");
        if (stored.error && stored.error !== "OUTCOME_UNKNOWN") return fail(409, "OUTCOME_KNOWN", `That send was refused (${stored.error}); prepare a new one if it is still wanted.`);
        return ok(200, {
          original_confirmation_id: a.confirmation_id, tool, request_id: requestId,
          ...(tool === "send_phone_sms" ? { to: args.to, text: args.text } : { channel: args.channel, chat: args.chat, text: args.text }),
          effect: "SMS Bridge is asked again with the same request id: if it already received this message, nothing new is sent.",
        });
      },
      run: async (user, a, verified) => unwrapThrownNetwork(async () => {
        const original = await originalSend(user, a.confirmation_id);
        if (!original.ok) return original;
        return runPhoneSend(user, original.data.tool, original.data.args, String(verified?.request_id ?? original.data.requestId));
      }),
    },
    ...whatsAppBusinessWriteTools(),
    ...pcWriteTools(),
  ];
}

// ─── The official WhatsApp Business API (existing connector) ───────────────

const WHATSAPP_BUSINESS_LIMITS = [
  "Sent from the company's WhatsApp Business number through Meta's Cloud API (the existing connector), not from the owner's phone.",
  "Meta accepts a free-form message only within 24 hours of the person's last message to the business; approved templates are not sent by Secretary, so a later message is refused and nothing is sent.",
  "Meta takes no request id: if Secretary cannot learn whether Meta accepted the message, the outcome is kept as unknown and is never sent again by itself. Check the chat in WhatsApp before preparing it again.",
];

/** Meta may have taken the message although Secretary learned no answer: kept as unknown, never retried. */
const WHATSAPP_UNCERTAIN = new Set(["PROVIDER_UNAVAILABLE", "PROVIDER_RESPONSE_INVALID", "CONNECTOR_INTERNAL_ERROR"]);

class WhatsAppOutcomeUnknownError extends Error {}

async function runWhatsAppBusiness(send: () => Promise<ServiceResult<unknown>>): Promise<ServiceResult<unknown>> {
  const result = await send();
  if (!result.ok && WHATSAPP_UNCERTAIN.has(result.error)) {
    throw new WhatsAppOutcomeUnknownError(`WhatsApp Business answered ${result.error}; the message may or may not have been sent.`);
  }
  return result;
}

function whatsAppBusinessWriteTools(): WriteToolDefinition[] {
  const available = () => whatsAppConfigurationAvailable();
  const text = z.string().trim().min(1).max(4096).describe("The exact message text, in the language it is sent in. It is sent as written; nothing is translated.");
  return [
    {
      name: "send_whatsapp_business_message",
      title: "Send a WhatsApp Business message (preview first)",
      description: "Prepare one WhatsApp message from the company's WhatsApp Business number (Meta Cloud API) to an explicit international number. Returns the exact number and text and a confirmation_id; nothing is sent until confirm_action after the user's explicit yes. Meta delivers it only within 24 hours of that person's last message to the business. Only send what the user asked for; never invent a recipient or text.",
      contract: SEND_WHATSAPP_MESSAGE_ACTION,
      sideEffects: "After confirmation, one WhatsApp text message is sent from the company's WhatsApp Business number to the previewed number. It cannot be recalled.",
      kind: "reviewed",
      reviewReason: "irreversible",
      external: true,
      available,
      limitations: WHATSAPP_BUSINESS_LIMITS,
      fields: {
        to: z.string().trim().regex(phone.E164, "to must be an international number such as +447700900123").describe("The recipient's number in international E.164 form, exactly as the user gave it."),
        text,
      },
      preview: (user, a) => whatsapp.whatsAppBusinessSendPreview(user, { to: a.to, body: a.text }),
      run: (user, a, verified) => runWhatsAppBusiness(() =>
        whatsapp.sendWhatsAppMessage(user, String(verified?.sourceId), { to: a.to, body: a.text, confirmed: true })),
    },
    {
      name: "reply_whatsapp_business_message",
      title: "Reply to a WhatsApp Business message (preview first)",
      description: "Prepare a reply to one message received on the company's WhatsApp Business number, by its id (messages[].id from get_whatsapp_sender). The reply quotes that message in the customer's WhatsApp thread. Returns the recipient, the message answered and the exact text and a confirmation_id; nothing is sent until confirm_action after the user's explicit yes. Refused when the 24-hour window has closed.",
      contract: REPLY_WHATSAPP_MESSAGE_ACTION,
      sideEffects: "After confirmation, one WhatsApp reply is sent from the company's WhatsApp Business number to the sender of the previewed message, and noted on that message. It cannot be recalled.",
      kind: "reviewed",
      reviewReason: "irreversible",
      external: true,
      available,
      limitations: [...WHATSAPP_BUSINESS_LIMITS, "Answers only messages the connector received (webhook); a chat on the owner's phone is reply_phone_chat."],
      fields: {
        intake_id: z.string().uuid().describe("The received message's id, exactly as get_whatsapp_sender returned it (messages[].id)."),
        text,
      },
      preview: (user, a) => whatsapp.whatsAppBusinessReplyPreview(user, { intake_id: a.intake_id, body: a.text }),
      run: (user, a, verified) => runWhatsAppBusiness(() =>
        whatsapp.replyToWhatsAppMessage(user, String(verified?.sourceId), { intake_id: a.intake_id, body: a.text, confirmed: true })),
    },
  ];
}

// ─── The PC: generated from the pc_engine catalogue ─────────────────────────

type EngineTool = (typeof PC_ENGINE_CATALOGUE.tools)[number];
type EngineParam = EngineTool["params"][number];

/** Engine tools not offered through Secretary: arbitrary JavaScript is no catalogue action. */
export const PC_TOOLS_NOT_OFFERED: Record<string, string> = {
  browser_eval: "Runs arbitrary JavaScript in a page; not offered through Secretary (it is also off on the PC by default).",
  browser_close: "Ends the PC's own browser session; a matter for the PC itself, not offered through Secretary.",
};

const engineTools = PC_ENGINE_CATALOGUE.tools.filter((tool) => !(tool.name in PC_TOOLS_NOT_OFFERED));
const text = (value: string) => value.replace(/\{p\}/g, "pc_");

function jsonType(param: EngineParam): Record<string, unknown> {
  const base = param.kind === "str" ? { type: "string" } : param.kind === "int" ? { type: "integer" } : param.kind === "bool" ? { type: "boolean" }
    : param.kind === "list" ? { type: "array", items: { type: "object" }, maxItems: 40 } : { type: "object" };
  return { ...base, ...(param.description ? { description: param.description } : {}), ...(param.default !== null && param.default !== undefined ? { default: param.default } : {}) };
}

function zodType(param: EngineParam): z.ZodTypeAny {
  const base = param.kind === "str" ? z.string().max(20_000) : param.kind === "int" ? z.number().int() : param.kind === "bool" ? z.boolean()
    : param.kind === "list" ? z.array(z.record(z.unknown())).max(40) : z.record(z.unknown());
  const described = param.description ? base.describe(param.description) : base;
  return param.required ? described : described.optional();
}

function engineSchema(tool: EngineTool): Record<string, unknown> {
  return {
    type: "object",
    properties: Object.fromEntries(tool.params.map((param) => [param.name, jsonType(param)])),
    ...(tool.params.some((param) => param.required) ? { required: tool.params.filter((param) => param.required).map((param) => param.name) } : {}),
    additionalProperties: false,
  };
}

/** The owner's rule for every PC tool, stated in each tool's limitations and in the gateway instructions. */
export const PC_TEXT_STATE_RULE = "PC control works only from text state (page snapshots and UI Automation), never from screenshots: no screenshot, camera or screen-coordinate tool is offered, and no image ever drives a step.";

const PC_LIMITS = [
  PC_TEXT_STATE_RULE,
  "Runs on the owner's PC through PC Control Plus; the PC must be online and its agent connected.",
  "The PC keeps its own rules: public HTTPS addresses only, the owner's other tabs untouched, its read-only profile, and its own approval on the PC.",
];

export const PC_READ_TOOLS: DeviceReadTool[] = [
  {
    name: "pc_connection_status",
    title: "Owner PC browser connection (PC Control Plus)",
    description: "Whether the Chrome or Edge open on the owner's PC allows remote debugging for PC Control Plus, and how to switch it on. Starts, restarts or closes nothing; never returns the browser's debugging identifier.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    contract: READ_PC_ACTION,
    available: pcAvailable,
    limitations: PC_LIMITS,
    run: async (user, args) => {
      const parsed = parse(z.object({}).strict(), args);
      return parsed.ok ? pc.callPc(user, pc.PC_STATUS_TOOL, {}, { mayHaveEffect: false }) : parsed;
    },
  },
  ...engineTools.filter((tool) => tool.read_only).map((tool): DeviceReadTool => {
    const schema = z.object(Object.fromEntries(tool.params.map((param) => [param.name, zodType(param)]))).strict();
    return {
      name: `pc_${tool.name}`,
      title: `PC: ${tool.name.replace(/_/g, " ")}`,
      description: `${text(tool.summary)}\n\nOn the owner's PC through PC Control Plus. Use when: ${text(tool.use_when)}`,
      inputSchema: engineSchema(tool),
      contract: READ_PC_ACTION,
      available: pcAvailable,
      limitations: PC_LIMITS,
      run: async (user, args) => {
        const parsed = parse(schema, args);
        return parsed.ok ? pc.callPc(user, tool.name, parsed.data, { mayHaveEffect: false }) : parsed;
      },
    };
  }),
  ...relayTools("read").map(({ tool, schema, fields }): DeviceReadTool => {
    const validator = z.object(fields).strict();
    return {
      name: tool.name,
      title: `PC: ${tool.relay_tool.replace(/_/g, " ")}`,
      description: `${tool.description}\n\nOn the owner's PC through PC Control Plus.`,
      inputSchema: schema,
      contract: READ_PC_ACTION,
      available: pcAvailable,
      limitations: PC_LIMITS,
      run: async (user, args) => {
        const parsed = parse(validator, args);
        return parsed.ok ? pc.callPcRelay(user, tool.relay_tool, parsed.data, { mayHaveEffect: false }) : parsed;
      },
    };
  }),
];

// ─── The PC: the relay's own tools, by Secretary's decision ─────────────────

type RelayTool = (typeof PCP_RELAY_CATALOGUE.tools)[number];
interface JsonSchema { type?: string; anyOf?: JsonSchema[]; items?: JsonSchema; default?: unknown; description?: string; [key: string]: unknown }

interface ControlLoop { jobs: readonly string[]; state: string; screenshot_free: boolean; evidence: readonly string[] }

/**
 * Secretary's decision for a relay job, under the text-state rule: a control
 * loop is offered only when the importer attested from its source that the
 * whole loop works without screenshots; a loop without that attestation, or
 * whose source uses pixels, is not offered, whatever the policy says. A job
 * without a decision is not offered.
 */
export function decideRelayJob(job: string, policy: Record<string, PcRelayDecision>, loops: Record<string, ControlLoop>): PcRelayDecision {
  const decision = policy[job] ?? { kind: "not_offered", reason: "Secretary has not decided how to offer this PC Control Plus tool yet." };
  if (decision.kind === "not_offered") return decision;
  const loop = Object.values(loops).find((entry) => entry.jobs.includes(job));
  // A job that runs a control loop on the PC (an AI deciding step after step) needs the attestation.
  if (/_goal_/.test(job) && !loop) {
    return { kind: "not_offered", reason: "This PC task runs a control loop that is not attested to work from text state only; PC control through Secretary never uses screenshots." };
  }
  if (loop && !loop.screenshot_free) {
    return { kind: "not_offered", reason: `This PC task's control loop uses screenshots or images (${loop.evidence[0] ?? "pixel capture"}); PC control through Secretary works only from text state.` };
  }
  return decision;
}

export function relayDecision(job: string): PcRelayDecision {
  return decideRelayJob(job, PC_RELAY_POLICY, PCP_RELAY_CATALOGUE.control_loops as unknown as Record<string, ControlLoop>);
}

/** The text state a relay job's control loop works from ("dom" or "uia"), when it runs one. */
function loopState(job: string): string | undefined {
  return Object.values(PCP_RELAY_CATALOGUE.control_loops as unknown as Record<string, ControlLoop>).find((entry) => entry.jobs.includes(job))?.state;
}

/** The relay's argument schema as a strict validator; an unknown schema shape fails when this module loads. */
function zodFromJson(schema: JsonSchema, where: string): z.ZodTypeAny {
  if (schema.anyOf) {
    const others = schema.anyOf.filter((option) => option.type !== "null");
    if (others.length !== 1 || others.length === schema.anyOf.length) throw new Error(`${where}: unsupported anyOf`);
    return zodFromJson(others[0], where).nullable();
  }
  switch (schema.type) {
    case "string": return z.string().max(20_000);
    case "integer": return z.number().int();
    case "number": return z.number();
    case "boolean": return z.boolean();
    case "object": return z.record(z.unknown());
    case "array": return z.array(schema.items ? zodFromJson(schema.items, `${where}[]`) : z.unknown()).max(40);
    // An item the relay leaves untyped (a bare Python list): any JSON value; the PC checks it.
    case undefined: if (Object.keys(schema).length === 0) return z.unknown();
    // falls through
    default: throw new Error(`${where}: unsupported schema type ${String(schema.type)}`);
  }
}

function relayTools(kind: "read" | "reviewed") {
  return PCP_RELAY_CATALOGUE.tools.filter((tool) => relayDecision(tool.relay_tool).kind === kind).map((tool: RelayTool) => {
    const decision = relayDecision(tool.relay_tool);
    const omitted = new Set(decision.kind === "reviewed" ? decision.omitParams ?? [] : []);
    const source = tool.input_schema as { properties?: Record<string, JsonSchema>; required?: readonly string[] };
    const properties = Object.fromEntries(Object.entries(source.properties ?? {}).filter(([name]) => !omitted.has(name))
      .map(([name, property]) => [name, Object.fromEntries(Object.entries(property).filter(([key]) => key !== "title"))]));
    const required = (source.required ?? []).filter((name) => !omitted.has(name));
    const fields = Object.fromEntries(Object.entries(properties).map(([name, property]) => {
      const base = zodFromJson(property as JsonSchema, `${tool.name}.${name}`);
      return [name, required.includes(name) ? base : base.optional()];
    }));
    const schema = { type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false };
    return { tool, decision, schema, fields };
  });
}

/** Every PC tool Secretary does not offer, with the reason: shown by describe_capabilities. */
export const PC_TOOLS_NOT_OFFERED_THROUGH_SECRETARY: { name: string; upstream: string; reason: string }[] = [
  ...Object.entries(PC_TOOLS_NOT_OFFERED).map(([name, reason]) => ({ name: `pc_${name}`, upstream: "pc_engine", reason })),
  ...PCP_RELAY_CATALOGUE.tools.map((tool) => ({ tool, decision: relayDecision(tool.relay_tool) }))
    .filter(({ decision }) => decision.kind === "not_offered")
    .map(({ tool, decision }) => ({ name: tool.name, upstream: "PC Control Plus relay", reason: (decision as { reason: string }).reason })),
].sort((left, right) => ordinalCompare(left.name, right.name));

function pcWriteTools(): WriteToolDefinition[] {
  return [...pcEngineWriteTools(), ...relayTools("reviewed").map(({ tool, decision, fields }): WriteToolDefinition => {
    const reviewed = decision as Extract<PcRelayDecision, { kind: "reviewed" }>;
    return {
      name: tool.name,
      title: `PC: ${tool.relay_tool.replace(/_/g, " ")} (preview first)`,
      description: `${tool.description}\n\nOn the owner's PC through PC Control Plus. The first call returns the exact step and a confirmation_id; nothing runs until confirm_action after the user's explicit yes, and the PC then asks its owner again for every sensitive step.`,
      contract: OPERATE_PC_ACTION,
      sideEffects: `After confirmation and the PC owner's approval: ${reviewed.effect}`,
      kind: "reviewed",
      reviewReason: reviewed.reviewReason,
      external: true,
      available: pcAvailable,
      limitations: [...PC_LIMITS, "If the PC does not answer, the outcome is kept as unknown and the step is never repeated by itself.",
        ...(loopState(tool.relay_tool) ? [`Its control loop decides each step from ${loopState(tool.relay_tool) === "dom" ? "the page's DOM text" : "Windows UI Automation text"}, checked from the PC Control Plus source to take no screenshots.`] : [])],
      fields,
      preview: async (user, a) => {
        if (!pcAvailable(user)) return fail(409, "CONNECTOR_NOT_CONFIGURED", "The owner's PC (PC Control Plus) is not set up for this company.");
        return ok(200, {
          pc_tool: tool.relay_tool,
          arguments: a,
          relay_catalogue: PCP_RELAY_CATALOGUE.relay_sha256.slice(0, 12),
          effect: `${reviewed.effect} It runs on the owner's PC after your yes here and the PC owner's approval on the PC.`,
        });
      },
      run: (user, a) => pc.callPcRelay(user, tool.relay_tool, a, { mayHaveEffect: true }),
    };
  })];
}

function pcEngineWriteTools(): WriteToolDefinition[] {
  return engineTools.filter((tool) => !tool.read_only).map((tool): WriteToolDefinition => ({
    name: `pc_${tool.name}`,
    title: `PC: ${tool.name.replace(/_/g, " ")} (preview first)`,
    description: `${text(tool.summary)}\n\nOn the owner's PC through PC Control Plus. The first call returns the exact step and a confirmation_id; nothing runs until confirm_action after the user's explicit yes, and the PC then asks its owner again. Use when: ${text(tool.use_when)}`,
    contract: OPERATE_PC_ACTION,
    sideEffects: tool.destructive
      ? "After confirmation and the PC owner's approval, the previewed step runs on the PC; it can navigate, submit forms or change data on websites or in Windows apps."
      : "After confirmation, the previewed step runs on the PC.",
    kind: "reviewed",
    reviewReason: tool.destructive ? "irreversible" : "destructive",
    external: true,
    available: pcAvailable,
    limitations: [...PC_LIMITS, "If the PC does not answer, the outcome is kept as unknown and the step is never repeated by itself."],
    fields: Object.fromEntries(tool.params.map((param) => [param.name, zodType(param)])),
    preview: async (user, a) => {
      if (!pcAvailable(user)) return fail(409, "CONNECTOR_NOT_CONFIGURED", "The owner's PC (PC Control Plus) is not set up for this company.");
      return ok(200, {
        pc_tool: tool.name,
        arguments: a,
        engine_version: PC_ENGINE_CATALOGUE.engine_version,
        effect: "This step runs on the owner's PC after your yes here and the PC owner's approval on the PC.",
      });
    },
    run: (user, a) => pc.callPc(user, tool.name, a, { mayHaveEffect: true }),
  }));
}
