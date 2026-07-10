import { Router } from "express";
import { requireAuth } from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/permissions.js";
import { CHANGE_JOB_STATUS_ACTION, CREATE_JOB_ACTION } from "../../lib/actionContracts.js";
import * as jobService from "../../services/jobService.js";

export const jobsRouter = Router();

jobsRouter.use(requireAuth);

jobsRouter.get("/", requirePermission("crm.read"), async (req, res) => {
  const { client_id, status } = req.query;
  res.json(
    await jobService.listJobs(req.user!, {
      clientId: typeof client_id === "string" ? client_id : undefined,
      status: typeof status === "string" ? status : undefined,
    })
  );
});

jobsRouter.get("/:id", requirePermission("crm.read"), async (req, res) => {
  const job = await jobService.getJob(req.user!, req.params.id);
  if (!job) return res.status(404).json({ error: "NOT_FOUND" });
  res.json(job);
});

jobsRouter.post("/", requirePermission(CREATE_JOB_ACTION.requiredPermission), async (req, res) => {
  const result = await jobService.createJob(req.user!, req.body);
  if (!result.ok) {
    return res.status(result.httpStatus).json({ error: result.error, message: result.message, ...result.extra });
  }
  res.status(result.httpStatus).json(result.data);
});

jobsRouter.put("/:id", requirePermission(CHANGE_JOB_STATUS_ACTION.requiredPermission), async (req, res) => {
  const result = await jobService.changeJobStatus(req.user!, req.params.id, req.body);
  if (!result.ok) {
    return res.status(result.httpStatus).json({ error: result.error, message: result.message, ...result.extra });
  }
  res.status(result.httpStatus).json(result.data);
});
