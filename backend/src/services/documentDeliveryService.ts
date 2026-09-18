import { z } from "zod";
import { prisma } from "../db.js";
import { recordAudit } from "../lib/audit.js";
import { SEND_INVOICE_PDF_ACTION, SEND_QUOTE_PDF_ACTION, type ActionContract } from "../lib/actionContracts.js";
import type { AuthedUser } from "../middleware/auth.js";
import { resolveSendableGmailSource, sendThroughGmailSource } from "./gmailConnectorService.js";
import { exportInvoicePdf } from "./invoicePdfService.js";
import { loadQuotePdfData, renderQuotePdf } from "./quotePdfService.js";
import { fail, ok, type ServiceResult } from "./result.js";

// Document delivery — sends the client-facing PDF of a quote or invoice
// through the company's already authorised Gmail connector. It closes the gap
// where quote "sent" and invoice "issued" were internal records only.
//
// Rules:
//  - Always a 409 preview first: exact recipients, subject, body, attachment
//    name/size and what will change in CRM. Only confirmed: true sends.
//  - The PDF is rendered from saved data at send time by the same exporters
//    the Download PDF buttons use; nothing is composed by a model.
//  - Recipient defaults to the client's stored primary email and is never
//    guessed; with no stored email the caller must type one.
//  - After a real provider acknowledgement: a draft quote becomes "sent"
//    (recording actual delivery, not intent); an issued invoice keeps its
//    status; both write an outbound CommunicationRecord so the delivery is in
//    the client's communication history and can carry a follow-up.
//  - Audit stores counts, lengths, filename and provider ids — not the body.

const emailAddress = z.string().trim().email().max(254);

export const sendDocumentSchema = z.object({
  source_id: z.string().min(1).optional(),
  to: z.array(emailAddress).min(1).max(10).optional(),
  cc: z.array(emailAddress).max(10).optional(),
  subject: z.string().trim().min(1).max(200).optional(),
  body: z.string().trim().min(1).max(10_000).optional(),
  follow_up_due_at: z.string().datetime().optional(),
  confirmed: z.boolean().optional(),
}).strict();

type SendDocumentInput = z.infer<typeof sendDocumentSchema>;

interface DocumentToSend {
  kind: "quote" | "invoice";
  id: string;
  reference: string;
  clientId: string;
  clientLabel: string;
  clientEmail: string | null;
  jobId: string | null;
  companyName: string;
  statusBefore: string;
  statusAfter: string;
  filename: string;
  render: () => Promise<Buffer>;
}

function money(value: number) {
  return new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(value);
}

async function loadQuoteToSend(user: AuthedUser, quoteId: string): Promise<DocumentToSend | null> {
  const quote = await loadQuotePdfData(user, quoteId);
  if (!quote) return null;
  return {
    kind: "quote",
    id: quote.id,
    reference: quote.title,
    clientId: quote.clientId,
    clientLabel: quote.client.displayName,
    clientEmail: quote.client.emailPrimary,
    jobId: quote.jobId,
    companyName: quote.company.name,
    statusBefore: quote.quoteStatus,
    statusAfter: quote.quoteStatus === "draft" ? "sent" : quote.quoteStatus,
    filename: `quote-${quote.id}.pdf`,
    render: () => renderQuotePdf(quote),
  };
}

async function loadInvoiceToSend(user: AuthedUser, invoiceId: string): Promise<DocumentToSend | null | "NOT_ISSUED"> {
  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId, companyId: user.companyId },
    include: { company: { select: { name: true } }, client: { select: { displayName: true, emailPrimary: true } }, items: true, payments: true },
  });
  if (!invoice) return null;
  if (invoice.invoiceStatus !== "issued") return "NOT_ISSUED";
  const total = invoice.items.reduce((sum, item) => sum + item.quantity * Number(item.unitPrice), 0);
  const paid = invoice.payments.reduce((sum, payment) => sum + Number(payment.amount), 0);
  return {
    kind: "invoice",
    id: invoice.id,
    reference: `${invoice.invoiceNumber}${invoice.title ? ` — ${invoice.title}` : ""} (${money(Math.max(0, total - paid))} outstanding)`,
    clientId: invoice.clientId,
    clientLabel: invoice.client.displayName,
    clientEmail: invoice.client.emailPrimary,
    jobId: null,
    companyName: invoice.company.name,
    statusBefore: invoice.invoiceStatus,
    statusAfter: invoice.invoiceStatus,
    filename: `invoice-${invoice.invoiceNumber.replace(/[^A-Za-z0-9._-]+/g, "_")}.pdf`,
    render: async () => {
      const pdf = await exportInvoicePdf(user, invoice.id);
      if (!pdf) throw new Error("INVOICE_PDF_UNAVAILABLE");
      return pdf;
    },
  };
}

function defaultSubject(document: DocumentToSend) {
  return document.kind === "quote" ? `Quote from ${document.companyName}: ${document.reference}` : `Invoice from ${document.companyName}: ${document.reference.split(" — ")[0].split(" (")[0]}`;
}

function defaultBody(document: DocumentToSend) {
  const noun = document.kind === "quote" ? "quote" : "invoice";
  return `Dear ${document.clientLabel},\n\nPlease find your ${noun} from ${document.companyName} attached as a PDF.\n\nIf you have any questions, simply reply to this email.\n\nKind regards,\n${document.companyName}`;
}

async function sendDocument(user: AuthedUser, action: ActionContract, document: DocumentToSend, input: SendDocumentInput): Promise<ServiceResult<unknown>> {
  const audit = (extra: Record<string, unknown>) => recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: action.actionName,
    riskLevel: action.riskLevel,
    confirmationRequired: action.confirmationRequired,
    ...extra,
  } as Parameters<typeof recordAudit>[0]);
  const idKey = document.kind === "quote" ? "quoteId" : "invoiceId";

  const to = input.to ?? (document.clientEmail ? [document.clientEmail] : []);
  if (to.length === 0) {
    await audit({ inputPayload: { [idKey]: document.id }, result: "error", errorMessage: "RECIPIENT_REQUIRED" });
    return fail(400, "RECIPIENT_REQUIRED", "The client has no stored email address; enter the recipient explicitly.");
  }
  const source = await resolveSendableGmailSource(user, input.source_id);
  if (!source.ok) {
    await audit({ inputPayload: { [idKey]: document.id, sourceId: input.source_id ?? null }, result: "error", errorMessage: source.error });
    return source;
  }
  const subject = input.subject ?? defaultSubject(document);
  const body = input.body ?? defaultBody(document);
  const pdf = await document.render();
  const auditSummary = { [idKey]: document.id, sourceId: source.data.id, recipientCount: to.length, ccCount: input.cc?.length ?? 0, subjectLength: subject.length, bodyLength: body.length, attachment: document.filename, attachmentBytes: pdf.length };

  const preview = {
    document: { kind: document.kind, id: document.id, reference: document.reference, client: { id: document.clientId, label: document.clientLabel } },
    source: source.data,
    to,
    cc: input.cc ?? [],
    subject,
    body,
    attachment: { filename: document.filename, contentType: "application/pdf", bytes: pdf.length },
    statusChange: document.statusBefore === document.statusAfter ? null : { from: document.statusBefore, to: document.statusAfter },
    communicationRecordWillBeCreated: true,
    followUpDueAt: input.follow_up_due_at ?? null,
  };
  if (!input.confirmed) {
    await audit({ inputPayload: { ...auditSummary, confirmed: false }, result: "rejected", errorMessage: "CONFIRMATION_REQUIRED" });
    return fail(409, "CONFIRMATION_REQUIRED", "Review the recipients, subject, body and attachment, then confirm sending.", { preview });
  }

  const sent = await sendThroughGmailSource(user, source.data.id, { to, cc: input.cc, subject, body, attachments: [{ filename: document.filename, contentType: "application/pdf", content: pdf }] });
  if (!sent.ok) {
    await audit({ inputPayload: { ...auditSummary, confirmed: true }, result: "error", errorMessage: sent.error });
    return sent;
  }

  // The provider acknowledged the message: record the real delivery in CRM.
  const summaryLine = `${document.kind === "quote" ? "Quote" : "Invoice"} sent by email: ${document.reference} → ${to.join(", ")}`;
  const [communication] = await prisma.$transaction([
    prisma.communicationRecord.create({
      data: {
        companyId: user.companyId,
        clientId: document.clientId,
        jobId: document.jobId,
        channel: "email",
        direction: "outbound",
        summary: summaryLine.slice(0, 500),
        fullText: `Subject: ${subject}\n\n${body}\n\n[Attachment: ${document.filename}, ${pdf.length} bytes; Gmail message ${sent.data.messageId}]`,
        occurredAt: sent.data.sentAt,
        followUpNeeded: Boolean(input.follow_up_due_at),
        followUpDueAt: input.follow_up_due_at ? new Date(input.follow_up_due_at) : null,
        createdBy: user.id,
      },
    }),
    ...(document.kind === "quote" && document.statusBefore !== document.statusAfter
      ? [prisma.quote.update({ where: { id: document.id }, data: { quoteStatus: document.statusAfter } })]
      : []),
  ]);

  const result = {
    ...sent.data,
    document: preview.document,
    to,
    statusChange: preview.statusChange,
    communicationRecordId: communication.id,
  };
  await audit({ inputPayload: { ...auditSummary, confirmed: true }, dataBefore: { status: document.statusBefore }, dataAfter: { status: document.statusAfter, messageId: sent.data.messageId, communicationRecordId: communication.id }, confirmed: true, result: "success" });
  return ok(200, result);
}

export async function sendQuoteByEmail(user: AuthedUser, quoteId: string, rawInput: unknown): Promise<ServiceResult<unknown>> {
  const parsed = sendDocumentSchema.safeParse(rawInput ?? {});
  if (!parsed.success) {
    await recordAudit({ companyId: user.companyId, userId: user.id, actionName: SEND_QUOTE_PDF_ACTION.actionName, inputPayload: { quoteId }, riskLevel: SEND_QUOTE_PDF_ACTION.riskLevel, confirmationRequired: true, result: "error", errorMessage: "VALIDATION_FAILED" });
    return fail(400, "VALIDATION_FAILED", parsed.error.message);
  }
  const document = await loadQuoteToSend(user, quoteId);
  if (!document) {
    await recordAudit({ companyId: user.companyId, userId: user.id, actionName: SEND_QUOTE_PDF_ACTION.actionName, inputPayload: { quoteId }, riskLevel: SEND_QUOTE_PDF_ACTION.riskLevel, confirmationRequired: true, result: "error", errorMessage: "QUOTE_NOT_FOUND" });
    return fail(404, "QUOTE_NOT_FOUND");
  }
  return sendDocument(user, SEND_QUOTE_PDF_ACTION, document, parsed.data);
}

export async function sendInvoiceByEmail(user: AuthedUser, invoiceId: string, rawInput: unknown): Promise<ServiceResult<unknown>> {
  const parsed = sendDocumentSchema.safeParse(rawInput ?? {});
  if (!parsed.success) {
    await recordAudit({ companyId: user.companyId, userId: user.id, actionName: SEND_INVOICE_PDF_ACTION.actionName, inputPayload: { invoiceId }, riskLevel: SEND_INVOICE_PDF_ACTION.riskLevel, confirmationRequired: true, result: "error", errorMessage: "VALIDATION_FAILED" });
    return fail(400, "VALIDATION_FAILED", parsed.error.message);
  }
  const document = await loadInvoiceToSend(user, invoiceId);
  if (!document || document === "NOT_ISSUED") {
    const code = document === "NOT_ISSUED" ? "INVOICE_NOT_ISSUED" : "INVOICE_NOT_FOUND";
    await recordAudit({ companyId: user.companyId, userId: user.id, actionName: SEND_INVOICE_PDF_ACTION.actionName, inputPayload: { invoiceId }, riskLevel: SEND_INVOICE_PDF_ACTION.riskLevel, confirmationRequired: true, result: "error", errorMessage: code });
    return document === "NOT_ISSUED" ? fail(409, code, "Only an issued invoice can be sent to the client; issue the draft first.") : fail(404, code);
  }
  return sendDocument(user, SEND_INVOICE_PDF_ACTION, document, parsed.data);
}
