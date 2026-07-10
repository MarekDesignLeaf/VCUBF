import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db.js";
import { requireAuth } from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/permissions.js";
import { recordAudit } from "../../lib/audit.js";
import { CREATE_CLIENT_ACTION } from "../../lib/actionContracts.js";

export const clientsRouter = Router();

clientsRouter.use(requireAuth);

const createClientSchema = z.object({
  display_name: z.string().min(1, "display_name is required"),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  company_name: z.string().optional(),
  email_primary: z.string().email().optional().or(z.literal("")),
  phone_primary: z.string().optional(),
  client_type: z.string().optional(),
  billing_address_line1: z.string().optional(),
  billing_city: z.string().optional(),
  billing_postcode: z.string().optional(),
  notes: z.string().optional(),
  source: z.string().optional(),
});

// GET /crm/clients
clientsRouter.get("/", requirePermission("crm.read"), async (req, res) => {
  const clients = await prisma.client.findMany({
    where: { companyId: req.user!.companyId },
    orderBy: { createdAt: "desc" },
  });
  res.json(clients);
});

// GET /crm/clients/search?q=
clientsRouter.get("/search", requirePermission("crm.read"), async (req, res) => {
  const q = String(req.query.q ?? "").trim();
  if (!q) return res.json([]);
  const clients = await prisma.client.findMany({
    where: {
      companyId: req.user!.companyId,
      OR: [
        { displayName: { contains: q, mode: "insensitive" } },
        { emailPrimary: { contains: q, mode: "insensitive" } },
        { phonePrimary: { contains: q, mode: "insensitive" } },
        { companyName: { contains: q, mode: "insensitive" } },
      ],
    },
  });
  res.json(clients);
});

// GET /crm/clients/:id
clientsRouter.get("/:id", requirePermission("crm.read"), async (req, res) => {
  const client = await prisma.client.findFirst({
    where: { id: req.params.id, companyId: req.user!.companyId },
  });
  if (!client) return res.status(404).json({ error: "NOT_FOUND" });
  res.json(client);
});

// POST /crm/clients — Action Contract: create_client
clientsRouter.post("/", requirePermission(CREATE_CLIENT_ACTION.requiredPermission), async (req, res) => {
  const parsed = createClientSchema.safeParse(req.body);
  if (!parsed.success) {
    await recordAudit({
      companyId: req.user!.companyId,
      userId: req.user!.id,
      actionName: CREATE_CLIENT_ACTION.actionName,
      inputPayload: req.body,
      riskLevel: CREATE_CLIENT_ACTION.riskLevel,
      confirmationRequired: CREATE_CLIENT_ACTION.confirmationRequired,
      result: "error",
      errorMessage: "VALIDATION_FAILED",
    });
    return res.status(400).json({ error: "VALIDATION_FAILED", message: parsed.error.message });
  }
  const data = parsed.data;

  // Duplicate detection — CRM rule: a client must not exist as disconnected
  // fragments. Match on email or (name + phone).
  const duplicate = await prisma.client.findFirst({
    where: {
      companyId: req.user!.companyId,
      OR: [
        data.email_primary ? { emailPrimary: data.email_primary } : undefined,
        data.phone_primary
          ? { phonePrimary: data.phone_primary, displayName: data.display_name }
          : undefined,
      ].filter(Boolean) as never,
    },
  });

  if (duplicate) {
    await recordAudit({
      companyId: req.user!.companyId,
      userId: req.user!.id,
      actionName: CREATE_CLIENT_ACTION.actionName,
      inputPayload: data,
      riskLevel: CREATE_CLIENT_ACTION.riskLevel,
      confirmationRequired: true,
      result: "rejected",
      errorMessage: "DUPLICATE_CLIENT_POSSIBLE",
    });
    return res.status(409).json({
      error: "DUPLICATE_CLIENT_POSSIBLE",
      message: "A client with this email or name+phone already exists.",
      existingClientId: duplicate.id,
    });
  }

  const client = await prisma.client.create({
    data: {
      companyId: req.user!.companyId,
      displayName: data.display_name,
      firstName: data.first_name,
      lastName: data.last_name,
      companyName: data.company_name,
      emailPrimary: data.email_primary || undefined,
      phonePrimary: data.phone_primary,
      clientType: data.client_type,
      billingLine1: data.billing_address_line1,
      billingCity: data.billing_city,
      billingPostcode: data.billing_postcode,
      notes: data.notes,
      source: data.source ?? "manual",
      createdBy: req.user!.id,
    },
  });

  await recordAudit({
    companyId: req.user!.companyId,
    userId: req.user!.id,
    actionName: CREATE_CLIENT_ACTION.actionName,
    inputPayload: data,
    dataAfter: client,
    riskLevel: CREATE_CLIENT_ACTION.riskLevel,
    confirmationRequired: CREATE_CLIENT_ACTION.confirmationRequired,
    result: "success",
  });

  res.status(201).json(client);
});
