import { useEffect, useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { api, ApiError, type Lead, LEAD_STATUS_LABELS } from "../api/client";

export function LeadDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [lead, setLead] = useState<Lead | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [converting, setConverting] = useState(false);

  function load() {
    if (!id) return;
    api.leads
      .get(id)
      .then(setLead)
      .catch(() => setError("Lead not found."));
  }

  useEffect(load, [id]);

  async function handleConvert() {
    if (!lead) return;
    setConverting(true);
    setError(null);
    try {
      const res = await api.leads.convert(lead.id);
      navigate(`/clients/${res.client.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not convert lead.");
      setConverting(false);
    }
  }

  if (error && !lead) return <div className="error-banner">{error}</div>;
  if (!lead) return <p>Loading…</p>;

  return (
    <div>
      <Link to="/leads">← Back to leads</Link>
      <h1>{lead.name}</h1>
      {error && <div className="error-banner">{error}</div>}
      <dl className="detail-list">
        <dt>Status</dt>
        <dd>{LEAD_STATUS_LABELS[lead.leadStatus]}</dd>
        <dt>Email</dt>
        <dd>{lead.email ?? "—"}</dd>
        <dt>Phone</dt>
        <dd>{lead.phone ?? "—"}</dd>
        <dt>Service</dt>
        <dd>{lead.serviceRequested ?? "—"}</dd>
        <dt>Location</dt>
        <dd>{lead.location ?? "—"}</dd>
        <dt>Source</dt>
        <dd>{lead.source ?? "manual"}</dd>
        <dt>Notes</dt>
        <dd>{lead.notes ?? "—"}</dd>
      </dl>
      {lead.leadStatus === "converted" && lead.convertedClientId ? (
        <p className="hint">
          Already converted to <Link to={`/clients/${lead.convertedClientId}`}>client</Link>.
        </p>
      ) : (
        <button onClick={handleConvert} disabled={converting}>
          {converting ? "Converting…" : "Convert to client"}
        </button>
      )}
    </div>
  );
}
