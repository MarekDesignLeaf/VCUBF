import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db.js";
import { requireAuth } from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/permissions.js";
import { recordAudit } from "../../lib/audit.js";

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

function publicState(state: any) {
  if (!state) return { status: "offline", mode: "wake_word", listening: false, lastTranscript: null, lastResponse: null, lastHeardAt: null, pendingControl: null, heartbeatAt: null };
  const stale = Date.now() - new Date(state.heartbeatAt).getTime() > 15_000;
  return {
    status: stale ? "offline" : state.status,
    mode: state.mode,
    listening: stale ? false : state.listening,
    lastTranscript: state.lastTranscript,
    lastResponse: state.lastResponse,
    lastHeardAt: state.lastHeardAt,
    pendingControl: state.pendingControl,
    heartbeatAt: state.heartbeatAt,
  };
}

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
  const state = await prisma.voiceDeviceState.upsert({
    where: { userId: req.user!.id },
    create: { companyId: req.user!.companyId, userId: req.user!.id, pendingControl: parsed.data.control },
    update: { pendingControl: parsed.data.control },
  });
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
  await prisma.voiceDeviceState.updateMany({
    where: { userId: req.user!.id, companyId: req.user!.companyId },
    data: { lastTranscript: null, lastResponse: null, lastHeardAt: null },
  });
  await recordAudit({
    companyId: req.user!.companyId,
    userId: req.user!.id,
    actionName: "clear_voice_device_history",
    interpretedIntent: "clear final voice transcript and response",
    inputPayload: {},
    riskLevel: 0,
    confirmationRequired: false,
    result: "success",
  });
  const state = await prisma.voiceDeviceState.findUnique({ where: { userId: req.user!.id } });
  res.json(publicState(state));
});
