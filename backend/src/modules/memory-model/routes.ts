import { Router } from "express";
import { requireAuth } from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/permissions.js";
import { DETECT_ACTION_PATTERNS_ACTION } from "../../lib/actionContracts.js";
import * as memoryModelService from "../../services/memoryModelService.js";
import * as assistantMemoryService from "../../services/assistantMemoryService.js";

// Memory Model — read-only pattern-detection view. See
// memoryModelService.ts: this never creates a Playbook or any other record,
// it only surfaces candidate repeated-action patterns from the company's
// own AuditLog for a human to review.
export const memoryModelRouter = Router();

memoryModelRouter.use(requireAuth);

memoryModelRouter.get(
  "/patterns",
  requirePermission(DETECT_ACTION_PATTERNS_ACTION.requiredPermission),
  async (req, res) => {
    res.json(await memoryModelService.detectRepeatedActionPatterns(req.user!));
  }
);

memoryModelRouter.get("/memories", requirePermission("voice.execute"), async (req, res) => {
  const parsed = assistantMemoryService.listAssistantMemoriesSchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "VALIDATION_FAILED", message: parsed.error.message });
  res.set("Cache-Control", "no-store");
  res.json(await assistantMemoryService.listAssistantMemories(req.user!, parsed.data));
});

memoryModelRouter.post("/memories", requirePermission("voice.execute"), async (req, res) => {
  const result = await assistantMemoryService.createAssistantMemory(req.user!, req.body);
  res.status(result.httpStatus).json(result.ok ? result.data : { error: result.error, message: result.message });
});

memoryModelRouter.post("/memories/:id/archive", requirePermission("voice.execute"), async (req, res) => {
  const result = await assistantMemoryService.archiveAssistantMemory(req.user!, req.params.id);
  res.status(result.httpStatus).json(result.ok ? result.data : { error: result.error, message: result.message });
});
