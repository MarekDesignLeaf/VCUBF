import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, ApiError, type Playbook } from "../api/client";

// Playbook Engine — a saved, reusable sequence of Voice/Text Command Layer
// templates (the same syntax you could type into the command bar, with
// {placeholder} variables). Nothing here executes on its own; running a
// playbook always shows a preview of every resolved step first.
export function Playbooks() {
  const [playbooks, setPlaybooks] = useState<Playbook[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searchParams] = useSearchParams();
  // Prefill support (e.g. from the Memory Model page's "use this pattern as
  // a playbook" link): a candidate pattern can prefill the name/steps for
  // human review here, but nothing is ever created without the user
  // explicitly clicking Save on this form.
  const prefillName = searchParams.get("prefill_name") ?? "";
  const prefillSteps = searchParams.get("prefill_steps") ?? "";
  const [showForm, setShowForm] = useState(Boolean(prefillName || prefillSteps));

  function load() {
    api.playbooks
      .list()
      .then(setPlaybooks)
      .catch(() => setError("Could not load playbooks."));
  }

  useEffect(load, []);

  if (error) return <div className="error-banner">{error}</div>;
  if (!playbooks) return <p>Loading…</p>;

  return (
    <div>
      <div className="page-header">
        <h1>Playbooks</h1>
        <button onClick={() => setShowForm((v) => !v)}>{showForm ? "Cancel" : "New playbook"}</button>
      </div>
      <p className="hint">
        Each step is a command-bar template, e.g. <code>create job {"{job_title}"} for {"{client_name}"}</code>.
        Running a playbook resolves the placeholders and shows you exactly what would run before
        anything executes.
      </p>
      {showForm && (
        <NewPlaybookForm
          initialName={prefillName}
          initialStepsText={prefillSteps}
          onCreated={() => {
            setShowForm(false);
            load();
          }}
        />
      )}
      {playbooks.length === 0 ? (
        <p className="hint">No playbooks yet.</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Steps</th>
              <th>Description</th>
            </tr>
          </thead>
          <tbody>
            {playbooks.map((p) => (
              <tr key={p.id}>
                <td>
                  <Link to={`/playbooks/${p.id}`}>{p.name}</Link>
                  {!p.isActive && <span className="hint"> (inactive)</span>}
                </td>
                <td>{p.stepTemplates.length}</td>
                <td>{p.description ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function NewPlaybookForm({
  onCreated,
  initialName = "",
  initialStepsText = "",
}: {
  onCreated: () => void;
  initialName?: string;
  initialStepsText?: string;
}) {
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState("");
  const [stepsText, setStepsText] = useState(initialStepsText);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const step_templates = stepsText
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (step_templates.length === 0) {
      setError("Add at least one step.");
      return;
    }
    setSubmitting(true);
    try {
      await api.playbooks.create({ name, description: description || undefined, step_templates });
      setName("");
      setDescription("");
      setStepsText("");
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create playbook.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} style={{ marginBottom: 16 }}>
      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} required />
      </label>
      <label>
        Description
        <input value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <label>
        Steps — one command-bar template per line, use {"{placeholders}"} for variables
        <textarea
          rows={4}
          placeholder={"create client {client_name}\ncreate job {job_title} for {client_name}"}
          value={stepsText}
          onChange={(e) => setStepsText(e.target.value)}
        />
      </label>
      <button type="submit" disabled={submitting}>
        {submitting ? "Saving…" : "Save"}
      </button>
      {error && <div className="error-banner">{error}</div>}
    </form>
  );
}
