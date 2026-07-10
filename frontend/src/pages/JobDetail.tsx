import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { api, type Job, JOB_STATUSES, JOB_STATUS_LABELS, ApiError } from "../api/client";

export function JobDetail() {
  const { id } = useParams<{ id: string }>();
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updating, setUpdating] = useState(false);

  function load() {
    if (!id) return;
    api.jobs
      .get(id)
      .then(setJob)
      .catch(() => setError("Job not found."));
  }

  useEffect(load, [id]);

  async function handleStatusChange(e: React.ChangeEvent<HTMLSelectElement>) {
    if (!job) return;
    const newStatus = e.target.value as Job["jobStatus"];
    setUpdating(true);
    setError(null);
    try {
      const updated = await api.jobs.changeStatus(job.id, newStatus);
      setJob(updated);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not change status.");
    } finally {
      setUpdating(false);
    }
  }

  if (error && !job) return <div className="error-banner">{error}</div>;
  if (!job) return <p>Loading…</p>;

  return (
    <div>
      <Link to="/jobs">← Back to jobs</Link>
      <h1>{job.jobTitle}</h1>
      {error && <div className="error-banner">{error}</div>}
      <dl className="detail-list">
        <dt>Client</dt>
        <dd>
          {job.client ? <Link to={`/clients/${job.client.id}`}>{job.client.displayName}</Link> : "—"}
        </dd>
        <dt>Status</dt>
        <dd>
          <select value={job.jobStatus} onChange={handleStatusChange} disabled={updating}>
            {JOB_STATUSES.map((s) => (
              <option key={s} value={s}>
                {JOB_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </dd>
        <dt>Address</dt>
        <dd>{job.propertyAddress ?? "—"}</dd>
        <dt>Notes</dt>
        <dd>{job.notes ?? "—"}</dd>
      </dl>
    </div>
  );
}
