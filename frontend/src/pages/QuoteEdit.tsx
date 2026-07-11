import { useEffect, useState } from "react";
import { useNavigate, useParams, useSearchParams, Link } from "react-router-dom";
import {
  api,
  ApiError,
  QUOTE_STATUSES,
  QUOTE_STATUS_LABELS,
  type Client,
  type Job,
  type Quote,
  type QuoteItemInput,
  type ServiceCatalogueItem,
} from "../api/client";

interface LineItemDraft {
  service_catalogue_item_id: string;
  description: string;
  quantity: string;
  unit_price: string;
  unit_cost: string;
}

function emptyLine(): LineItemDraft {
  return { service_catalogue_item_id: "", description: "", quantity: "1", unit_price: "", unit_cost: "" };
}

function toItemInputs(lines: LineItemDraft[]): QuoteItemInput[] {
  return lines
    .filter((l) => l.description.trim() && l.unit_price !== "")
    .map((l) => ({
      service_catalogue_item_id: l.service_catalogue_item_id || undefined,
      description: l.description.trim(),
      quantity: l.quantity ? Number(l.quantity) : 1,
      unit_price: Number(l.unit_price),
      unit_cost: l.unit_cost !== "" ? Number(l.unit_cost) : undefined,
    }));
}

// Quote, Pricing and Profitability Module — create/edit screen. Prices and
// costs are either typed in or pulled from a real service catalogue entry;
// nothing is invented. The margin preview recomputes live from exactly what
// is in the form, using the same "unknown if any cost is missing" rule the
// backend applies.
export function QuoteEdit() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const isNew = !id;

  const [clients, setClients] = useState<Client[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [services, setServices] = useState<ServiceCatalogueItem[]>([]);
  const [quote, setQuote] = useState<Quote | null>(null);

  const [clientId, setClientId] = useState(searchParams.get("client_id") ?? "");
  const [jobId, setJobId] = useState(searchParams.get("job_id") ?? "");
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<LineItemDraft[]>([emptyLine()]);

  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    api.clients.list().then(setClients).catch(() => undefined);
    api.catalogue.list(true).then(setServices).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!clientId) {
      setJobs([]);
      return;
    }
    api.jobs.list({ clientId }).then(setJobs).catch(() => undefined);
  }, [clientId]);

  useEffect(() => {
    if (!id) return;
    api.quotes
      .get(id)
      .then((q) => {
        setQuote(q);
        setClientId(q.clientId);
        setJobId(q.jobId ?? "");
        setTitle(q.title);
        setNotes(q.notes ?? "");
        setLines(
          q.items.length > 0
            ? q.items.map((i) => ({
                service_catalogue_item_id: i.serviceCatalogueItemId ?? "",
                description: i.description,
                quantity: String(i.quantity),
                unit_price: String(i.unitPrice),
                unit_cost: i.unitCost != null ? String(i.unitCost) : "",
              }))
            : [emptyLine()]
        );
      })
      .catch(() => setError("Quote not found."));
  }, [id]);

  function updateLine(index: number, patch: Partial<LineItemDraft>) {
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }

  function handleServiceSelect(index: number, serviceId: string) {
    const service = services.find((s) => s.id === serviceId);
    updateLine(index, {
      service_catalogue_item_id: serviceId,
      description: service && !lines[index].description ? service.name : lines[index].description,
      unit_price:
        service && !lines[index].unit_price && service.basePriceMin != null
          ? String(service.basePriceMin)
          : lines[index].unit_price,
    });
  }

  function addLine() {
    setLines((prev) => [...prev, emptyLine()]);
  }

  function removeLine(index: number) {
    setLines((prev) => (prev.length === 1 ? prev : prev.filter((_, i) => i !== index)));
  }

  // Live preview using the same rule the backend uses: margin is unknown
  // (not zero) if any priced line is missing a cost.
  const previewItems = toItemInputs(lines);
  let previewSubtotal = 0;
  let previewCostTotal = 0;
  let previewCostKnown = previewItems.length > 0;
  for (const item of previewItems) {
    const qty = item.quantity ?? 1;
    previewSubtotal += qty * item.unit_price;
    if (item.unit_cost == null) previewCostKnown = false;
    else previewCostTotal += qty * item.unit_cost;
  }
  const previewMargin = previewCostKnown ? previewSubtotal - previewCostTotal : null;
  const previewMarginPct = previewCostKnown && previewSubtotal > 0 ? (previewMargin! / previewSubtotal) * 100 : null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const items = toItemInputs(lines);
    if (items.length === 0) {
      setError("Add at least one line item with a description and price.");
      return;
    }
    setSubmitting(true);
    try {
      if (isNew) {
        const created = await api.quotes.create({
          client_id: clientId,
          job_id: jobId || undefined,
          title,
          notes: notes || undefined,
          items,
        });
        navigate(`/quotes/${created.id}`);
      } else {
        const updated = await api.quotes.update(id!, { title, notes: notes || undefined, items });
        setQuote(updated);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save quote.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleStatusChange(newStatus: (typeof QUOTE_STATUSES)[number]) {
    if (!id) return;
    try {
      const updated = await api.quotes.changeStatus(id, newStatus);
      setQuote(updated);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not change status.");
    }
  }

  async function handlePdfDownload() {
    if (!id) return;
    setDownloading(true);
    setError(null);
    try {
      const blob = await api.quotes.downloadPdf(id);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `quote-${id}.pdf`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not download quote PDF.");
    } finally {
      setDownloading(false);
    }
  }

  if (!isNew && !quote && !error) return <p>Loading…</p>;

  return (
    <div>
      <Link to="/quotes">← Back to quotes</Link>
      <h1>{isNew ? "New quote" : `Quote: ${quote?.title ?? ""}`}</h1>
      {error && <div className="error-banner">{error}</div>}

      {!isNew && quote && (
        <div className="hint">
          Status:{" "}
          <select value={quote.quoteStatus} onChange={(e) => handleStatusChange(e.target.value as any)}>
            {QUOTE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {QUOTE_STATUS_LABELS[s]}
              </option>
            ))}
          </select>{" "}
          — changing status only updates the internal record; nothing is sent to the client
          automatically.
          {" "}<button type="button" onClick={handlePdfDownload} disabled={downloading}>{downloading ? "Preparing PDF…" : "Download PDF"}</button>
        </div>
      )}

      <form onSubmit={handleSubmit}>
        {isNew && (
          <div className="detail-list" style={{ marginBottom: 16 }}>
            <label>
              Client
              <select value={clientId} onChange={(e) => setClientId(e.target.value)} required>
                <option value="">— Select a client —</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.displayName}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Job (optional)
              <select value={jobId} onChange={(e) => setJobId(e.target.value)} disabled={!clientId}>
                <option value="">— Not linked to a job —</option>
                {jobs.map((j) => (
                  <option key={j.id} value={j.id}>
                    {j.jobTitle}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}

        <label>
          Title
          <input value={title} onChange={(e) => setTitle(e.target.value)} required />
        </label>
        <label>
          Notes
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
        </label>

        <h2>Line items</h2>
        <table className="data-table">
          <thead>
            <tr>
              <th>Service</th>
              <th>Description</th>
              <th>Qty</th>
              <th>Unit price</th>
              <th>Unit cost</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line, index) => (
              <tr key={index}>
                <td>
                  <select
                    value={line.service_catalogue_item_id}
                    onChange={(e) => handleServiceSelect(index, e.target.value)}
                  >
                    <option value="">—</option>
                    {services.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <input
                    value={line.description}
                    onChange={(e) => updateLine(index, { description: e.target.value })}
                    placeholder="What this line covers"
                  />
                </td>
                <td>
                  <input
                    type="number"
                    min="0"
                    step="0.5"
                    style={{ width: 70 }}
                    value={line.quantity}
                    onChange={(e) => updateLine(index, { quantity: e.target.value })}
                  />
                </td>
                <td>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    style={{ width: 90 }}
                    value={line.unit_price}
                    onChange={(e) => updateLine(index, { unit_price: e.target.value })}
                  />
                </td>
                <td>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    style={{ width: 90 }}
                    placeholder="optional"
                    value={line.unit_cost}
                    onChange={(e) => updateLine(index, { unit_cost: e.target.value })}
                  />
                </td>
                <td>
                  <button type="button" onClick={() => removeLine(index)} disabled={lines.length === 1}>
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <button type="button" onClick={addLine}>
          + Add line
        </button>

        <div className="detail-list" style={{ marginTop: 16 }}>
          <dt>Subtotal</dt>
          <dd>£{previewSubtotal.toFixed(2)}</dd>
          <dt>Margin</dt>
          <dd>
            {previewMargin != null ? (
              <>
                £{previewMargin.toFixed(2)} ({previewMarginPct!.toFixed(1)}%)
              </>
            ) : (
              <span className="hint">Unknown — enter a unit cost on every line to see margin</span>
            )}
          </dd>
        </div>

        <button type="submit" disabled={submitting || !clientId}>
          {submitting ? "Saving…" : isNew ? "Create quote" : "Save changes"}
        </button>
      </form>
    </div>
  );
}
