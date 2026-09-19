import { useEffect, useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { api, ApiError, type Lead, type LeadStatus, LEAD_STATUS_LABELS } from "../api/client";

export function LeadDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [lead, setLead] = useState<Lead | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [converting, setConverting] = useState(false);
  const [editing, setEditing] = useState(false);

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
      <div className="page-header">
        <h1>{lead.name}</h1>
        {!editing && (
          <button className="secondary" data-action="lead-edit" onClick={() => setEditing(true)}>
            Edit lead
          </button>
        )}
      </div>
      {error && <div className="error-banner">{error}</div>}
      {editing ? (
        <LeadEditor
          lead={lead}
          onSaved={() => { setEditing(false); load(); }}
          onCancel={() => setEditing(false)}
        />
      ) : (
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
      )}
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

/**
 * A lead, corrected in place.
 *
 * Two fields are missing on purpose. `source` records where the enquiry came from
 * and is not retypable, because provenance anyone can edit answers nothing. The
 * status list stops at "lost": "converted" means a client record exists, and only
 * the Convert button creates one.
 *
 * A converted lead can still have its details corrected — a typo in a phone number
 * is worth fixing whether or not the lead became a client — but its status is then
 * fixed, and the backend refuses to change it.
 */
function LeadEditor({ lead, onSaved, onCancel }: { lead: Lead; onSaved: () => void; onCancel: () => void }) {
  const [name, setName] = useState(lead.name);
  const [email, setEmail] = useState(lead.email ?? "");
  const [phone, setPhone] = useState(lead.phone ?? "");
  const [service, setService] = useState(lead.serviceRequested ?? "");
  const [location, setLocation] = useState(lead.location ?? "");
  const [urgency, setUrgency] = useState(lead.urgency ?? "");
  const [notes, setNotes] = useState(lead.notes ?? "");
  const [status, setStatus] = useState<LeadStatus>(lead.leadStatus);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const converted = lead.leadStatus === "converted";

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      await api.leads.update(lead.id, {
        name,
        // Cleared fields are sent as null so a wrong value can be removed, not
        // merely overwritten with another wrong value.
        email: email.trim() || null,
        phone: phone.trim() || null,
        service_requested: service.trim() || null,
        location: location.trim() || null,
        urgency: urgency.trim() || null,
        notes: notes.trim() || null,
        // A converted lead keeps its status; sending it would be rejected anyway.
        ...(converted ? {} : { lead_status: status }),
      });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save lead.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="detail-list">
      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} required />
      </label>
      <label>
        Email
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      </label>
      <label>
        Phone
        <input
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          maxLength={40}
          title="Use a UK number such as 07700 900123 or an international number beginning with +"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
        />
      </label>
      <label>
        Service requested
        <input value={service} onChange={(e) => setService(e.target.value)} />
      </label>
      <label>
        Location
        <input value={location} onChange={(e) => setLocation(e.target.value)} />
      </label>
      <label>
        Urgency
        <input value={urgency} onChange={(e) => setUrgency(e.target.value)} />
      </label>
      <label>
        Status
        {converted ? (
          <span> {LEAD_STATUS_LABELS.converted} — fixed, the client record already exists</span>
        ) : (
          <select value={status} onChange={(e) => setStatus(e.target.value as LeadStatus)}>
            {(["new", "contacted", "qualified", "lost"] as const).map((value) => (
              <option key={value} value={value}>{LEAD_STATUS_LABELS[value]}</option>
            ))}
          </select>
        )}
      </label>
      <label>
        Notes
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} style={{ width: "100%" }} />
      </label>
      <p className="hint">Source: {lead.source ?? "manual"} (recorded when the lead arrived, not editable)</p>
      <div className="inline-form">
        <button type="submit" data-action="lead-save" disabled={saving}>
          {saving ? "Saving\u2026" : "Save lead"}
        </button>
        <button type="button" className="secondary" data-action="lead-cancel" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </div>
      {error && <div className="error-banner">{error}</div>}
    </form>
  );
}
