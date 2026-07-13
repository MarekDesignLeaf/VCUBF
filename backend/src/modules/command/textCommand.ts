import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/permissions.js";
import { recordAudit } from "../../lib/audit.js";
import { EXECUTE_TEXT_COMMAND_ACTION } from "../../lib/actionContracts.js";
import { parseTextCommand } from "../../lib/commandParser.js";
import { dispatchParsedCommand } from "../../lib/commandExecutor.js";
import { resolveLearningAliases } from "../../services/learningService.js";
import { interpretVoiceRequest } from "../../services/voiceAssistantService.js";

export const commandRouter = Router();

commandRouter.use(requireAuth);

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

commandRouter.post("/assistant", requirePermission(EXECUTE_TEXT_COMMAND_ACTION.requiredPermission), async (req, res) => {
  const parsedBody = assistantSchema.safeParse(req.body);
  if (!parsedBody.success) return res.status(400).json({ error: "VALIDATION_FAILED", message: parsedBody.error.message });
  const { text, input_method, language, history } = parsedBody.data;
  const user = req.user!;
  const alias = await resolveLearningAliases(user, text);
  let command = parseTextCommand(alias.resolvedText);
  let assistant: Awaited<ReturnType<typeof interpretVoiceRequest>> | undefined;

  if (command.intent === "unrecognized") {
    try {
      assistant = await interpretVoiceRequest({ text: alias.resolvedText, userName: user.displayName, language, history });
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
        inputPayload: { text, inputMethod: input_method },
        dataAfter: { kind: assistant.kind },
        riskLevel: 0,
        confirmationRequired: false,
        result: "success",
      });
      return res.json({ ok: true, kind: assistant.kind, message: assistant.message });
    }
    command = parseTextCommand(assistant.canonical_command);
    if (command.intent === "unrecognized") {
      return res.status(422).json({ ok: false, kind: "clarification", error: "UNSUPPORTED_ACTION", message: "I understood the request, but it is not yet a supported action." });
    }
  }

  const response = await dispatchParsedCommand(user, command);
  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: EXECUTE_TEXT_COMMAND_ACTION.actionName,
    interpretedIntent: response.intent,
    inputPayload: { text, inputMethod: input_method, resolvedText: alias.resolvedText, canonicalCommand: assistant?.canonical_command, appliedAliases: alias.appliedRules },
    dataAfter: { interpreted: response.interpreted },
    riskLevel: EXECUTE_TEXT_COMMAND_ACTION.riskLevel,
    confirmationRequired: EXECUTE_TEXT_COMMAND_ACTION.confirmationRequired,
    result: response.ok ? "success" : "error",
    errorMessage: response.ok ? undefined : response.error,
  });
  return res.status(response.httpStatus).json({ ...response, kind: "action", assistantMessage: assistant?.message, appliedAliases: alias.appliedRules });
});

// POST /command/text — Voice and Text Command Layer entry point.
// Learning Engine alias resolution -> deterministic parse -> Action Engine
// dispatch (dispatchParsedCommand, shared with the Playbook Engine) ->
// structured response. Every call is audited as execute_text_command in
// addition to whatever underlying Action Contract it dispatches to, and the
// audit records both the raw text and any learned alias that was applied so
// the interpretation stays fully traceable.
commandRouter.post("/text", requirePermission(EXECUTE_TEXT_COMMAND_ACTION.requiredPermission), async (req, res) => {
  const parsedBody = commandSchema.safeParse(req.body);
  if (!parsedBody.success) {
    return res.status(400).json({ error: "VALIDATION_FAILED", message: parsedBody.error.message });
  }
  const { text, input_method } = parsedBody.data;
  const user = req.user!;

  const alias = await resolveLearningAliases(user, text);
  const command = parseTextCommand(alias.resolvedText);

  const response = await dispatchParsedCommand(user, command);

  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: EXECUTE_TEXT_COMMAND_ACTION.actionName,
    interpretedIntent: response.intent,
    inputPayload: {
      text,
      inputMethod: input_method,
      resolvedText: alias.resolvedText,
      appliedAliases: alias.appliedRules,
    },
    dataAfter: { interpreted: response.interpreted },
    riskLevel: EXECUTE_TEXT_COMMAND_ACTION.riskLevel,
    confirmationRequired: EXECUTE_TEXT_COMMAND_ACTION.confirmationRequired,
    result: response.ok ? "success" : "error",
    errorMessage: response.ok ? undefined : response.error,
  });

  res.status(response.httpStatus).json({ ...response, appliedAliases: alias.appliedRules });
});
