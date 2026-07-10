import { Router } from "express";
import { requireAuth } from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/permissions.js";
import {
  LOG_PORTFOLIO_PHOTO_ACTION,
  UPDATE_PORTFOLIO_PHOTO_ACTION,
} from "../../lib/actionContracts.js";
import * as portfolioService from "../../services/portfolioService.js";

export const portfolioRouter = Router();

portfolioRouter.use(requireAuth);

portfolioRouter.get("/", requirePermission("crm.read"), async (req, res) => {
  const { client_id, job_id, tag, usable_for_marketing, source } = req.query;
  res.json(
    await portfolioService.listPortfolioPhotos(req.user!, {
      clientId: typeof client_id === "string" ? client_id : undefined,
      jobId: typeof job_id === "string" ? job_id : undefined,
      tag: typeof tag === "string" ? tag : undefined,
      usableForMarketing:
        usable_for_marketing === "true" ? true : usable_for_marketing === "false" ? false : undefined,
      source: typeof source === "string" ? source : undefined,
    })
  );
});

portfolioRouter.get("/:id", requirePermission("crm.read"), async (req, res) => {
  const record = await portfolioService.getPortfolioPhoto(req.user!, req.params.id);
  if (!record) return res.status(404).json({ error: "PORTFOLIO_PHOTO_NOT_FOUND" });
  res.json(record);
});

portfolioRouter.post(
  "/",
  requirePermission(LOG_PORTFOLIO_PHOTO_ACTION.requiredPermission),
  async (req, res) => {
    const result = await portfolioService.createPortfolioPhoto(req.user!, req.body);
    if (!result.ok) return res.status(result.httpStatus).json({ error: result.error, message: result.message, ...result.extra });
    res.status(result.httpStatus).json(result.data);
  }
);

portfolioRouter.put(
  "/:id",
  requirePermission(UPDATE_PORTFOLIO_PHOTO_ACTION.requiredPermission),
  async (req, res) => {
    const result = await portfolioService.updatePortfolioPhoto(req.user!, req.params.id, req.body);
    if (!result.ok) return res.status(result.httpStatus).json({ error: result.error, message: result.message, ...result.extra });
    res.status(result.httpStatus).json(result.data);
  }
);
