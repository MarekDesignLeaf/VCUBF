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
  const [editing, setEditing] = useState(false);

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

      <div className="page-header">
        <h2>Steps</h2>
        {!editing && (
          <button className="secondary" data-action="playbook-edit" onClick={() => setEditing(true)}>
            Edit playbook
          </button>
        )}
      </div>
      {editing ? (
        <PlaybookEditor
          playbook={playbook}
          onSaved={() => { setEditing(false); load(); }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <ol>
          {playbook.stepTemplates.map((t, i) => (
            <li key={i}>
              <code>{t}</code>
            </li>
          ))}
        </ol>
      )}

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

/**
 * A playbook, edited in place.
 *
 * Steps are one per line. Blank lines are dropped rather than saved as empty steps,
 * because the backend requires every step to be non-empty and a stray newline is
 * not something the user meant to type.
 *
 * Editing a playbook does not touch its run history: past runs record what was
 * actually executed, and rewriting them to match the new text would be a lie.
 */
function PlaybookEditor({
  playbook,
  onSaved,
  onCancel,
}: {
  playbook: Playbook;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(playbook.name);
  const [description, setDescription] = useState(playbook.description ?? "");
  const [stepText, setStepText] = useState(playbook.stepTemplates.join("\n"));
  const [isActive, setIsActive] = useState(playbook.isActive);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const steps = stepText.split("\n").map((line) => line.trim()).filter(Boolean);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (steps.length === 0) {
      setError("A playbook needs at least one step.");
      return;
    }
    setSaving(true);
    try {
      await api.playbooks.update(playbook.id, {
        name,
        description,
        step_templates: steps,
        is_active: isActive,
      });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save playbook.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="detail-list" style={{ marginTop: 12 }}>
      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} required />
      </label>
      <label>
        Description
        <input value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <label>
        Steps — one per line
        <textarea
          value={stepText}
          onChange={(e) => setStepText(e.target.value)}
          rows={Math.max(4, steps.length + 2)}
          style={{ width: "100%", fontFamily: "monospace" }}
        />
      </label>
      <p className="hint">
        {steps.length} step{steps.length === 1 ? "" : "s"}. Use {"{name}"} for a value filled in at run time.
        Past runs keep what was actually executed and are not rewritten.
      </p>
      <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
        Active
      </label>
      <div className="inline-form">
        <button type="submit" data-action="playbook-save" disabled={saving}>
          {saving ? "Saving\u2026" : "Save playbook"}
        </button>
        <button type="button" className="secondary" data-action="playbook-cancel" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </div>
      {error && <div className="error-banner">{error}</div>}
    </form>
  );
}
