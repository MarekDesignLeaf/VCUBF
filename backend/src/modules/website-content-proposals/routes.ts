import { Router } from "express";
import { requireAuth } from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/permissions.js";
import {
  DECIDE_WEBSITE_CONTENT_PROPOSAL_ACTION,
  PREPARE_WEBSITE_CONTENT_PROPOSAL_ACTION,
} from "../../lib/actionContracts.js";
import * as proposalService from "../../services/websiteContentProposalService.js";

export const websiteContentProposalsRouter = Router();

websiteContentProposalsRouter.use(requireAuth);

websiteContentProposalsRouter.get("/", requirePermission("crm.read"), async (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  res.json(await proposalService.listWebsiteContentProposals(req.user!, status));
});

websiteContentProposalsRouter.get("/:id", requirePermission("crm.read"), async (req, res) => {
  const proposal = await proposalService.getWebsiteContentProposal(req.user!, req.params.id);
  if (!proposal) return res.status(404).json({ error: "WEBSITE_CONTENT_PROPOSAL_NOT_FOUND" });
  res.json(proposal);
});

websiteContentProposalsRouter.post(
  "/",
  requirePermission(PREPARE_WEBSITE_CONTENT_PROPOSAL_ACTION.requiredPermission),
  async (req, res) => {
    const result = await proposalService.createWebsiteContentProposal(req.user!, req.body);
    if (!result.ok) {
      return res
        .status(result.httpStatus)
        .json({ error: result.error, message: result.message, ...result.extra });
    }
    res.status(result.httpStatus).json(result.data);
  }
);

websiteContentProposalsRouter.post(
  "/:id/decision",
  requirePermission(DECIDE_WEBSITE_CONTENT_PROPOSAL_ACTION.requiredPermission),
  async (req, res) => {
    const result = await proposalService.decideWebsiteContentProposal(req.user!, req.params.id, req.body);
    if (!result.ok) {
      return res
        .status(result.httpStatus)
        .json({ error: result.error, message: result.message, ...result.extra });
    }
    res.status(result.httpStatus).json(result.data);
  }
);
