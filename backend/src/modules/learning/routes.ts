import { Router } from "express";
import { requireAuth } from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/permissions.js";
import { CREATE_LEARNING_RULE_ACTION, UPDATE_LEARNING_RULE_ACTION } from "../../lib/actionContracts.js";
import * as learningService from "../../services/learningService.js";

export const learningRouter = Router();

learningRouter.use(requireAuth);

learningRouter.get("/", requirePermission("voice.execute"), async (req, res) => {
  const { status } = req.query;
  res.json(await learningService.listLearningRules(req.user!, { status: typeof status === "string" ? status : undefined }));
});

learningRouter.get("/:id", requirePermission("voice.execute"), async (req, res) => {
  const rule = await learningService.getLearningRule(req.user!, req.params.id);
  if (!rule) return res.status(404).json({ error: "LEARNING_RULE_NOT_FOUND" });
  res.json(rule);
});

learningRouter.post("/", requirePermission(CREATE_LEARNING_RULE_ACTION.requiredPermission), async (req, res) => {
  const result = await learningService.createLearningRule(req.user!, req.body);
  if (!result.ok) return res.status(result.httpStatus).json({ error: result.error, message: result.message, ...result.extra });
  res.status(result.httpStatus).json(result.data);
});

learningRouter.put("/:id", requirePermission(UPDATE_LEARNING_RULE_ACTION.requiredPermission), async (req, res) => {
  const result = await learningService.updateLearningRule(req.user!, req.params.id, req.body);
  if (!result.ok) return res.status(result.httpStatus).json({ error: result.error, message: result.message, ...result.extra });
  res.status(result.httpStatus).json(result.data);
});
