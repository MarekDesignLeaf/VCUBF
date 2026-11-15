import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError, type Client } from "../api/client";
import { PermanentDeletePanel } from "../components/PermanentDeletePanel";

export function Clients() {
  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [deleting, setDeleting] = useState<Client | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function reload() {
    setLoading(true);
    api.clients
      .list(showArchived ? "archived" : "active")
      .then(setClients)
      .catch(() => setError("Could not load clients."))
      .finally(() => setLoading(false));
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(reload, [showArchived]);

  return (
    <div>
      <div className="page-header">
        <h1>Clients</h1>
        <button onClick={() => setShowForm((v) => !v)}>{showForm ? "Cancel" : "New client"}</button>
      </div>
      {showForm && (
        <NewClientForm
          onCreated={() => {
            setShowForm(false);
            reload();
          }}
        />
      )}
      {error && <div className="error-banner">{error}</div>}
      {notice && <div className="success-banner">{notice}</div>}
      <div className="inline-form" style={{ marginTop: 16 }}>
        <label className="checkbox-label">
          <input type="checkbox" checked={showArchived} onChange={(event) => { setShowArchived(event.target.checked); setDeleting(null); }} /> Show archived clients
        </label>
      </div>
      {deleting ? (
        <PermanentDeletePanel
          key={deleting.id}
          load={() => api.clients.permanentDeletionPreview(deleting.id)}
          remove={(confirmation, key) => api.clients.deletePermanently(deleting.id, confirmation, key)}
          onDeleted={(message) => { setDeleting(null); setNotice(message); reload(); }}
          onClose={() => setDeleting(null)}
        />
      ) : null}
      {loading ? (
        <p>Loading…</p>
      ) : clients.length === 0 ? (
        showArchived
          ? <p className="hint">No archived clients.</p>
          : <p className="hint">No clients yet. CRM Core is empty — data must come from real sources, nothing is invented.</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Phone</th>
              <th>Source</th>
              {showArchived ? <th></th> : null}
            </tr>
          </thead>
          <tbody>
            {clients.map((c) => (
              <tr key={c.id}>
                <td>
                  {showArchived ? <strong>{c.displayName}</strong> : <Link to={`/clients/${c.id}`}>{c.displayName}</Link>}
                </td>
                <td>{c.emailPrimary ?? "—"}</td>
                <td>{c.phonePrimary ?? "—"}</td>
                <td>{c.source ?? "manual"}</td>
                {showArchived ? (
                  <td>
                    <button type="button" className="danger-button" data-action="client-permanent-delete" onClick={() => setDeleting(c)}>
                      Delete permanently…
                    </button>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function NewClientForm({ onCreated }: { onCreated: () => void }) {
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await api.clients.create({
        display_name: displayName,
        email_primary: email || undefined,
        phone_primary: phone || undefined,
      });
      setDisplayName("");
      setEmail("");
      setPhone("");
      onCreated();
    } catch (err) {
      if (err instanceof ApiError && err.code === "DUPLICATE_CLIENT_POSSIBLE") {
        setError("A client with this email or name+phone already exists — CRM Core rejected the duplicate.");
      } else if (err instanceof ApiError && err.code === "EMAIL_BELONGS_TO_USER") {
        setError("This email belongs to a Secretary user and cannot also be assigned to a client.");
      } else if (err instanceof ApiError && err.code === "VALIDATION_FAILED") {
        setError(err.message || "Check the email address and use a valid UK or international phone number.");
      } else {
        setError(err instanceof ApiError ? err.message : "Could not create client.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="inline-form" onSubmit={handleSubmit}>
      <input placeholder="Display name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} required />
      <input placeholder="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      <input type="tel" inputMode="tel" autoComplete="tel" maxLength={40} title="Use a UK number such as 07700 900123 or an international number beginning with +" placeholder="Phone, e.g. 07700 900123" value={phone} onChange={(e) => setPhone(e.target.value)} />
      <button type="submit" disabled={submitting}>
        {submitting ? "Saving…" : "Save"}
      </button>
      {error && <div className="error-banner">{error}</div>}
    </form>
  );
}
