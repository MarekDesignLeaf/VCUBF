import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/permissions.js";
import { recordAudit } from "../../lib/audit.js";
import { EXECUTE_TEXT_COMMAND_ACTION } from "../../lib/actionContracts.js";
import { parseTextCommand } from "../../lib/commandParser.js";
import { dispatchParsedCommand } from "../../lib/commandExecutor.js";
import { resolveLearningAliases } from "../../services/learningService.js";

export const commandRouter = Router();

commandRouter.use(requireAuth);

const commandSchema = z.object({ text: z.string().min(1, "text is required") });

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
  const { text } = parsedBody.data;
  const user = req.user!;

  const alias = await resolveLearningAliases(user, text);
  const command = parseTextCommand(alias.resolvedText);

  const response = await dispatchParsedCommand(user, command);

  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: EXECUTE_TEXT_COMMAND_ACTION.actionName,
    interpretedIntent: response.intent,
    inputPayload: { text, resolvedText: alias.resolvedText, appliedAliases: alias.appliedRules },
    dataAfter: { interpreted: response.interpreted },
    riskLevel: EXECUTE_TEXT_COMMAND_ACTION.riskLevel,
    confirmationRequired: EXECUTE_TEXT_COMMAND_ACTION.confirmationRequired,
    result: response.ok ? "success" : "error",
    errorMessage: response.ok ? undefined : response.error,
  });

  res.status(response.httpStatus).json({ ...response, appliedAliases: alias.appliedRules });
});
