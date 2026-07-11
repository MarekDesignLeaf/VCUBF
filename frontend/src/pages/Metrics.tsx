import { useEffect, useState } from "react";
import { api, type MetricsOverview } from "../api/client";

function value(value: number | null, suffix = "") {
  return value == null ? "Unknown" : `${value}${suffix}`;
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
    <h2>Lead sources</h2>
    {data.leads.sources.length ? <table className="data-table"><thead><tr><th>Source</th><th>Leads</th></tr></thead><tbody>{data.leads.sources.map((row) => <tr key={row.source}><td>{row.source}</td><td>{row.count}</td></tr>)}</tbody></table> : <p className="hint">No leads in this period.</p>}
    <h2>Evidence-based recommendations</h2>
    {data.recommendations.map((item) => <section className="card" key={item.title} style={{ marginBottom: 12 }}><h3>{item.title}</h3><p>{item.evidence}</p><p><strong>Recommended next step:</strong> {item.action}</p></section>)}
    <h2>Metrics not yet measurable</h2>
    <dl className="detail-list">{Object.entries(data.unavailableMetrics).map(([name, reason]) => <div key={name} style={{ display: "contents" }}><dt>{name}</dt><dd>{reason}</dd></div>)}</dl>
  </div>;
}
