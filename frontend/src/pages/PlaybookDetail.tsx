import { useEffect, useMemo, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { api, ApiError, type Playbook, type PlaybookRun, type PlaybookRunPreview } from "../api/client";

const PLACEHOLDER_RE = /\{([a-zA-Z0-9_]+)\}/g;

function extractVariableNames(templates: string[]): string[] {
  const names = new Set<string>();
  for (const template of templates) {
    for (const match of template.matchAll(PLACEHOLDER_RE)) {
      names.add(match[1]);
    }
  }
  return Array.from(names);
}

export function PlaybookDetail() {
  const { id } = useParams<{ id: string }>();
  const [playbook, setPlaybook] = useState<Playbook | null>(null);
  const [runs, setRuns] = useState<PlaybookRun[]>([]);
  const [variables, setVariables] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<PlaybookRunPreview | null>(null);
  const [lastRun, setLastRun] = useState<PlaybookRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const variableNames = useMemo(() => (playbook ? extractVariableNames(playbook.stepTemplates) : []), [playbook]);

  function load() {
    if (!id) return;
    api.playbooks
      .get(id)
      .then(setPlaybook)
      .catch(() => setError("Playbook not found."));
    api.playbooks.runs(id).then(setRuns).catch(() => undefined);
  }

  useEffect(load, [id]);

  async function handlePreview(e: React.FormEvent) {
    e.preventDefault();
    if (!id) return;
    setError(null);
    setBusy(true);
    setLastRun(null);
    try {
      await api.playbooks.run(id, variables, false);
      // A 200 here would be unexpected (preview always returns 409 first),
      // but handle it defensively rather than assuming.
      setPreview(null);
    } catch (err) {
      if (err instanceof ApiError && err.code === "CONFIRMATION_REQUIRED") {
        setPreview((err.details?.preview as PlaybookRunPreview) ?? null);
      } else {
        setError(err instanceof ApiError ? err.message : "Could not preview playbook.");
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleConfirmRun() {
    if (!id) return;
    setError(null);
    setBusy(true);
    try {
      const run = await api.playbooks.run(id, variables, true);
      setLastRun(run);
      setPreview(null);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not run playbook.");
    } finally {
      setBusy(false);
    }
  }

  if (error && !playbook) return <div className="error-banner">{error}</div>;
  if (!playbook) return <p>Loading…</p>;

  return (
    <div>
      <Link to="/playbooks">← Back to playbooks</Link>
      <h1>{playbook.name}</h1>
      {error && <div className="error-banner">{error}</div>}
      <p className="hint">{playbook.description ?? "No description."}</p>

      <h2>Steps</h2>
      <ol>
        {playbook.stepTemplates.map((t, i) => (
          <li key={i}>
            <code>{t}</code>
          </li>
        ))}
      </ol>

      <h2>Run this playbook</h2>
      <form onSubmit={handlePreview}>
        {variableNames.length === 0 ? (
          <p className="hint">This playbook has no variables — it will run exactly as written.</p>
        ) : (
          variableNames.map((name) => (
            <label key={name}>
              {name}
              <input
                value={variables[name] ?? ""}
                onChange={(e) => setVariables((v) => ({ ...v, [name]: e.target.value }))}
                required
              />
            </label>
          ))
        )}
        <button type="submit" disabled={busy}>
          {busy ? "Working…" : "Preview steps"}
        </button>
      </form>

      {preview && (
        <div className="detail-list" style={{ marginTop: 12 }}>
          <h3>Preview — nothing has run yet</h3>
          <table className="data-table">
            <thead>
              <tr>
                <th>Template</th>
                <th>Resolved</th>
                <th>Interpreted as</th>
              </tr>
            </thead>
            <tbody>
              {preview.steps.map((s, i) => (
                <tr key={i}>
                  <td>
                    <code>{s.template}</code>
                  </td>
                  <td>{s.resolvedText}</td>
                  <td>{s.interpretedIntent}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <button onClick={handleConfirmRun} disabled={busy}>
            {busy ? "Running…" : "Confirm and run"}
          </button>
          <button type="button" onClick={() => setPreview(null)} disabled={busy}>
            Cancel
          </button>
        </div>
      )}

      {lastRun && (
        <div className="detail-list" style={{ marginTop: 12 }}>
          <h3>Run result — {lastRun.overallOk ? "completed" : "stopped on a failing step"}</h3>
          <table className="data-table">
            <thead>
              <tr>
                <th>Step</th>
                <th>Intent</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {lastRun.stepResults.map((s, i) => (
                <tr key={i}>
                  <td>{s.resolvedText}</td>
                  <td>{s.intent}</td>
                  <td>{s.ok ? "OK" : `Failed — ${s.error}${s.message ? `: ${s.message}` : ""}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>Run history</h2>
      {runs.length === 0 ? (
        <p className="hint">This playbook hasn't been run yet.</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>When</th>
              <th>Result</th>
              <th>Steps</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id}>
                <td>{new Date(r.createdAt).toLocaleString()}</td>
                <td>{r.overallOk ? "Completed" : "Failed"}</td>
                <td>{r.stepResults.length}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
