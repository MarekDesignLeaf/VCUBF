import { useEffect, useState } from "react";
import { api, type MetricsOverview } from "../api/client";

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
  useEffect(() => { api.metrics.overview().then(setData).catch(() => setError("Could not load business metrics.")); }, []);
  if (error) return <div className="error-banner">{error}</div>;
  if (!data) return <p>Loading…</p>;
  return <div>
    <h1>Business Metrics</h1>
    <p className="hint">Measured from saved records for the last {data.period.days} days. Unknown metrics stay unknown rather than being estimated.</p>
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
    <h2>Lead sources</h2>
    {data.leads.sources.length ? <table className="data-table"><thead><tr><th>Source</th><th>Leads</th></tr></thead><tbody>{data.leads.sources.map((row) => <tr key={row.source}><td>{row.source}</td><td>{row.count}</td></tr>)}</tbody></table> : <p className="hint">No leads in this period.</p>}
    <h2>Accepted quote value by service</h2>
    <p className="hint">{data.revenueByService.basis}</p>
    {data.revenueByService.rows.length ? <table className="data-table"><thead><tr><th>Service</th><th>Linked lines</th><th>Accepted value</th></tr></thead><tbody>{data.revenueByService.rows.map((row) => <tr key={row.serviceId}><td>{row.serviceName}</td><td>{row.lineCount}</td><td>£{row.acceptedValueGbp.toFixed(2)}</td></tr>)}</tbody></table> : <p className="hint">No accepted quote lines are linked to catalogue services in this period.</p>}
    {data.revenueByService.unlinkedAcceptedValueGbp > 0 && <p className="hint">£{data.revenueByService.unlinkedAcceptedValueGbp.toFixed(2)} of accepted quote value is not linked to a catalogue service and is not assigned to a category.</p>}
    <h2>Evidence-based recommendations</h2>
    {data.recommendations.map((item) => <section className="card" key={item.title} style={{ marginBottom: 12 }}><h3>{item.title}</h3><p>{item.evidence}</p><p><strong>Recommended next step:</strong> {item.action}</p></section>)}
    <h2>Metrics not yet measurable</h2>
    <dl className="detail-list">{Object.entries(data.unavailableMetrics).map(([name, reason]) => <div key={name} style={{ display: "contents" }}><dt>{name}</dt><dd>{reason}</dd></div>)}</dl>
  </div>;
}
