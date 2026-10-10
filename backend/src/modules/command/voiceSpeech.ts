import { Router } from "express";
import { asyncRoute } from "../../lib/asyncRoute.js";
import { z } from "zod";
import { requireAuth } from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/permissions.js";
import { EXECUTE_TEXT_COMMAND_ACTION } from "../../lib/actionContracts.js";
import { prisma } from "../../db.js";
import { MAX_SPOKEN_REPLY, speakReply, streamReply } from "../../services/voiceSpeechService.js";

/**
 * POST /command/speak — audio for one of {assistant}'s replies.
 *
 * Answers 503 when no voice is available so the browser falls back to its own
 * synthesis instead of going quiet.
 *
 * With `format: "pcm"` the audio is raw 24 kHz samples streamed as OpenAI makes
 * them, so the page can start playing before the sentence is finished. If the
 * voice fails after audio has started, the response is broken off rather than
 * ended, so the page knows the reply was cut short and says the rest itself.
 * Without it (every older caller) the whole MP3 comes in one piece, as before.
 */
export const voiceSpeechRouter = Router();

voiceSpeechRouter.use(requireAuth);

const speakSchema = z.object({
  text: z.string().trim().min(1).max(MAX_SPOKEN_REPLY),
  language: z.string().trim().max(20).optional(),
  format: z.enum(["mp3", "pcm"]).optional(),
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

  if (parsed.data.format === "pcm") {
    // A page that stops listening (the reply was cut off) stops the synthesis too.
    const gone = new AbortController();
    res.on("close", () => { if (!res.writableFinished) gone.abort(); });
    try {
      const streamed = await streamReply(parsed.data.text, rate, {
        start(contentType) {
          res.setHeader("Content-Type", contentType);
          res.setHeader("Cache-Control", "no-store");
          res.status(200);
          res.flushHeaders();
        },
        write(chunk) { res.write(chunk); },
      }, gone.signal);
      if (!streamed) return res.status(503).json({ error: "SPEECH_UNAVAILABLE" });
      return res.end();
    } catch {
      if (!res.headersSent) return res.status(503).json({ error: "SPEECH_UNAVAILABLE" });
      res.destroy();
      return;
    }
  }

  const spoken = await speakReply(parsed.data.text, language, rate);
  if (!spoken) return res.status(503).json({ error: "SPEECH_UNAVAILABLE" });

  res.setHeader("Content-Type", spoken.contentType);
  res.setHeader("Cache-Control", "no-store");
  return res.send(spoken.audio);
}));
