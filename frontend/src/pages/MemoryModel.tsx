import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type RepeatedActionPattern } from "../api/client";

// Memory Model — Pattern Detection (read-only foundation only).
//
// This is a different, lower-trust layer than the Learning Engine (the
// Learning page only ever creates a rule from an explicit user
// correction/statement). Here, a "pattern" is just a repeated sequence of
// manual actions found in the real Audit Log — a much weaker signal — so
// nothing on this page is ever auto-applied. See
// backend/src/services/memoryModelService.ts for the exact detection rule
// (last 30 days, same user, 2+ consecutive distinct actions, recurring at
// least 3 times). Nothing here creates a Playbook automatically; the
// convenience link below only prefills the real Playbook creation form on
// the Playbooks page so a human still reviews and explicitly saves it.
export function MemoryModel() {
  const [patterns, setPatterns] = useState<RepeatedActionPattern[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.memoryModel
      .patterns()
      .then(setPatterns)
      .catch(() => setError("Could not load detected action patterns."));
  }, []);

  if (error) return <div className="error-banner">{error}</div>;

  return (
    <div>
      <div className="page-header">
        <h1>Memory Model — Repeated Action Patterns</h1>
      </div>
      <p className="hint">
        Candidate patterns — review only, nothing created automatically. This scans the last 30
        days of your own audit log for sequences of two or more different actions that the same
        person performed together, back to back, at least 3 separate times. It is a much weaker
        signal than the Learning Engine (which only ever learns from an explicit correction you
        make), so nothing here is ever turned into a rule or a Playbook by itself. If a pattern
        below looks like a real repeated workflow, use "Build a playbook from this" to prefill a
        real Playbook on the Playbook Engine page — you still review and save it yourself.
      </p>

      {!patterns ? (
        <p>Loading…</p>
      ) : patterns.length === 0 ? (
        <p className="hint">No repeated action pattern has recurred at least 3 times in the last 30 days.</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Action sequence</th>
              <th>Occurrences</th>
              <th>Example timestamps</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {patterns.map((p) => {
              const sequenceLabel = p.actionSequence.join(" → ");
              const prefillName = `Playbook: ${p.actionSequence.join(" then ")}`;
              const prefillSteps = p.actionSequence.join("\n");
              const query = new URLSearchParams({
                prefill_name: prefillName,
                prefill_steps: prefillSteps,
              }).toString();
              return (
                <tr key={p.actionSequence.join(">")}>
                  <td>
                    <code>{sequenceLabel}</code>
                  </td>
                  <td>{p.occurrenceCount}</td>
                  <td className="hint">
                    {p.exampleTimestamps.map((t) => new Date(t).toLocaleString()).join(", ")}
                  </td>
                  <td>
                    <Link to={`/playbooks?${query}`}>Build a playbook from this</Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
