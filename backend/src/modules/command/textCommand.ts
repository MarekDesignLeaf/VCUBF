import { Router, raw } from "express";
import { z } from "zod";
import { requireAuth, type AuthedUser } from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/permissions.js";
import { recordAudit } from "../../lib/audit.js";
import { EXECUTE_TEXT_COMMAND_ACTION } from "../../lib/actionContracts.js";
import { isGmailCancellationPhrase, isGmailConfirmationPhrase, parseTextCommand } from "../../lib/commandParser.js";
import { dispatchParsedCommand } from "../../lib/commandExecutor.js";
import { resolveLearningAliases } from "../../services/learningService.js";
import { createRealtimeClientSession, interpretVoiceRequest, transcribeVoiceAudio } from "../../services/voiceAssistantService.js";
import { publishVoiceUiAction } from "../../services/voiceUiActionService.js";
import { getAssistantContext } from "../../services/assistantMemoryService.js";
import { hasPendingVoiceGmailMessage } from "../../services/voiceGmailService.js";
import { getNavigationCatalogue } from "../../lib/navigationCatalogue.js";

export const commandRouter = Router();

commandRouter.use(requireAuth);

// Exposes the same authoritative tree used in Emma's prompt. It is read-only
// and includes page descendants that are not represented by a sidebar link.
commandRouter.get("/navigation", requirePermission(EXECUTE_TEXT_COMMAND_ACTION.requiredPermission), (req, res) => {
  const navigation = getNavigationCatalogue(req.user!.permissions);
  res.set("Cache-Control", "no-store");
  return res.json({ title: navigation.title, sections: navigation.sections });
});

const commandSchema = z.object({
  text: z.string().min(1, "text is required"),
  input_method: z.enum(["text", "voice_transcript"]).default("text"),
});

const assistantSchema = commandSchema.extend({
  language: z.string().min(2).max(20).default("en-GB"),
  history: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().min(1).max(800) }))
    .max(6)
    .default([]),
});

const transcriptionQuerySchema = z.object({
  language: z.string().trim().min(2).max(20).default("en-GB"),
  wake_word: z.string().trim().min(1).max(80).default("Emma"),
});

type ParsedTextCommand = ReturnType<typeof parseTextCommand>;

async function resolveUserCommand(user: AuthedUser, text: string): Promise<ParsedTextCommand> {
  const parsed = parseTextCommand(text);
  if (parsed.intent !== "unrecognized") return parsed;
  if (!(await hasPendingVoiceGmailMessage(user))) return parsed;
  if (isGmailConfirmationPhrase(text)) return { intent: "confirm_gmail_message", entities: {} };
  if (isGmailCancellationPhrase(text)) return { intent: "cancel_gmail_message", entities: {} };
  return parsed;
}

function auditText(command: ParsedTextCommand, value: string | null | undefined) {
  return command.intent === "prepare_gmail_message" && value ? "[REDACTED_GMAIL_MESSAGE]" : value;
}

function auditAssistantInput(text: string) {
  // A natural-language email request may be clarified before it becomes a
  // deterministic command. Keep that message content in the conversation
  // transcript (the user's chosen history), but never copy it into the audit.
  return /\b(?:send|write|compose|draft)\s+(?:an?\s+)?(?:e-?mail|mail)\b/i.test(text)
    ? "[REDACTED_GMAIL_MESSAGE]"
    : text;
}

function auditInterpreted(command: ParsedTextCommand, interpreted: unknown) {
  if (command.intent !== "prepare_gmail_message") return interpreted;
  return {
    toCount: command.entities.to.length,
    ccCount: command.entities.cc.length,
    bccCount: command.entities.bcc.length,
    subjectLength: command.entities.subject.length,
    bodyLength: command.entities.body.length,
  };
}

commandRouter.post(
  "/transcribe",
  requirePermission(EXECUTE_TEXT_COMMAND_ACTION.requiredPermission),
  raw({ type: ["audio/wav", "audio/x-wav"], limit: "2mb" }),
  async (req, res) => {
    const query = transcriptionQuerySchema.safeParse(req.query);
    if (!query.success) return res.status(400).json({ error: "VALIDATION_FAILED", message: query.error.message });
    const audio = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const isWave = audio.length >= 44 && audio.subarray(0, 4).toString("ascii") === "RIFF" && audio.subarray(8, 12).toString("ascii") === "WAVE";
    if (!isWave) return res.status(400).json({ error: "INVALID_AUDIO", message: "A valid WAV command recording is required." });
    try {
      const transcription = await transcribeVoiceAudio(audio, query.data.language, query.data.wake_word);
      await recordAudit({
        companyId: req.user!.companyId,
        userId: req.user!.id,
        actionName: "transcribe_voice_command",
        inputPayload: { audioBytes: audio.length, language: query.data.language, model: transcription.model },
        dataAfter: { transcriptCharacters: transcription.text.length },
        riskLevel: 0,
        confirmationRequired: false,
        result: "success",
      });
      res.set("Cache-Control", "no-store");
      return res.json({ text: transcription.text });
    } catch (error) {
      console.error("Voice command transcription failed", error instanceof Error ? error.message : error);
      return res.status(503).json({ error: "TRANSCRIPTION_UNAVAILABLE", message: "Voice transcription is temporarily unavailable." });
    }
  }
);

commandRouter.post("/realtime/session", requirePermission(EXECUTE_TEXT_COMMAND_ACTION.requiredPermission), async (req, res) => {
  try {
    const session = await createRealtimeClientSession();
    await recordAudit({
      companyId: req.user!.companyId,
      userId: req.user!.id,
      actionName: "start_realtime_voice_session",
      inputPayload: { model: session.model },
      riskLevel: 0,
      confirmationRequired: false,
      result: "success",
    });
    res.set("Cache-Control", "no-store");
    return res.json({ client_secret: session.clientSecret, expires_at: session.expiresAt, model: session.model });
  } catch (error) {
    console.error("Realtime session creation failed", error instanceof Error ? error.message : error);
    return res.status(503).json({ error: "REALTIME_UNAVAILABLE", message: "Realtime voice is temporarily unavailable." });
  }
});

commandRouter.post("/assistant", requirePermission(EXECUTE_TEXT_COMMAND_ACTION.requiredPermission), async (req, res) => {
  const parsedBody = assistantSchema.safeParse(req.body);
  if (!parsedBody.success) return res.status(400).json({ error: "VALIDATION_FAILED", message: parsedBody.error.message });
  const { text, input_method, language, history } = parsedBody.data;
  const user = req.user!;
  const alias = await resolveLearningAliases(user, text);
  let command = await resolveUserCommand(user, alias.resolvedText);
  let assistant: Awaited<ReturnType<typeof interpretVoiceRequest>> | undefined;

  if (command.intent === "unrecognized") {
    try {
      const memoryContext = await getAssistantContext(user);
      assistant = await interpretVoiceRequest({ text: alias.resolvedText, userName: user.displayName, language, history, memoryContext });
    } catch (error) {
      console.error("Voice assistant interpretation failed", error instanceof Error ? error.message : error);
      return res.status(503).json({
        ok: false,
        kind: "error",
        error: "ASSISTANT_UNAVAILABLE",
        message: "I cannot reach the language service right now. Please try a direct command.",
      });
    }
    if (assistant.kind !== "command" || !assistant.canonical_command) {
      await recordAudit({
        companyId: user.companyId,
        userId: user.id,
        actionName: "interpret_voice_request",
        interpretedIntent: assistant.kind,
        inputPayload: { text: auditAssistantInput(text), inputMethod: input_method },
        dataAfter: { kind: assistant.kind },
        riskLevel: 0,
        confirmationRequired: false,
        result: "success",
      });
      return res.json({ ok: true, kind: assistant.kind, message: assistant.message });
    }
    command = await resolveUserCommand(user, assistant.canonical_command);
    if (command.intent === "unrecognized") {
      return res.status(422).json({ ok: false, kind: "clarification", error: "UNSUPPORTED_ACTION", message: "I understood the request, but it is not yet a supported action." });
    }
  }

  const response = await dispatchParsedCommand(user, command);
  const uiAction = response.uiAction
    ? await publishVoiceUiAction(user, response.intent, response.uiAction)
    : undefined;
  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: EXECUTE_TEXT_COMMAND_ACTION.actionName,
    interpretedIntent: response.intent,
    inputPayload: {
      text: auditText(command, text),
      inputMethod: input_method,
      resolvedText: auditText(command, alias.resolvedText),
      canonicalCommand: auditText(command, assistant?.canonical_command),
      appliedAliases: alias.appliedRules,
    },
    dataAfter: { interpreted: auditInterpreted(command, response.interpreted), uiAction },
    riskLevel: EXECUTE_TEXT_COMMAND_ACTION.riskLevel,
    confirmationRequired: EXECUTE_TEXT_COMMAND_ACTION.confirmationRequired,
    result: response.ok ? "success" : "error",
    errorMessage: response.ok ? undefined : response.error,
  });
  return res.status(response.httpStatus).json({ ...response, uiAction, kind: "action", assistantMessage: assistant?.message, appliedAliases: alias.appliedRules });
});

// POST /command/text — Voice and Text Command Layer entry point.
// Learning Engine alias resolution -> deterministic parse -> Action Engine
// dispatch (dispatchParsedCommand, shared with the Playbook Engine) ->
// structured response. Every call is audited as execute_text_command in
// addition to whatever underlying Action Contract it dispatches to, and the
// audit records the command input and any learned alias that was applied so
// the interpretation stays traceable. Email message content is redacted from
// audit records; it is held only in the short-lived pending action until
// resolved and in the user-visible conversation transcript.
commandRouter.post("/text", requirePermission(EXECUTE_TEXT_COMMAND_ACTION.requiredPermission), async (req, res) => {
  const parsedBody = commandSchema.safeParse(req.body);
  if (!parsedBody.success) {
    return res.status(400).json({ error: "VALIDATION_FAILED", message: parsedBody.error.message });
  }
  const { text, input_method } = parsedBody.data;
  const user = req.user!;

  const alias = await resolveLearningAliases(user, text);
  const command = await resolveUserCommand(user, alias.resolvedText);

  const response = await dispatchParsedCommand(user, command);
  const uiAction = response.uiAction
    ? await publishVoiceUiAction(user, response.intent, response.uiAction)
    : undefined;

  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: EXECUTE_TEXT_COMMAND_ACTION.actionName,
    interpretedIntent: response.intent,
    inputPayload: {
      text: auditText(command, text),
      inputMethod: input_method,
      resolvedText: auditText(command, alias.resolvedText),
      appliedAliases: alias.appliedRules,
    },
    dataAfter: { interpreted: auditInterpreted(command, response.interpreted), uiAction },
    riskLevel: EXECUTE_TEXT_COMMAND_ACTION.riskLevel,
    confirmationRequired: EXECUTE_TEXT_COMMAND_ACTION.confirmationRequired,
    result: response.ok ? "success" : "error",
    errorMessage: response.ok ? undefined : response.error,
  });

  res.status(response.httpStatus).json({ ...response, uiAction, appliedAliases: alias.appliedRules });
});
