import { Router } from "express";
import { asyncRoute } from "../../lib/asyncRoute.js";
import { requireAuth } from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/permissions.js";
import { EXECUTE_TEXT_COMMAND_ACTION } from "../../lib/actionContracts.js";
import { recordAudit } from "../../lib/audit.js";
import {
  CONFIRMATIONS_REQUIRED, deleteAlias, listAliases, recordHeardPhrase, upsertAlias,
} from "../../services/voiceAliasService.js";

/**
 * Voice alias management. Mounted under /command, so:
 *   GET    /command/aliases        list learned and learning aliases
 *   POST   /command/aliases        add one by hand (active immediately)
 *   POST   /command/aliases/learn  record one hearing; 3 identical ones activate
 *   DELETE /command/aliases/:id    remove one
 */
export const voiceAliasRouter = Router();

// Own auth: commandRouter applies requireAuth to itself, not to the /command
// mount, so a second router at the same path would see no authenticated user.
voiceAliasRouter.use(requireAuth);

voiceAliasRouter.get("/aliases", requirePermission(EXECUTE_TEXT_COMMAND_ACTION.requiredPermission), asyncRoute(async (req, res) => {
  const aliases = await listAliases(req.user!);
  res.set("Cache-Control", "no-store");
  return res.json({ aliases, required: CONFIRMATIONS_REQUIRED });
}));

voiceAliasRouter.post("/aliases", requirePermission(EXECUTE_TEXT_COMMAND_ACTION.requiredPermission), asyncRoute(async (req, res) => {
  const created = await upsertAlias(req.user!, req.body);
  if (!created) return res.status(400).json({ error: "VALIDATION_FAILED", message: "heard and means are required and must differ." });
  await recordAudit({
    companyId: req.user!.companyId, userId: req.user!.id,
    actionName: "voice_alias_saved", inputPayload: { term: created.term, aliasFor: created.aliasFor, category: created.category },
    riskLevel: 0, confirmationRequired: false, result: "success",
  });
  return res.status(201).json({ alias: created });
}));

voiceAliasRouter.post("/aliases/learn", requirePermission(EXECUTE_TEXT_COMMAND_ACTION.requiredPermission), asyncRoute(async (req, res) => {
  const outcome = await recordHeardPhrase(req.user!, req.body);
  if (!outcome) return res.status(400).json({ error: "VALIDATION_FAILED", message: "heard and means are required and must differ." });
  if (outcome.status === "active") {
    await recordAudit({
      companyId: req.user!.companyId, userId: req.user!.id,
      actionName: "voice_alias_learned", inputPayload: { term: outcome.heard, aliasFor: outcome.means, category: outcome.category },
      riskLevel: 0, confirmationRequired: false, result: "success",
    });
  }
  return res.json(outcome);
}));

voiceAliasRouter.delete("/aliases/:id", requirePermission(EXECUTE_TEXT_COMMAND_ACTION.requiredPermission), asyncRoute(async (req, res) => {
  const removed = await deleteAlias(req.user!, req.params.id);
  if (!removed) return res.status(404).json({ error: "NOT_FOUND" });
  return res.json({ ok: true });
}));
