import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { api, type Client, type Job, type ServiceCatalogueItem, ApiError, JOB_STATUS_LABELS } from "../api/client";

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
        <div style={{ display: "flex", gap: 12 }}>
          {id && <Link to={`/quotes/new?client_id=${id}`}>New quote</Link>}
          <button onClick={() => setShowJobForm((v) => !v)}>{showJobForm ? "Cancel" : "New job"}</button>
        </div>
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
  const [services, setServices] = useState<ServiceCatalogueItem[]>([]);
  const [serviceId, setServiceId] = useState("");
  const [jobTitle, setJobTitle] = useState("");
  const [address, setAddress] = useState("");
  const [plannedStart, setPlannedStart] = useState("");
  const [estimatedHours, setEstimatedHours] = useState("");
  const [requiredSkills, setRequiredSkills] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api.catalogue.list(true).then(setServices).catch(() => undefined);
  }, []);

  function handleServiceSelect(id: string) {
    setServiceId(id);
    const service = services.find((s) => s.id === id);
    if (!service) return;
    if (!jobTitle) setJobTitle(service.name);
    if (!estimatedHours && service.defaultDurationHours != null) {
      setEstimatedHours(String(service.defaultDurationHours));
    }
    if (!requiredSkills && service.defaultRequiredSkills.length > 0) {
      setRequiredSkills(service.defaultRequiredSkills.join(", "));
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await api.jobs.create({
        client_id: clientId,
        job_title: jobTitle,
        property_address: address || undefined,
        planned_start_at: plannedStart ? new Date(plannedStart).toISOString() : undefined,
        estimated_duration_hours: estimatedHours ? Number(estimatedHours) : undefined,
        required_skills: requiredSkills
          ? requiredSkills.split(",").map((s) => s.trim()).filter(Boolean)
          : undefined,
        service_catalogue_item_id: serviceId || undefined,
      });
      setJobTitle("");
      setAddress("");
      setPlannedStart("");
      setEstimatedHours("");
      setRequiredSkills("");
      setServiceId("");
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create job.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="inline-form" onSubmit={handleSubmit}>
      {services.length > 0 && (
        <select value={serviceId} onChange={(e) => handleServiceSelect(e.target.value)}>
          <option value="">— Based on a service (optional) —</option>
          {services.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      )}
      <input placeholder="Job title" value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} required />
      <input placeholder="Property address" value={address} onChange={(e) => setAddress(e.target.value)} />
      <input type="datetime-local" value={plannedStart} onChange={(e) => setPlannedStart(e.target.value)} />
      <input
        placeholder="Est. hours"
        type="number"
        min="0"
        step="0.5"
        style={{ width: 90 }}
        value={estimatedHours}
        onChange={(e) => setEstimatedHours(e.target.value)}
      />
      <input
        placeholder="Required skills (comma-separated)"
        value={requiredSkills}
        onChange={(e) => setRequiredSkills(e.target.value)}
      />
      <button type="submit" disabled={submitting}>
        {submitting ? "Saving…" : "Save"}
      </button>
      {error && <div className="error-banner">{error}</div>}
    </form>
  );
}
