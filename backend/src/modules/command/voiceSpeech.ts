import { Router } from "express";
import { asyncRoute } from "../../lib/asyncRoute.js";
import { z } from "zod";
import { requireAuth } from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/permissions.js";
import { EXECUTE_TEXT_COMMAND_ACTION } from "../../lib/actionContracts.js";
import { prisma } from "../../db.js";
import { speakReply } from "../../services/voiceSpeechService.js";

/**
 * POST /command/speak — audio for one of Emma's replies.
 *
 * Answers 503 when no voice is available so the browser falls back to its own
 * synthesis instead of going quiet.
 */
export const voiceSpeechRouter = Router();

voiceSpeechRouter.use(requireAuth);

const speakSchema = z.object({
  text: z.string().trim().min(1).max(1200),
  language: z.string().trim().max(20).optional(),
});

voiceSpeechRouter.post("/speak", requirePermission(EXECUTE_TEXT_COMMAND_ACTION.requiredPermission), asyncRoute(async (req, res) => {
  const parsed = speakSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "VALIDATION_FAILED" });

  // From the database, not the token: a language change has to apply to the
  // very next reply, not after the next sign-in.
  const row = await prisma.user.findUnique({
    where: { id: req.user!.id },
    select: { voiceLanguage: true, voiceSpeechRate: true },
  });
  const language = parsed.data.language || row?.voiceLanguage || req.user!.voiceLanguage;

  // From the account, not the token: a speed change has to apply to the very
  // next reply rather than after the next sign-in.
  const rate = row?.voiceSpeechRate ?? req.user!.voiceSpeechRate ?? 1;
  const spoken = await speakReply(parsed.data.text, language, rate);
  if (!spoken) return res.status(503).json({ error: "SPEECH_UNAVAILABLE" });

  res.setHeader("Content-Type", spoken.contentType);
  res.setHeader("Cache-Control", "no-store");
  return res.send(spoken.audio);
}));
