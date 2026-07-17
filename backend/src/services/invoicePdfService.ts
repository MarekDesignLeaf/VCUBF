import PDFDocument from "pdfkit";
import { prisma } from "../db.js";
import { recordAudit } from "../lib/audit.js";
import type { AuthedUser } from "../middleware/auth.js";

const money = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" });

export async function exportInvoicePdf(user: AuthedUser, id: string) {
  const invoice = await prisma.invoice.findFirst({
    where: { id, companyId: user.companyId },
    include: {
      company: { select: { name: true } },
      client: {
        select: {
          displayName: true,
          emailPrimary: true,
          phonePrimary: true,
          billingLine1: true,
          billingCity: true,
          billingPostcode: true,
        },
      },
      items: { orderBy: { sortOrder: "asc" } },
      payments: true,
    },
  });
  if (!invoice) return null;

  const total = invoice.items.reduce((sum, item) => sum + item.quantity * Number(item.unitPrice), 0);
  const paid = invoice.payments.reduce((sum, payment) => sum + Number(payment.amount), 0);
  const buffer = await new Promise<Buffer>((resolve, reject) => {
    const document = new PDFDocument({
      size: "A4",
      margin: 48,
      info: { Title: `Invoice ${invoice.invoiceNumber}`, Author: invoice.company.name },
    });
    const chunks: Buffer[] = [];
    document.on("data", (chunk) => chunks.push(chunk));
    document.on("end", () => resolve(Buffer.concat(chunks)));
    document.on("error", reject);
    document.fontSize(22).text(invoice.company.name).fontSize(28).text("INVOICE", { align: "right" });
    document.moveDown().fontSize(11).text(`Invoice number: ${invoice.invoiceNumber}`).text(`Client: ${invoice.client.displayName}`);
    if (invoice.client.emailPrimary) document.text(`Email: ${invoice.client.emailPrimary}`);
    if (invoice.client.phonePrimary) document.text(`Phone: ${invoice.client.phonePrimary}`);
    const billingAddress = [invoice.client.billingLine1, invoice.client.billingCity, invoice.client.billingPostcode].filter(Boolean).join(", ");
    if (billingAddress) document.text(`Billing address: ${billingAddress}`);
    if (invoice.issueDate) document.text(`Issue date: ${invoice.issueDate.toISOString().slice(0, 10)}`);
    if (invoice.dueDate) document.text(`Due date: ${invoice.dueDate.toISOString().slice(0, 10)}`);
    document.moveDown().fontSize(14).text(invoice.title).moveDown();
    for (const item of invoice.items) {
      document.fontSize(10).text(`${item.description}  ${item.quantity} × ${money.format(Number(item.unitPrice))}  ${money.format(item.quantity * Number(item.unitPrice))}`);
    }
    document.moveDown().fontSize(12)
      .text(`Total: ${money.format(total)}`, { align: "right" })
      .text(`Paid: ${money.format(paid)}`, { align: "right" })
      .font("Helvetica-Bold")
      .text(`Balance: ${money.format(Math.max(0, total - paid))}`, { align: "right" });
    document.end();
  });

  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: "export_invoice_pdf",
    inputPayload: { invoiceId: id },
    riskLevel: 1,
    confirmationRequired: false,
    result: "success",
  });
  return buffer;
}
