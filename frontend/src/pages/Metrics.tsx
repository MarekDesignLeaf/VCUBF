import { useEffect, useState } from "react";
import { api, type MetricsOverview } from "../api/client";

const INITIAL_TO = new Date().toISOString().slice(0, 10);
const INITIAL_FROM = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);

function value(value: number | null, suffix = "") {
  return value == null ? "Unknown" : `${value}${suffix}`;
}

function change(current: number | null, previous: number | null, suffix = "") {
  if (current == null || previous == null) return "Comparison unavailable";
  const delta = Math.round((current - previous) * 10) / 10;
  return `${delta > 0 ? "+" : ""}${delta}${suffix} vs previous period`;
}

export function Metrics() {
  const [data, setData] = useState<MetricsOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [from, setFrom] = useState(INITIAL_FROM);
  const [to, setTo] = useState(INITIAL_TO);
  const [loading, setLoading] = useState(false);

  async function load(selectedFrom = from, selectedTo = to) {
    setLoading(true);
    setError(null);
    try {
      setData(await api.metrics.overview({ from: `${selectedFrom}T00:00:00.000Z`, to: `${selectedTo}T23:59:59.999Z` }));
    } catch {
      setError("Could not load business metrics.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(INITIAL_FROM, INITIAL_TO); }, []);
  if (error && !data) return <div className="error-banner">{error}</div>;
  if (!data) return <p>Loading…</p>;
  return <div>
    <h1>Business Metrics</h1>
    {error && <div className="error-banner">{error}</div>}
    <p className="hint">Measured from saved records for the last {data.period.days} days. Unknown metrics stay unknown rather than being estimated.</p>
    <form className="inline-form" onSubmit={(event) => { event.preventDefault(); void load(); }}>
      <label>From<input type="date" value={from} max={to} onChange={(event) => setFrom(event.target.value)} required /></label>
      <label>To<input type="date" value={to} min={from} onChange={(event) => setTo(event.target.value)} required /></label>
      <button type="submit" disabled={loading}>{loading ? "Refreshing…" : "Apply period"}</button>
    </form>
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 16 }}>
      <section className="card"><h3>New leads</h3><strong style={{ fontSize: 28 }}>{data.leads.newCount}</strong><p>{data.leads.convertedCount} converted · {data.leads.lostCount} lost</p></section>
      <section className="card"><h3>Quote conversion</h3><strong style={{ fontSize: 28 }}>{value(data.quotes.conversionRatePct, "%")}</strong><p>{data.quotes.acceptedCount} accepted of {data.quotes.decidedCount} decided</p></section>
      <section className="card"><h3>Average quote</h3><strong style={{ fontSize: 28 }}>{data.quotes.averageValueGbp == null ? "Unknown" : `£${data.quotes.averageValueGbp.toFixed(2)}`}</strong><p>From {data.quotes.count} saved quotes</p></section>
      <section className="card"><h3>Team utilisation</h3><strong style={{ fontSize: 28 }}>{data.capacity.available ? value(data.capacity.utilizationPct, "%") : "Unknown"}</strong><p>{data.capacity.available ? `${data.capacity.loadHours} of ${data.capacity.capacityHours} entered hours` : data.capacity.reason}</p></section>
    </div>
    <h2>Compared with previous period</h2>
    <table className="data-table"><thead><tr><th>Metric</th><th>Current</th><th>Previous</th><th>Change</th></tr></thead><tbody>
      <tr><td>New leads</td><td>{data.trends.newLeads.current}</td><td>{data.trends.newLeads.previous}</td><td>{change(data.trends.newLeads.current, data.trends.newLeads.previous)}</td></tr>
      <tr><td>Quotes created</td><td>{data.trends.quoteCount.current}</td><td>{data.trends.quoteCount.previous}</td><td>{change(data.trends.quoteCount.current, data.trends.quoteCount.previous)}</td></tr>
      <tr><td>Quote conversion</td><td>{value(data.trends.quoteConversionRatePct.current, "%")}</td><td>{value(data.trends.quoteConversionRatePct.previous, "%")}</td><td>{change(data.trends.quoteConversionRatePct.current, data.trends.quoteConversionRatePct.previous, " pp")}</td></tr>
      <tr><td>Average quote</td><td>{data.trends.averageQuoteValueGbp.current == null ? "Unknown" : `£${data.trends.averageQuoteValueGbp.current.toFixed(2)}`}</td><td>{data.trends.averageQuoteValueGbp.previous == null ? "Unknown" : `£${data.trends.averageQuoteValueGbp.previous.toFixed(2)}`}</td><td>{change(data.trends.averageQuoteValueGbp.current, data.trends.averageQuoteValueGbp.previous, " GBP")}</td></tr>
      <tr><td>Completed jobs</td><td>{data.trends.completedJobs.current}</td><td>{data.trends.completedJobs.previous}</td><td>{change(data.trends.completedJobs.current, data.trends.completedJobs.previous)}</td></tr>
    </tbody></table>
    <h2>Requested service demand</h2>
    <p className="hint">{data.serviceDemand.basis}</p>
    {data.serviceDemand.rows.length ? <table className="data-table"><thead><tr><th>Entered service</th><th>Current leads</th><th>Previous leads</th><th>Change</th></tr></thead><tbody>{data.serviceDemand.rows.map((row) => <tr key={row.serviceRequested.toLocaleLowerCase()}><td>{row.serviceRequested}</td><td>{row.current}</td><td>{row.previous}</td><td>{row.delta > 0 ? "+" : ""}{row.delta}</td></tr>)}</tbody></table> : <p className="hint">No leads have a requested service in this period.</p>}
    {data.serviceDemand.unclassifiedLeadCount > 0 && <p className="hint">{data.serviceDemand.unclassifiedLeadCount} leads have no requested service and remain unclassified.</p>}
    <h2>Data completeness</h2>
    <p className="hint">Coverage of the saved fields used by KPI, margin and capacity calculations. Empty samples remain unknown.</p>
    <table className="data-table"><thead><tr><th>Input</th><th>Complete records</th><th>Coverage</th></tr></thead><tbody>
      {([
        ["Lead source", data.dataCompleteness.leadSource],
        ["Quote line service link", data.dataCompleteness.quoteServiceLink],
        ["Quote line unit cost", data.dataCompleteness.quoteCost],
        ["Active job duration estimate", data.dataCompleteness.activeJobEstimate],
        ["Active job planned date", data.dataCompleteness.activeJobPlannedDate],
        ["Active job service link", data.dataCompleteness.activeJobServiceLink],
      ] as const).map(([label, metric]) => <tr key={label}><td>{label}</td><td>{metric.complete}/{metric.total}</td><td>{value(metric.pct, "%")}</td></tr>)}
    </tbody></table>
    <h2>Lead sources</h2>
    {data.leads.sources.length ? <table className="data-table"><thead><tr><th>Source</th><th>Leads</th><th>Converted</th><th>Lost</th><th>Conversion</th><th>Loss rate</th></tr></thead><tbody>{data.leads.sources.map((row) => <tr key={row.source}><td>{row.source}</td><td>{row.count}</td><td>{row.convertedCount}</td><td>{row.lostCount}</td><td>{value(row.conversionRatePct, "%")}</td><td>{value(row.lossRatePct, "%")}</td></tr>)}</tbody></table> : <p className="hint">No leads in this period.</p>}
    <h2>Accepted quote value by service</h2>
    <p className="hint">{data.revenueByService.basis}</p>
    {data.revenueByService.rows.length ? <table className="data-table"><thead><tr><th>Service</th><th>Cost coverage</th><th>Accepted value</th><th>Quote margin</th></tr></thead><tbody>{data.revenueByService.rows.map((row) => <tr key={row.serviceId}><td>{row.serviceName}</td><td>{row.linesWithKnownCost}/{row.lineCount} lines</td><td>£{row.acceptedValueGbp.toFixed(2)}</td><td>{row.costKnown && row.marginGbp != null ? `£${row.marginGbp.toFixed(2)} (${row.marginPct?.toFixed(1)}%)` : "Unknown - missing cost"}</td></tr>)}</tbody></table> : <p className="hint">No accepted quote lines are linked to catalogue services in this period.</p>}
    {data.revenueByService.unlinkedAcceptedValueGbp > 0 && <p className="hint">£{data.revenueByService.unlinkedAcceptedValueGbp.toFixed(2)} of accepted quote value is not linked to a catalogue service and is not assigned to a category.</p>}
    <h2>Evidence-based recommendations</h2>
    {data.recommendations.map((item) => <section className="card" key={item.title} style={{ marginBottom: 12 }}><h3>{item.title}</h3><p>{item.evidence}</p><p><strong>Recommended next step:</strong> {item.action}</p></section>)}
    <h2>Metrics not yet measurable</h2>
    <dl className="detail-list">{Object.entries(data.unavailableMetrics).map(([name, reason]) => <div key={name} style={{ display: "contents" }}><dt>{name}</dt><dd>{reason}</dd></div>)}</dl>
  </div>;
}
