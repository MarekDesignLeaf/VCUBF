import { Router } from "express";
import { requireAuth } from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/permissions.js";
import { CREATE_PLAYBOOK_ACTION, UPDATE_PLAYBOOK_ACTION, RUN_PLAYBOOK_ACTION } from "../../lib/actionContracts.js";
import * as playbookService from "../../services/playbookService.js";

export const playbooksRouter = Router();

playbooksRouter.use(requireAuth);

playbooksRouter.get("/", requirePermission("voice.execute"), async (req, res) => {
  const activeOnly = req.query.active_only === "true";
  res.json(await playbookService.listPlaybooks(req.user!, { activeOnly }));
});

playbooksRouter.get("/:id", requirePermission("voice.execute"), async (req, res) => {
  const playbook = await playbookService.getPlaybook(req.user!, req.params.id);
  if (!playbook) return res.status(404).json({ error: "PLAYBOOK_NOT_FOUND" });
  res.json(playbook);
});

playbooksRouter.get("/:id/runs", requirePermission("voice.execute"), async (req, res) => {
  res.json(await playbookService.listPlaybookRuns(req.user!, req.params.id));
});

playbooksRouter.post("/", requirePermission(CREATE_PLAYBOOK_ACTION.requiredPermission), async (req, res) => {
  const result = await playbookService.createPlaybook(req.user!, req.body);
  if (!result.ok) return res.status(result.httpStatus).json({ error: result.error, message: result.message, ...result.extra });
  res.status(result.httpStatus).json(result.data);
});

playbooksRouter.put("/:id", requirePermission(UPDATE_PLAYBOOK_ACTION.requiredPermission), async (req, res) => {
  const result = await playbookService.updatePlaybook(req.user!, req.params.id, req.body);
  if (!result.ok) return res.status(result.httpStatus).json({ error: result.error, message: result.message, ...result.extra });
  res.status(result.httpStatus).json(result.data);
});

playbooksRouter.post("/:id/run", requirePermission(RUN_PLAYBOOK_ACTION.requiredPermission), async (req, res) => {
  const result = await playbookService.runPlaybook(req.user!, req.params.id, req.body);
  if (!result.ok) return res.status(result.httpStatus).json({ error: result.error, message: result.message, ...result.extra });
  res.status(result.httpStatus).json(result.data);
});
