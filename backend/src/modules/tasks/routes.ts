import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/permissions.js";
import { CREATE_TASK_ACTION, UPDATE_TASK_ACTION } from "../../lib/actionContracts.js";
import * as taskService from "../../services/taskService.js";

export const tasksRouter = Router();

tasksRouter.use(requireAuth);

const listQuerySchema = z.object({
  status: z.string().optional(),
  priority: z.string().optional(),
  assigned_user_id: z.string().uuid().optional(),
  client_id: z.string().uuid().optional(),
  job_id: z.string().uuid().optional(),
  due_from: z.string().datetime().optional(),
  due_to: z.string().datetime().optional(),
  overdue: z.enum(["true", "false"]).optional(),
});

tasksRouter.get("/", requirePermission("crm.read"), async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "VALIDATION_FAILED", message: parsed.error.message });
  }
  res.json(
    await taskService.listTasks(req.user!, {
      status: parsed.data.status,
      priority: parsed.data.priority,
      assignedUserId: parsed.data.assigned_user_id,
      clientId: parsed.data.client_id,
      jobId: parsed.data.job_id,
      dueFrom: parsed.data.due_from ? new Date(parsed.data.due_from) : undefined,
      dueTo: parsed.data.due_to ? new Date(parsed.data.due_to) : undefined,
      overdue: parsed.data.overdue === "true" ? true : undefined,
    })
  );
});

tasksRouter.get("/:id", requirePermission("crm.read"), async (req, res) => {
  const task = await taskService.getTask(req.user!, req.params.id);
  if (!task) return res.status(404).json({ error: "TASK_NOT_FOUND" });
  res.json(task);
});

tasksRouter.post("/", requirePermission(CREATE_TASK_ACTION.requiredPermission), async (req, res) => {
  const result = await taskService.createTask(req.user!, req.body);
  if (!result.ok) {
    return res.status(result.httpStatus).json({ error: result.error, message: result.message, ...result.extra });
  }
  res.status(result.httpStatus).json(result.data);
});

tasksRouter.put("/:id", requirePermission(UPDATE_TASK_ACTION.requiredPermission), async (req, res) => {
  const result = await taskService.updateTask(req.user!, req.params.id, req.body);
  if (!result.ok) {
    return res.status(result.httpStatus).json({ error: result.error, message: result.message, ...result.extra });
  }
  res.status(result.httpStatus).json(result.data);
});
