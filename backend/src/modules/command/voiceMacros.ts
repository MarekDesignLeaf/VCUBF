import { Router } from "express";
import { asyncRoute } from "../../lib/asyncRoute.js";
import { requireAuth } from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/permissions.js";
import { EXECUTE_TEXT_COMMAND_ACTION } from "../../lib/actionContracts.js";
import { recordAudit } from "../../lib/audit.js";
import {
  deleteMacro,
  findMacroForPhrase,
  listMacros,
  markMacroRun,
  saveMacro,
} from "../../services/voiceMacroService.js";

/**
 * Commands the user taught by performing them.
 *
 *   GET    /command/macros            what has been taught
 *   POST   /command/macros            save a recording under one or two names
 *   GET    /command/macros/match      the command a spoken phrase refers to
 *   POST   /command/macros/:id/ran    note that it was replayed
 *   DELETE /command/macros/:id        forget it
 */
export const voiceMacroRouter = Router();

// Own auth: commandRouter applies requireAuth to itself, not to the /command
// mount, so a second router at the same path would see no authenticated user.
voiceMacroRouter.use(requireAuth);

const permission = requirePermission(EXECUTE_TEXT_COMMAND_ACTION.requiredPermission);

voiceMacroRouter.get("/macros", permission, asyncRoute(async (req, res) => {
  res.set("Cache-Control", "no-store");
  return res.json({ macros: await listMacros(req.user!) });
}));

voiceMacroRouter.post("/macros", permission, asyncRoute(async (req, res) => {
  const outcome = await saveMacro(req.user!, req.body);
  if (!outcome) {
    return res.status(400).json({
      error: "VALIDATION_FAILED",
      message: "A recording needs at least one step and at least one name.",
    });
  }

  await recordAudit({
    companyId: req.user!.companyId,
    userId: req.user!.id,
    actionName: "voice_macro_saved",
    inputPayload: {
      macroId: outcome.macroId,
      alreadyKnown: outcome.alreadyKnown,
      addedNames: outcome.addedNames,
    },
    riskLevel: 0,
    confirmationRequired: false,
    result: "success",
  });

  // 200 rather than 201 when it already existed: nothing new was created, the
  // names were attached to what was there.
  return res.status(outcome.alreadyKnown ? 200 : 201).json(outcome);
}));

voiceMacroRouter.get("/macros/match", permission, asyncRoute(async (req, res) => {
  const phrase = typeof req.query.phrase === "string" ? req.query.phrase : "";
  if (!phrase.trim()) return res.status(400).json({ error: "VALIDATION_FAILED" });
  const match = await findMacroForPhrase(req.user!, phrase);
  res.set("Cache-Control", "no-store");
  return res.json({ macro: match });
}));

voiceMacroRouter.post("/macros/:id/ran", permission, asyncRoute(async (req, res) => {
  await markMacroRun(req.user!, req.params.id);
  return res.json({ ok: true });
}));

voiceMacroRouter.delete("/macros/:id", permission, asyncRoute(async (req, res) => {
  const removed = await deleteMacro(req.user!, req.params.id);
  if (!removed) return res.status(404).json({ error: "NOT_FOUND" });
  await recordAudit({
    companyId: req.user!.companyId,
    userId: req.user!.id,
    actionName: "voice_macro_deleted",
    inputPayload: { macroId: req.params.id },
    riskLevel: 0,
    confirmationRequired: false,
    result: "success",
  });
  return res.json({ ok: true });
}));
