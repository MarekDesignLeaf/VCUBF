import PDFDocument from "pdfkit";
import { prisma } from "../db.js";
import { recordAudit } from "../lib/audit.js";
import { EXPORT_QUOTE_PDF_ACTION } from "../lib/actionContracts.js";
import type { AuthedUser } from "../middleware/auth.js";

const money = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" });

function clean(value: string) {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/[\u2012-\u2015]/g, "-").trim();
}

function date(value: Date) {
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" }).format(value);
}

export type QuotePdfData = NonNullable<Awaited<ReturnType<typeof loadQuotePdfData>>>;

export async function loadQuotePdfData(user: AuthedUser, quoteId: string) {
  return prisma.quote.findFirst({
    where: { id: quoteId, companyId: user.companyId },
    include: {
      company: { select: { name: true } },
      client: {
        select: {
          displayName: true,
          companyName: true,
          emailPrimary: true,
          phonePrimary: true,
          billingLine1: true,
          billingCity: true,
          billingPostcode: true,
        },
      },
      job: { select: { jobTitle: true } },
      items: { orderBy: { sortOrder: "asc" } },
    },
  });
}

export function renderQuotePdf(quote: QuotePdfData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 48, bufferPages: true, info: { Title: clean(quote.title), Author: clean(quote.company.name), Subject: "Quote" } });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("error", reject);
    doc.on("end", () => resolve(Buffer.concat(chunks)));

    const left = 48;
    const right = 547;
    const bottom = 770;
    const columns = { description: left, quantity: 333, unitPrice: 393, total: 475 };

    const pageHeader = () => {
      doc.fillColor("#17324d").font("Helvetica-Bold").fontSize(19).text(clean(quote.company.name), left, 48, { width: 310 });
      doc.fontSize(25).text("QUOTE", 400, 48, { width: 147, align: "right" });
      doc.moveTo(left, 83).lineTo(right, 83).lineWidth(2).strokeColor("#2f80ed").stroke();
      doc.y = 102;
    };
    const tableHeader = () => {
      const y = doc.y;
      doc.rect(left, y, right - left, 24).fill("#17324d");
      doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(9);
      doc.text("DESCRIPTION", columns.description + 6, y + 8, { width: 270 });
      doc.text("QTY", columns.quantity, y + 8, { width: 45, align: "right" });
      doc.text("UNIT PRICE", columns.unitPrice, y + 8, { width: 70, align: "right" });
      doc.text("TOTAL", columns.total, y + 8, { width: 66, align: "right" });
      doc.y = y + 30;
    };
    const ensureSpace = (height: number) => {
      if (doc.y + height <= bottom) return;
      doc.addPage();
      pageHeader();
      tableHeader();
    };

    pageHeader();
    doc.fillColor("#4b5563").font("Helvetica").fontSize(9).text("QUOTE ID", left, doc.y);
    doc.fillColor("#111827").font("Helvetica-Bold").fontSize(10).text(quote.id, left, doc.y + 4, { width: 250 });
    const metaY = 102;
    doc.fillColor("#4b5563").font("Helvetica").fontSize(9).text("CREATED", 365, metaY, { width: 80, align: "right" });
    doc.fillColor("#111827").font("Helvetica-Bold").fontSize(10).text(date(quote.createdAt), 450, metaY, { width: 97, align: "right" });
    doc.fillColor("#4b5563").font("Helvetica").fontSize(9).text("VALID UNTIL", 365, metaY + 20, { width: 80, align: "right" });
    doc.fillColor("#111827").font("Helvetica-Bold").fontSize(10).text(quote.validUntil ? date(quote.validUntil) : "Not specified", 450, metaY + 20, { width: 97, align: "right" });
    doc.fillColor("#4b5563").font("Helvetica").fontSize(9).text("STATUS", 365, metaY + 40, { width: 80, align: "right" });
    doc.fillColor("#111827").font("Helvetica-Bold").fontSize(10).text(clean(quote.quoteStatus).toUpperCase(), 450, metaY + 40, { width: 97, align: "right" });

    doc.y = 178;
    doc.fillColor("#4b5563").font("Helvetica-Bold").fontSize(9).text("PREPARED FOR", left, doc.y, { width: 300 });
    doc.fillColor("#111827").fontSize(13).text(clean(quote.client.displayName), left, doc.y, { width: 300 });
    const clientLines = [quote.client.companyName, quote.client.emailPrimary, quote.client.phonePrimary, quote.client.billingLine1, [quote.client.billingCity, quote.client.billingPostcode].filter(Boolean).join(" ")].filter((v): v is string => Boolean(v));
    doc.fillColor("#374151").font("Helvetica").fontSize(9);
    clientLines.forEach((line) => doc.text(clean(line), left, doc.y, { width: 300 }));
    if (quote.job) doc.text(`Job: ${clean(quote.job.jobTitle)}`, left, doc.y, { width: 300 });

    doc.moveDown(1.2).fillColor("#111827").font("Helvetica-Bold").fontSize(16).text(clean(quote.title), left, doc.y, { width: right - left });
    doc.moveDown(0.8);
    tableHeader();

    for (const item of quote.items) {
      const description = clean(item.description);
      const height = Math.max(24, doc.heightOfString(description, { width: 270 }) + 12);
      ensureSpace(height);
      const y = doc.y;
      doc.fillColor("#111827").font("Helvetica").fontSize(9).text(description, columns.description + 6, y + 5, { width: 270 });
      doc.text(String(item.quantity), columns.quantity, y + 5, { width: 45, align: "right" });
      doc.text(money.format(Number(item.unitPrice)), columns.unitPrice, y + 5, { width: 70, align: "right" });
      doc.font("Helvetica-Bold").text(money.format(item.quantity * Number(item.unitPrice)), columns.total, y + 5, { width: 66, align: "right" });
      doc.moveTo(left, y + height).lineTo(right, y + height).lineWidth(0.5).strokeColor("#d1d5db").stroke();
      doc.y = y + height + 1;
    }

    ensureSpace(85);
    const subtotal = quote.items.reduce((sum, item) => sum + item.quantity * Number(item.unitPrice), 0);
    doc.moveDown(0.8).fillColor("#4b5563").font("Helvetica-Bold").fontSize(10).text("SUBTOTAL", 365, doc.y, { width: 90, align: "right" });
    doc.fillColor("#17324d").fontSize(14).text(money.format(subtotal), 462, doc.y - 2, { width: 85, align: "right" });
    doc.moveDown(1.5).fillColor("#6b7280").font("Helvetica").fontSize(8).text("Tax/VAT is not specified in this quote. Currency: GBP.", 315, doc.y, { width: 232, align: "right" });

    if (quote.notes?.trim()) {
      const notes = clean(quote.notes);
      const noteHeight = doc.heightOfString(notes, { width: right - left - 20 }) + 38;
      ensureSpace(noteHeight);
      doc.moveDown(1.2).roundedRect(left, doc.y, right - left, noteHeight, 4).fill("#f3f4f6");
      const y = doc.y + 10;
      doc.fillColor("#4b5563").font("Helvetica-Bold").fontSize(9).text("NOTES", left + 10, y);
      doc.fillColor("#111827").font("Helvetica").fontSize(9).text(notes, left + 10, y + 14, { width: right - left - 20 });
      doc.y += noteHeight;
    }

    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i += 1) {
      doc.switchToPage(range.start + i);
      doc.fillColor("#6b7280").font("Helvetica").fontSize(8).text(`Generated from the saved quote record | Page ${i + 1} of ${range.count}`, left, 780, { width: right - left, align: "center", lineBreak: false });
    }
    doc.end();
  });
}

export async function exportQuotePdf(user: AuthedUser, quoteId: string) {
  const quote = await loadQuotePdfData(user, quoteId);
  if (!quote) {
    await recordAudit({ companyId: user.companyId, userId: user.id, actionName: EXPORT_QUOTE_PDF_ACTION.actionName, inputPayload: { quoteId }, riskLevel: EXPORT_QUOTE_PDF_ACTION.riskLevel, confirmationRequired: false, result: "error", errorMessage: "QUOTE_NOT_FOUND" });
    return null;
  }
  const pdf = await renderQuotePdf(quote);
  await recordAudit({ companyId: user.companyId, userId: user.id, actionName: EXPORT_QUOTE_PDF_ACTION.actionName, inputPayload: { quoteId }, dataAfter: { quoteId, byteLength: pdf.length }, riskLevel: EXPORT_QUOTE_PDF_ACTION.riskLevel, confirmationRequired: false, result: "success" });
  return pdf;
}
