import { Router } from "express";
import { requireAuth } from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/permissions.js";
import { CREATE_QUOTE_ACTION, UPDATE_QUOTE_ACTION, CHANGE_QUOTE_STATUS_ACTION, EXPORT_QUOTE_PDF_ACTION } from "../../lib/actionContracts.js";
import * as quoteService from "../../services/quoteService.js";
import { exportQuotePdf } from "../../services/quotePdfService.js";

export const quotesRouter = Router();

quotesRouter.use(requireAuth);

quotesRouter.get("/", requirePermission("crm.read"), async (req, res) => {
  const { client_id, job_id, status } = req.query;
  const data = await quoteService.listQuotes(req.user!, {
    clientId: typeof client_id === "string" ? client_id : undefined,
    jobId: typeof job_id === "string" ? job_id : undefined,
    status: typeof status === "string" ? status : undefined,
  });
  res.json(data);
});

quotesRouter.get("/:id", requirePermission("crm.read"), async (req, res) => {
  const quote = await quoteService.getQuote(req.user!, req.params.id);
  if (!quote) return res.status(404).json({ error: "QUOTE_NOT_FOUND" });
  res.json(quote);
});

quotesRouter.get("/:id/pdf", requirePermission(EXPORT_QUOTE_PDF_ACTION.requiredPermission), async (req, res) => {
  const pdf = await exportQuotePdf(req.user!, req.params.id);
  if (!pdf) return res.status(404).json({ error: "QUOTE_NOT_FOUND" });
  res.set({
    "Content-Type": "application/pdf",
    "Content-Disposition": `attachment; filename="quote-${req.params.id}.pdf"`,
    "Content-Length": String(pdf.length),
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.send(pdf);
});

quotesRouter.post("/", requirePermission(CREATE_QUOTE_ACTION.requiredPermission), async (req, res) => {
  const result = await quoteService.createQuote(req.user!, req.body);
  if (!result.ok) {
    return res.status(result.httpStatus).json({ error: result.error, message: result.message, ...result.extra });
  }
  res.status(result.httpStatus).json(result.data);
});

quotesRouter.put("/:id", requirePermission(UPDATE_QUOTE_ACTION.requiredPermission), async (req, res) => {
  const result = await quoteService.updateQuote(req.user!, req.params.id, req.body);
  if (!result.ok) {
    return res.status(result.httpStatus).json({ error: result.error, message: result.message, ...result.extra });
  }
  res.status(result.httpStatus).json(result.data);
});

quotesRouter.put("/:id/status", requirePermission(CHANGE_QUOTE_STATUS_ACTION.requiredPermission), async (req, res) => {
  const result = await quoteService.changeQuoteStatus(req.user!, req.params.id, req.body);
  if (!result.ok) {
    return res.status(result.httpStatus).json({ error: result.error, message: result.message, ...result.extra });
  }
  res.status(result.httpStatus).json(result.data);
});
