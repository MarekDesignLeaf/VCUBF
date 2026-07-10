import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db.js";
import { requireAuth } from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/permissions.js";
import { recordAudit } from "../../lib/audit.js";
import { CONVERT_LEAD_ACTION, CREATE_LEAD_ACTION, LEAD_STATUSES } from "../../lib/actionContracts.js";

export const leadsRouter = Router();

leadsRouter.use(requireAuth);

const createLeadSchema = z.object({
  name: z.string().min(1, "name is required"),
  phone: z.string().optional(),
  email: z.string().email().optional().or(z.literal("")),
  service_requested: z.string().optional(),
  location: z.string().optional(),
  source: z.string().optional(),
  urgency: z.string().optional(),
  notes: z.string().optional(),
});

// GET /crm/leads?status=
leadsRouter.get("/", requirePermission("crm.read"), async (req, res) => {
  const { status } = req.query;
  const leads = await prisma.lead.findMany({
    where: {
      companyId: req.user!.companyId,
      ...(typeof status === "string" ? { leadStatus: status } : {}),
    },
    orderBy: { createdAt: "desc" },
  });
  res.json(leads);
});

// GET /crm/leads/:id
leadsRouter.get("/:id", requirePermission("crm.read"), async (req, res) => {
  const lead = await prisma.lead.findFirst({
    where: { id: req.params.id, companyId: req.user!.companyId },
  });
  if (!lead) return res.status(404).json({ error: "NOT_FOUND" });
  res.json(lead);
});

// POST /crm/leads — Action Contract: create_lead
leadsRouter.post("/", requirePermission(CREATE_LEAD_ACTION.requiredPermission), async (req, res) => {
  const parsed = createLeadSchema.safeParse(req.body);
  if (!parsed.success) {
    await recordAudit({
      companyId: req.user!.companyId,
      userId: req.user!.id,
      actionName: CREATE_LEAD_ACTION.actionName,
      inputPayload: req.body,
      riskLevel: CREATE_LEAD_ACTION.riskLevel,
      confirmationRequired: CREATE_LEAD_ACTION.confirmationRequired,
      result: "error",
      errorMessage: "VALIDATION_FAILED",
    });
    return res.status(400).json({ error: "VALIDATION_FAILED", message: parsed.error.message });
  }
  const data = parsed.data;

  const lead = await prisma.lead.create({
    data: {
      companyId: req.user!.companyId,
      name: data.name,
      phone: data.phone,
      email: data.email || undefined,
      serviceRequested: data.service_requested,
      location: data.location,
      source: data.source ?? "manual",
      urgency: data.urgency,
      notes: data.notes,
      createdBy: req.user!.id,
    },
  });

  await recordAudit({
    companyId: req.user!.companyId,
    userId: req.user!.id,
    actionName: CREATE_LEAD_ACTION.actionName,
    inputPayload: data,
    dataAfter: lead,
    riskLevel: CREATE_LEAD_ACTION.riskLevel,
    confirmationRequired: CREATE_LEAD_ACTION.confirmationRequired,
    result: "success",
  });

  res.status(201).json(lead);
});

// POST /crm/leads/:id/convert — Action Contract: convert_lead_to_client
// Creates (or reuses) a client from the lead's contact details and marks the
// lead as converted. A lead can only be converted once — this is not a
// message-sending action, so it does not require external confirmation, but
// it is fully audited and irreversible via this endpoint (no "unconvert").
leadsRouter.post(
  "/:id/convert",
  requirePermission(CONVERT_LEAD_ACTION.requiredPermission),
  async (req, res) => {
    const lead = await prisma.lead.findFirst({
      where: { id: req.params.id, companyId: req.user!.companyId },
    });
    if (!lead) {
      await recordAudit({
        companyId: req.user!.companyId,
        userId: req.user!.id,
        actionName: CONVERT_LEAD_ACTION.actionName,
        inputPayload: { leadId: req.params.id },
        riskLevel: CONVERT_LEAD_ACTION.riskLevel,
        confirmationRequired: CONVERT_LEAD_ACTION.confirmationRequired,
        result: "error",
        errorMessage: "LEAD_NOT_FOUND",
      });
      return res.status(404).json({ error: "LEAD_NOT_FOUND" });
    }

    if (lead.leadStatus === "converted" && lead.convertedClientId) {
      await recordAudit({
        companyId: req.user!.companyId,
        userId: req.user!.id,
        actionName: CONVERT_LEAD_ACTION.actionName,
        inputPayload: { leadId: lead.id },
        riskLevel: CONVERT_LEAD_ACTION.riskLevel,
        confirmationRequired: CONVERT_LEAD_ACTION.confirmationRequired,
        result: "error",
        errorMessage: "UNSUPPORTED_ACTION",
      });
      return res.status(409).json({
        error: "UNSUPPORTED_ACTION",
        message: "This lead has already been converted.",
        clientId: lead.convertedClientId,
      });
    }

    // Duplicate detection mirrors create_client: don't fork a client that
    // already exists for this email — link the lead to it instead of creating
    // a disconnected duplicate (CRM rule).
    const existingClient = lead.email
      ? await prisma.client.findFirst({ where: { companyId: req.user!.companyId, emailPrimary: lead.email } })
      : null;

    const client =
      existingClient ??
      (await prisma.client.create({
        data: {
          companyId: req.user!.companyId,
          displayName: lead.name,
          emailPrimary: lead.email ?? undefined,
          phonePrimary: lead.phone ?? undefined,
          source: `lead:${lead.id}`,
          createdBy: req.user!.id,
        },
      }));

    const updatedLead = await prisma.lead.update({
      where: { id: lead.id },
      data: { leadStatus: "converted", convertedClientId: client.id },
    });

    await recordAudit({
      companyId: req.user!.companyId,
      userId: req.user!.id,
      actionName: CONVERT_LEAD_ACTION.actionName,
      inputPayload: { leadId: lead.id },
      dataAfter: { lead: updatedLead, client },
      riskLevel: CONVERT_LEAD_ACTION.riskLevel,
      confirmationRequired: CONVERT_LEAD_ACTION.confirmationRequired,
      result: "success",
    });

    res.json({ lead: updatedLead, client });
  }
);

export { LEAD_STATUSES };
