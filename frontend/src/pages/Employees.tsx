import { useEffect, useState } from "react";
import { api, type Employee } from "../api/client";

// Job Allocation and Capacity Management Module — read-only view of who
// exists and their real current-week workload, computed from actual job
// data (not from whether their calendar looks empty).
export function Employees() {
  const [employees, setEmployees] = useState<Employee[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.employees
      .list()
      .then(setEmployees)
      .catch(() => setError("Could not load employees."));
  }, []);

  if (error) return <div className="error-banner">{error}</div>;
  if (!employees) return <p>Loading…</p>;

  return (
    <div>
      <div className="page-header">
        <h1>Employees</h1>
      </div>
      <p className="hint">
        Workload is computed from jobs assigned to each person this week (with a planned date and an
        estimated duration) against their declared weekly capacity — not from empty calendar slots.
      </p>
      <table className="data-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Role</th>
            <th>Skills</th>
            <th>This week's load</th>
          </tr>
        </thead>
        <tbody>
          {employees.map((e) => {
            const cap = e.capacity;
            const pct = cap ? Math.min(cap.utilizationPct, 100) : 0;
            return (
              <tr key={e.id}>
                <td>{e.displayName}</td>
                <td>{e.role}</td>
                <td>
                  {e.skills.length === 0 ? (
                    <span className="hint">—</span>
                  ) : (
                    e.skills.map((s) => (
                      <span className="skill-tag" key={s}>
                        {s}
                      </span>
                    ))
                  )}
                </td>
                <td>
                  {cap ? (
                    <>
                      <div className="capacity-bar-track">
                        <div
                          className={`capacity-bar-fill${cap.overloaded ? " overloaded" : ""}`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <div className="capacity-text">
                        {cap.currentLoadHours}h / {cap.weeklyCapacityHours}h ({cap.utilizationPct}%)
                        {cap.overloaded && " — overloaded"}
                        {cap.jobsMissingEstimate > 0 &&
                          ` — ${cap.jobsMissingEstimate} job(s) missing an estimate`}
                      </div>
                    </>
                  ) : (
                    <span className="hint">—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
