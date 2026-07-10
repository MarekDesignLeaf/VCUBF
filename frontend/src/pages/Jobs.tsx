import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type Job, JOB_STATUS_LABELS } from "../api/client";

export function Jobs() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.jobs
      .list()
      .then(setJobs)
      .catch(() => setError("Could not load jobs."))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div>
      <h1>Jobs</h1>
      {error && <div className="error-banner">{error}</div>}
      {loading ? (
        <p>Loading…</p>
      ) : jobs.length === 0 ? (
        <p className="hint">
          No jobs yet. Create a job from a client's detail page — every job must be linked
          to a real client (traceable origin, no orphan jobs).
        </p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Job</th>
              <th>Client</th>
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
                <td>
                  {j.client ? <Link to={`/clients/${j.client.id}`}>{j.client.displayName}</Link> : "—"}
                </td>
                <td>
                  <span className={`status-pill status-${j.jobStatus}`}>{JOB_STATUS_LABELS[j.jobStatus]}</span>
                </td>
                <td>{j.propertyAddress ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
