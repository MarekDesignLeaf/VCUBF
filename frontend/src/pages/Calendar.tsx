import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type Job, type OverloadReport, JOB_STATUS_LABELS } from "../api/client";

// Calendar and Scheduling Intelligence Module — an agenda of real planned
// jobs for the next 4 weeks, plus an upfront overload warning computed from
// real workload data (never from whether the calendar looks empty).
export function Calendar() {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [overload, setOverload] = useState<OverloadReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const from = new Date();
    from.setUTCHours(0, 0, 0, 0);
    const to = new Date(from);
    to.setUTCDate(to.getUTCDate() + 28);

    Promise.all([api.calendar.jobs(from.toISOString(), to.toISOString()), api.calendar.overload(4)])
      .then(([jobsRes, overloadRes]) => {
        setJobs(jobsRes);
        setOverload(overloadRes);
      })
      .catch(() => setError("Could not load the calendar."));
  }, []);

  if (error) return <div className="error-banner">{error}</div>;
  if (!jobs || !overload) return <p>Loading…</p>;

  const grouped = groupByDate(jobs);

  return (
    <div>
      <h1>Calendar</h1>
      <p className="hint">Next 4 weeks — planned jobs computed from real data.</p>

      {overload.overloadedWeeks.length > 0 && (
        <div className="warning-banner" style={{ marginBottom: 20 }}>
          <strong>Capacity warning:</strong> {overload.overloadedWeeks.length} employee-week(s) over capacity in the
          next {overload.weeksAhead} weeks.
          <ul>
            {overload.overloadedWeeks.map((w, i) => (
              <li key={i}>
                {w.employeeName}: {w.currentLoadHours}h / {w.weeklyCapacityHours}h (week of{" "}
                {new Date(w.weekStart).toLocaleDateString()})
              </li>
            ))}
          </ul>
          <details>
            <summary>Suggested options</summary>
            <ul>
              {overload.suggestions.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          </details>
        </div>
      )}

      {Object.keys(grouped).length === 0 ? (
        <p className="hint">No jobs planned in the next 4 weeks.</p>
      ) : (
        Object.entries(grouped).map(([date, dayJobs]) => (
          <div key={date} style={{ marginBottom: 16 }}>
            <h2>{new Date(date).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })}</h2>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Job</th>
                  <th>Client</th>
                  <th>Status</th>
                  <th>Assigned to</th>
                </tr>
              </thead>
              <tbody>
                {dayJobs.map((j) => (
                  <tr key={j.id}>
                    <td>
                      <Link to={`/jobs/${j.id}`}>{j.jobTitle}</Link>
                    </td>
                    <td>{j.client?.displayName ?? "—"}</td>
                    <td>{JOB_STATUS_LABELS[j.jobStatus]}</td>
                    <td>{j.assignedUser?.displayName ?? <span className="hint">Unassigned</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))
      )}
    </div>
  );
}

function groupByDate(jobs: Job[]): Record<string, Job[]> {
  const groups: Record<string, Job[]> = {};
  for (const job of jobs) {
    if (!job.plannedStartAt) continue;
    const dateKey = job.plannedStartAt.slice(0, 10);
    if (!groups[dateKey]) groups[dateKey] = [];
    groups[dateKey].push(job);
  }
  return groups;
}
