import { useEffect, useMemo, useState } from "react";
import { api, ApiError, type Client, type Invoice } from "../api/client";

export function Invoices() {
  const requestedClientId = useMemo(() => new URLSearchParams(window.location.search).get("client") ?? "", []);
  const [rows, setRows] = useState<Invoice[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [error, setError] = useState("");
  const [client, setClient] = useState(requestedClientId);
  const [num, setNum] = useState("");
  const [title, setTitle] = useState("");
  const [amount, setAmount] = useState("");

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
        <tbody>{rows.map((invoice) => (
          <tr key={invoice.id}>
            <td>{invoice.invoiceNumber}</td><td>{invoice.client.displayName}</td><td>{invoice.isOverdue ? "overdue" : invoice.invoiceStatus}</td>
            <td>£{invoice.totals.total.toFixed(2)}</td><td>£{invoice.totals.paid.toFixed(2)}</td><td>£{invoice.totals.balance.toFixed(2)}</td>
            <td>{invoice.invoiceStatus === "draft" && <button onClick={() => issue(invoice.id)}>Issue</button>} {invoice.invoiceStatus === "issued" && invoice.totals.balance > 0 && <button onClick={() => pay(invoice)}>Record payment</button>} <button onClick={() => pdf(invoice)}>PDF</button></td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}
