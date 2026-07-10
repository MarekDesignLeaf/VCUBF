import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { api, type Client, type Job, ApiError, JOB_STATUS_LABELS } from "../api/client";

export function ClientDetail() {
  const { id } = useParams<{ id: string }>();
  const [client, setClient] = useState<Client | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showJobForm, setShowJobForm] = useState(false);

  function loadClient() {
    if (!id) return;
    api.clients
      .get(id)
      .then(setClient)
      .catch(() => setError("Client not found."));
  }

  function loadJobs() {
    if (!id) return;
    api.jobs.list({ clientId: id }).then(setJobs).catch(() => {});
  }

  useEffect(() => {
    loadClient();
    loadJobs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (error) return <div className="error-banner">{error}</div>;
  if (!client) return <p>Loading…</p>;

  return (
    <div>
      <Link to="/clients">← Back to clients</Link>
      <h1>{client.displayName}</h1>
      <dl className="detail-list">
        <dt>Email</dt>
        <dd>{client.emailPrimary ?? "—"}</dd>
        <dt>Phone</dt>
        <dd>{client.phonePrimary ?? "—"}</dd>
        <dt>Type</dt>
        <dd>{client.clientType ?? "—"}</dd>
        <dt>Source</dt>
        <dd>{client.source ?? "manual"}</dd>
        <dt>Notes</dt>
        <dd>{client.notes ?? "—"}</dd>
      </dl>

      <div className="page-header">
        <h2>Jobs</h2>
        <button onClick={() => setShowJobForm((v) => !v)}>{showJobForm ? "Cancel" : "New job"}</button>
      </div>
      {showJobForm && id && (
        <NewJobForm
          clientId={id}
          onCreated={() => {
            setShowJobForm(false);
            loadJobs();
          }}
        />
      )}
      {jobs.length === 0 ? (
        <p className="hint">No jobs for this client yet.</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Job</th>
              <th>Status</th>
              <th>Address</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((j) => (
              <tr key={j.id}>
                <td>
                  <Link to={`/jobs/${j.id}`}>{j.jobTitle}</Link>
                </td>
                <td>{JOB_STATUS_LABELS[j.jobStatus]}</td>
                <td>{j.propertyAddress ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function NewJobForm({ clientId, onCreated }: { clientId: string; onCreated: () => void }) {
  const [jobTitle, setJobTitle] = useState("");
  const [address, setAddress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await api.jobs.create({
        client_id: clientId,
        job_title: jobTitle,
        property_address: address || undefined,
      });
      setJobTitle("");
      setAddress("");
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create job.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="inline-form" onSubmit={handleSubmit}>
      <input placeholder="Job title" value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} required />
      <input placeholder="Property address" value={address} onChange={(e) => setAddress(e.target.value)} />
      <button type="submit" disabled={submitting}>
        {submitting ? "Saving…" : "Save"}
      </button>
      {error && <div className="error-banner">{error}</div>}
    </form>
  );
}
