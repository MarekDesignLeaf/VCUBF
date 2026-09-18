import { useEffect, useMemo, useState } from "react";
import { api, ApiError, type Client, type Invoice, type InvoiceItem } from "../api/client";
import { SendDocumentDialog } from "../components/SendDocumentDialog";

export function Invoices() {
  const requestedClientId = useMemo(() => new URLSearchParams(window.location.search).get("client") ?? "", []);
  const [rows, setRows] = useState<Invoice[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [error, setError] = useState("");
  const [client, setClient] = useState(requestedClientId);
  const [num, setNum] = useState("");
  const [title, setTitle] = useState("");
  const [amount, setAmount] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [sending, setSending] = useState<string | null>(null);
  const [sentNotice, setSentNotice] = useState<string | null>(null);

  const selectedClient = clients.find((candidate) => candidate.id === client);
  const load = () => api.invoices.list().then(setRows).catch(() => setError("Could not load invoices."));

  useEffect(() => {
    load();
    api.clients.list()
      .then((items) => {
        setClients(items);
        if (requestedClientId && items.some((item) => item.id === requestedClientId)) setClient(requestedClientId);
      })
      .catch(() => setError("Could not load clients."));
  }, [requestedClientId]);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    try {
      await api.invoices.create({
        client_id: client,
        invoice_number: num,
        title,
        items: [{ description: title, quantity: 1, unit_price: Number(amount) }],
      });
      setNum("");
      setTitle("");
      setAmount("");
      load();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Could not create invoice.");
    }
  }

  async function issue(id: string) {
    await api.invoices.status(id, "issued");
    load();
  }

  async function pay(invoice: Invoice) {
    const raw = window.prompt(`Payment amount (balance £${invoice.totals.balance.toFixed(2)})`);
    if (!raw) return;
    const data = { amount: Number(raw), paid_at: new Date().toISOString() };
    try {
      await api.invoices.payment(invoice.id, data);
    } catch (cause) {
      if (!(cause instanceof ApiError) || cause.code !== "CONFIRMATION_REQUIRED") throw cause;
      const preview = cause.details?.preview as Record<string, unknown> | undefined;
      if (!window.confirm(`Confirm payment £${preview?.amount} for ${preview?.client}? Balance after: £${preview?.balanceAfter}`)) return;
      await api.invoices.payment(invoice.id, data, true);
    }
    load();
  }

  async function pdf(invoice: Invoice) {
    const blob = await api.invoices.downloadPdf(invoice.id);
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `invoice-${invoice.invoiceNumber}.pdf`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div>
      <h1>Invoices</h1>
      {error && <div className="error-banner">{error}</div>}
      {selectedClient && (
        <div className="info-banner" role="status">
          <strong>Invoice customer: {selectedClient.displayName}</strong>
          <span>{[selectedClient.billingLine1, selectedClient.billingCity, selectedClient.billingPostcode].filter(Boolean).join(", ") || "Billing address missing"}</span>
          <span>{selectedClient.emailPrimary || "Email missing"} · {selectedClient.phonePrimary || "Phone missing"}</span>
        </div>
      )}
      <form className="inline-form" onSubmit={create}>
        <select value={client} onChange={(event) => setClient(event.target.value)} required>
          <option value="">Client</option>
          {clients.map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}
        </select>
        <input placeholder="Invoice number" value={num} onChange={(event) => setNum(event.target.value)} required />
        <input placeholder="Description" value={title} onChange={(event) => setTitle(event.target.value)} required />
        <input type="number" min="0" step="0.01" placeholder="Amount" value={amount} onChange={(event) => setAmount(event.target.value)} required />
        <button>Create draft</button>
      </form>
      <table>
        <thead><tr><th>Number</th><th>Client</th><th>Status</th><th>Total</th><th>Paid</th><th>Balance</th><th>Actions</th></tr></thead>
        <tbody>{rows.map((invoice) => editing === invoice.id ? (
          <InvoiceEditor
            key={invoice.id}
            invoice={invoice}
            onSaved={() => { setEditing(null); load(); }}
            onCancel={() => setEditing(null)}
          />
        ) : (
          <tr key={invoice.id}>
            <td>{invoice.invoiceNumber}</td><td>{invoice.client.displayName}</td><td>{invoice.isOverdue ? "overdue" : invoice.invoiceStatus}</td>
            <td>£{invoice.totals.total.toFixed(2)}</td><td>£{invoice.totals.paid.toFixed(2)}</td><td>£{invoice.totals.balance.toFixed(2)}</td>
            <td>{invoice.invoiceStatus === "draft" && <button data-action="invoice-edit" onClick={() => setEditing(invoice.id)}>Edit</button>} {invoice.invoiceStatus === "draft" && <button onClick={() => issue(invoice.id)}>Issue</button>} {invoice.invoiceStatus === "issued" && invoice.totals.balance > 0 && <button onClick={() => pay(invoice)}>Record payment</button>} <button onClick={() => pdf(invoice)}>PDF</button> {invoice.invoiceStatus === "issued" && <button onClick={() => setSending(invoice.id)}>Send by email</button>}</td>
          </tr>
        ))}</tbody>
      </table>
      {sentNotice && <div className="success-banner">{sentNotice}</div>}
      {sending && <SendDocumentDialog kind="invoice" id={sending} onClose={() => setSending(null)} onSent={(result) => {
        setSending(null);
        setSentNotice(`Sent to ${result.to.join(", ")} and logged on the client record.`);
        load();
      }} />}
    </div>
  );
}

/**
 * A draft invoice, edited in place — including its lines.
 *
 * The create form makes one line from a single amount box, so this is the only place
 * a real invoice can be assembled. Lines are sent as a complete list because that is
 * what the backend replaces; a partially applied edit would be a worse state than
 * either version.
 *
 * The running total is shown while typing. An invoice is arithmetic, and finding out
 * the total only after saving is how wrong invoices get issued.
 */
function InvoiceEditor({
  invoice,
  onSaved,
  onCancel,
}: {
  invoice: Invoice;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [number, setNumber] = useState(invoice.invoiceNumber);
  const [title, setTitle] = useState(invoice.title);
  const [due, setDue] = useState(invoice.dueDate ? invoice.dueDate.slice(0, 10) : "");
  const [notes, setNotes] = useState(invoice.notes ?? "");
  const [lines, setLines] = useState<InvoiceItem[]>(
    invoice.items?.length
      ? invoice.items.map((line) => ({ ...line }))
      : [{ description: invoice.title, quantity: 1, unitPrice: invoice.totals.total }]
  );
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const total = lines.reduce((sum, line) => sum + (Number(line.quantity) || 0) * (Number(line.unitPrice) || 0), 0);

  const setLine = (index: number, patch: Partial<InvoiceItem>) =>
    setLines((current) => current.map((line, at) => (at === index ? { ...line, ...patch } : line)));

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    const items = lines
      .filter((line) => line.description.trim())
      .map((line) => ({
        description: line.description.trim(),
        quantity: Number(line.quantity) || 1,
        unit_price: Number(line.unitPrice) || 0,
      }));
    if (items.length === 0) {
      setError("An invoice needs at least one line with a description.");
      return;
    }
    setSaving(true);
    try {
      await api.invoices.update(invoice.id, {
        invoice_number: number,
        title,
        // An empty date clears the due date rather than keeping the old one.
        due_date: due ? new Date(`${due}T00:00:00.000Z`).toISOString() : null,
        notes: notes.trim() || null,
        items,
      });
      onSaved();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Could not save invoice.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <tr>
      <td colSpan={7}>
        <form onSubmit={save}>
          <div className="inline-form">
            <input placeholder="Invoice number" value={number} onChange={(event) => setNumber(event.target.value)} required />
            <input placeholder="Description" value={title} onChange={(event) => setTitle(event.target.value)} required />
            <label>
              Due
              <input type="date" value={due} onChange={(event) => setDue(event.target.value)} />
            </label>
          </div>
          <table className="data-table">
            <thead>
              <tr><th>Line</th><th>Quantity</th><th>Unit price</th><th>Line total</th><th></th></tr>
            </thead>
            <tbody>
              {lines.map((line, index) => (
                <tr key={index}>
                  <td>
                    <input
                      value={line.description}
                      onChange={(event) => setLine(index, { description: event.target.value })}
                      placeholder="What is being charged for"
                      style={{ minWidth: 220 }}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={line.quantity}
                      onChange={(event) => setLine(index, { quantity: Number(event.target.value) })}
                      style={{ width: 90 }}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={line.unitPrice}
                      onChange={(event) => setLine(index, { unitPrice: Number(event.target.value) })}
                      style={{ width: 110 }}
                    />
                  </td>
                  <td>£{((Number(line.quantity) || 0) * (Number(line.unitPrice) || 0)).toFixed(2)}</td>
                  <td>
                    {lines.length > 1 && (
                      <button
                        type="button"
                        className="secondary"
                        data-action="invoice-line-remove"
                        onClick={() => setLines((current) => current.filter((_, at) => at !== index))}
                      >
                        Remove
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="inline-form">
            <button
              type="button"
              className="secondary"
              data-action="invoice-line-add"
              onClick={() => setLines((current) => [...current, { description: "", quantity: 1, unitPrice: 0 }])}
            >
              Add line
            </button>
            <strong>Total £{total.toFixed(2)}</strong>
          </div>
          <div className="inline-form">
            <input placeholder="Notes" value={notes} onChange={(event) => setNotes(event.target.value)} style={{ minWidth: 320 }} />
          </div>
          <div className="inline-form">
            <button type="submit" data-action="invoice-save" disabled={saving}>
              {saving ? "Saving\u2026" : "Save draft"}
            </button>
            <button type="button" className="secondary" data-action="invoice-cancel" onClick={onCancel} disabled={saving}>
              Cancel
            </button>
          </div>
          <p className="hint">
            Only a draft can be edited. Once issued, the client has this document — correcting it means voiding
            this invoice and issuing a replacement.
          </p>
          {error && <div className="error-banner">{error}</div>}
        </form>
      </td>
    </tr>
  );
}
