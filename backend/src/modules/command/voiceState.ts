import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../../db.js";
import { requireAuth } from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/permissions.js";
import { recordAudit } from "../../lib/audit.js";
import { getAssistantContext } from "../../services/assistantMemoryService.js";

export const voiceStateRouter = Router();
voiceStateRouter.use(requireAuth, requirePermission("voice.execute"));

const updateSchema = z.object({
  status: z.enum(["offline", "listening", "hearing", "thinking", "speaking", "paused", "error"]),
  mode: z.enum(["wake_word", "realtime", "reviewed_text"]).default("wake_word"),
  listening: z.boolean(),
  last_transcript: z.string().trim().max(2000).optional(),
  last_response: z.string().trim().max(4000).optional(),
  ack_control: z.enum(["pause", "resume", "end_conversation"]).optional(),
});
const controlSchema = z.object({ control: z.enum(["pause", "resume", "end_conversation"]) });
const conversationSchema = z.object({ mode: z.enum(["realtime", "reviewed_text", "local"]) });
const messageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().trim().min(1).max(8000),
  sequence: z.number().int().min(1).max(10000).optional(),
  source_event_id: z.string().trim().min(1).max(200).optional(),
});
const endConversationSchema = z.object({ status: z.enum(["completed", "interrupted", "error"]).default("completed") });
const ACTIVE_CONVERSATION_STALE_MS = 20_000;

async function closeOrphanedActiveConversations(userId: string, companyId: string) {
  const state = await prisma.voiceDeviceState.findUnique({ where: { userId }, select: { heartbeatAt: true, mode: true } });
  const hasLiveRealtimeOwner = Boolean(
    state
    && state.mode === "realtime"
    && Date.now() - state.heartbeatAt.getTime() <= ACTIVE_CONVERSATION_STALE_MS
  );
  if (hasLiveRealtimeOwner) return;
  await prisma.voiceConversation.updateMany({
    where: { userId, companyId, status: "active" },
    data: { status: "interrupted", endedAt: new Date() },
  });
}

function publicState(state: any) {
  if (!state) return { status: "offline", mode: "wake_word", listening: false, lastTranscript: null, lastResponse: null, lastUiAction: null, lastHeardAt: null, pendingControl: null, heartbeatAt: null };
  const stale = Date.now() - new Date(state.heartbeatAt).getTime() > 15_000;
  return {
    status: stale ? "offline" : state.status,
    mode: state.mode,
    listening: stale ? false : state.listening,
    lastTranscript: state.lastTranscript,
    lastResponse: state.lastResponse,
    lastUiAction: state.lastUiAction,
    lastHeardAt: state.lastHeardAt,
    pendingControl: state.pendingControl,
    heartbeatAt: state.heartbeatAt,
  };
}

function publicConversation(conversation: any) {
  return {
    id: conversation.id,
    mode: conversation.mode,
    status: conversation.status,
    startedAt: conversation.startedAt,
    endedAt: conversation.endedAt,
    messages: (conversation.messages ?? []).map((message: any) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      sequence: message.sequence,
      occurredAt: message.occurredAt,
    })),
  };
}

voiceStateRouter.get("/voice-conversations", async (req, res) => {
  const parsed = z.coerce.number().int().min(1).max(20).default(10).safeParse(req.query.limit);
  if (!parsed.success) return res.status(400).json({ error: "VALIDATION_FAILED", message: parsed.error.message });
  await closeOrphanedActiveConversations(req.user!.id, req.user!.companyId);
  const conversations = await prisma.voiceConversation.findMany({
    where: { userId: req.user!.id, companyId: req.user!.companyId },
    orderBy: { startedAt: "desc" },
    take: parsed.data,
    include: { messages: { orderBy: { sequence: "asc" } } },
  });
  res.set("Cache-Control", "no-store");
  res.json(conversations.map(publicConversation));
});

voiceStateRouter.get("/assistant-context", async (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json(await getAssistantContext(req.user!));
});

voiceStateRouter.post("/voice-conversations", async (req, res) => {
  const parsed = conversationSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "VALIDATION_FAILED", message: parsed.error.message });
  const now = new Date();
  const [, conversation] = await prisma.$transaction([
    prisma.voiceConversation.updateMany({
      where: { userId: req.user!.id, companyId: req.user!.companyId, status: "active" },
      data: { status: "interrupted", endedAt: now },
    }),
    prisma.voiceConversation.create({
      data: { companyId: req.user!.companyId, userId: req.user!.id, mode: parsed.data.mode },
    }),
  ]);
  res.status(201).json(publicConversation({ ...conversation, messages: [] }));
});

voiceStateRouter.post("/voice-conversations/:id/messages", async (req, res) => {
  const parsed = messageSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "VALIDATION_FAILED", message: parsed.error.message });
  const conversation = await prisma.voiceConversation.findFirst({
    where: { id: req.params.id, userId: req.user!.id, companyId: req.user!.companyId },
  });
  if (!conversation) return res.status(404).json({ error: "VOICE_CONVERSATION_NOT_FOUND" });
  if (parsed.data.source_event_id) {
    const existing = await prisma.voiceConversationMessage.findFirst({
      where: { conversationId: conversation.id, sourceEventId: parsed.data.source_event_id },
    });
    if (existing) return res.json(publicConversation({ ...conversation, messages: [existing] }).messages[0]);
  }
  try {
    const message = await prisma.$transaction(async (tx) => {
      const latest = parsed.data.sequence === undefined
        ? await tx.voiceConversationMessage.findFirst({ where: { conversationId: conversation.id }, orderBy: { sequence: "desc" } })
        : null;
      const created = await tx.voiceConversationMessage.create({
        data: {
          companyId: req.user!.companyId,
          conversationId: conversation.id,
          role: parsed.data.role,
          content: parsed.data.content,
          sequence: parsed.data.sequence ?? (latest?.sequence ?? 0) + 1,
          sourceEventId: parsed.data.source_event_id,
        },
      });
      const stateUpdate = parsed.data.role === "user"
        ? { lastTranscript: parsed.data.content.slice(0, 2000), lastHeardAt: new Date() }
        : { lastResponse: parsed.data.content.slice(0, 4000) };
      await tx.voiceDeviceState.upsert({
        where: { userId: req.user!.id },
        create: {
          companyId: req.user!.companyId,
          userId: req.user!.id,
          status: "listening",
          mode: conversation.mode === "local" ? "wake_word" : conversation.mode,
          listening: true,
          ...stateUpdate,
        },
        update: stateUpdate,
      });
      return created;
    });
    res.status(201).json(publicConversation({ ...conversation, messages: [message] }).messages[0]);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return res.status(409).json({ error: "VOICE_MESSAGE_SEQUENCE_CONFLICT" });
    }
    throw error;
  }
});

voiceStateRouter.post("/voice-conversations/:id/end", async (req, res) => {
  const parsed = endConversationSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "VALIDATION_FAILED", message: parsed.error.message });
  const conversation = await prisma.voiceConversation.updateMany({
    where: { id: req.params.id, userId: req.user!.id, companyId: req.user!.companyId },
    data: { status: parsed.data.status, endedAt: new Date() },
  });
  if (!conversation.count) return res.status(404).json({ error: "VOICE_CONVERSATION_NOT_FOUND" });
  res.status(204).end();
});

voiceStateRouter.get("/voice-state", async (req, res) => {
  const state = await prisma.voiceDeviceState.findUnique({ where: { userId: req.user!.id } });
  res.set("Cache-Control", "no-store");
  res.json(publicState(state));
});

voiceStateRouter.put("/voice-state", async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "VALIDATION_FAILED", message: parsed.error.message });
  const input = parsed.data;
  const existing = await prisma.voiceDeviceState.findUnique({ where: { userId: req.user!.id } });
  const clearControl = input.ack_control && existing?.pendingControl === input.ack_control;
  const update = {
    status: input.status,
    mode: input.mode,
    listening: input.listening,
    heartbeatAt: new Date(),
    ...(input.last_transcript !== undefined ? { lastTranscript: input.last_transcript, lastHeardAt: new Date() } : {}),
    ...(input.last_response !== undefined ? { lastResponse: input.last_response } : {}),
    ...(clearControl ? { pendingControl: null } : {}),
  };
  const state = await prisma.voiceDeviceState.upsert({
    where: { userId: req.user!.id },
    create: { companyId: req.user!.companyId, userId: req.user!.id, ...update },
    update,
  });
  res.json(publicState(state));
});

voiceStateRouter.post("/voice-state/control", async (req, res) => {
  const parsed = controlSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "VALIDATION_FAILED", message: parsed.error.message });
  const now = new Date();
  const [state] = await prisma.$transaction([
    prisma.voiceDeviceState.upsert({
      where: { userId: req.user!.id },
      create: { companyId: req.user!.companyId, userId: req.user!.id, pendingControl: parsed.data.control },
      update: { pendingControl: parsed.data.control },
    }),
    ...(parsed.data.control === "end_conversation"
      ? [prisma.voiceConversation.updateMany({
          where: { userId: req.user!.id, companyId: req.user!.companyId, status: "active" },
          data: { status: "interrupted", endedAt: now },
        })]
      : []),
  ]);
  await recordAudit({
    companyId: req.user!.companyId,
    userId: req.user!.id,
    actionName: "control_voice_device",
    interpretedIntent: parsed.data.control,
    inputPayload: { control: parsed.data.control },
    riskLevel: 0,
    confirmationRequired: false,
    result: "success",
  });
  res.status(202).json(publicState(state));
});

voiceStateRouter.delete("/voice-state/history", async (req, res) => {
  await prisma.$transaction([
    prisma.voiceConversation.deleteMany({ where: { userId: req.user!.id, companyId: req.user!.companyId } }),
    prisma.voicePendingAction.updateMany({
      where: { userId: req.user!.id, companyId: req.user!.companyId, actionType: "send_gmail_message", status: "pending" },
      data: { status: "cancelled", payload: Prisma.DbNull, resolvedAt: new Date() },
    }),
    prisma.voiceDeviceState.updateMany({
      where: { userId: req.user!.id, companyId: req.user!.companyId },
      data: { lastTranscript: null, lastResponse: null, lastUiAction: Prisma.DbNull, lastHeardAt: null, pendingControl: "end_conversation" },
    }),
  ]);
  await recordAudit({
    companyId: req.user!.companyId,
    userId: req.user!.id,
    actionName: "clear_voice_device_history",
    interpretedIntent: "end active voice conversation and clear transcript history",
    inputPayload: {},
    riskLevel: 0,
    confirmationRequired: false,
    result: "success",
  });
  const state = await prisma.voiceDeviceState.findUnique({ where: { userId: req.user!.id } });
  res.json(publicState(state));
});
