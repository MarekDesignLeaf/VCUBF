import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, QUOTE_STATUS_LABELS, type Quote } from "../api/client";

// Quote, Pricing and Profitability Module — every quote here is built from
// real, user-entered line items (prices and, optionally, costs). Margin is
// whatever the backend actually computed from those entries; a quote with
// no cost data shows "—" for margin rather than a guessed number.
export function Quotes() {
  const [quotes, setQuotes] = useState<Quote[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.quotes
      .list()
      .then(setQuotes)
      .catch(() => setError("Could not load quotes."));
  }, []);

  if (error) return <div className="error-banner">{error}</div>;
  if (!quotes) return <p>Loading…</p>;

  return (
    <div>
      <div className="page-header">
        <h1>Quotes</h1>
        <Link to="/quotes/new">New quote</Link>
      </div>
      <p className="hint">
        Built from real line-item prices (and, where entered, real costs) — margin is left blank
        rather than guessed when cost data is missing.
      </p>
      {quotes.length === 0 ? (
        <p className="hint">No quotes yet.</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Title</th>
              <th>Client</th>
              <th>Status</th>
              <th>Subtotal</th>
              <th>Margin</th>
            </tr>
          </thead>
          <tbody>
            {quotes.map((q) => (
              <tr key={q.id}>
                <td>
                  <Link to={`/quotes/${q.id}`}>{q.title}</Link>
                </td>
                <td>{q.client ? <Link to={`/clients/${q.client.id}`}>{q.client.displayName}</Link> : "—"}</td>
                <td>{QUOTE_STATUS_LABELS[q.quoteStatus]}</td>
                <td>£{q.totals.subtotal.toFixed(2)}</td>
                <td>
                  {q.totals.marginAmount != null ? (
                    <>
                      £{q.totals.marginAmount.toFixed(2)} ({q.totals.marginPct!.toFixed(1)}%)
                    </>
                  ) : (
                    <span className="hint">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
