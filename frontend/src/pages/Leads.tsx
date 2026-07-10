import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError, type Lead, LEAD_STATUS_LABELS } from "../api/client";

export function Leads() {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  function reload() {
    setLoading(true);
    api.leads
      .list()
      .then(setLeads)
      .catch(() => setError("Could not load leads."))
      .finally(() => setLoading(false));
  }

  useEffect(reload, []);

  return (
    <div>
      <div className="page-header">
        <h1>Leads</h1>
        <button onClick={() => setShowForm((v) => !v)}>{showForm ? "Cancel" : "New lead"}</button>
      </div>
      {showForm && (
        <NewLeadForm
          onCreated={() => {
            setShowForm(false);
            reload();
          }}
        />
      )}
      {error && <div className="error-banner">{error}</div>}
      {loading ? (
        <p>Loading…</p>
      ) : leads.length === 0 ? (
        <p className="hint">No leads yet. New enquiries land here before they become clients.</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Service</th>
              <th>Status</th>
              <th>Source</th>
            </tr>
          </thead>
          <tbody>
            {leads.map((l) => (
              <tr key={l.id}>
                <td>
                  <Link to={`/leads/${l.id}`}>{l.name}</Link>
                </td>
                <td>{l.serviceRequested ?? "—"}</td>
                <td>{LEAD_STATUS_LABELS[l.leadStatus]}</td>
                <td>{l.source ?? "manual"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function NewLeadForm({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [service, setService] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await api.leads.create({
        name,
        email: email || undefined,
        phone: phone || undefined,
        service_requested: service || undefined,
      });
      setName("");
      setEmail("");
      setPhone("");
      setService("");
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create lead.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="inline-form" onSubmit={handleSubmit}>
      <input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} required />
      <input placeholder="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      <input placeholder="Phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
      <input placeholder="Service requested" value={service} onChange={(e) => setService(e.target.value)} />
      <button type="submit" disabled={submitting}>
        {submitting ? "Saving…" : "Save"}
      </button>
      {error && <div className="error-banner">{error}</div>}
    </form>
  );
}
