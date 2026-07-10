import { useEffect, useState } from "react";
import { api, ApiError, type LearningRule } from "../api/client";

// Learning Engine — every rule here was explicitly stated by a user, never
// inferred from a single weak signal, and stays visible, editable and
// reversible (archive, not delete). A rule with "Use as text substitution"
// filled in is also applied as a real alias before a command is parsed —
// e.g. "RAL" always resolves to "Riverside Apartments Ltd" before the
// system tries to match a client name.
export function LearningRules() {
  const [rules, setRules] = useState<LearningRule[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  function load() {
    api.learningRules
      .list()
      .then(setRules)
      .catch(() => setError("Could not load learning rules."));
  }

  useEffect(load, []);

  async function toggleArchived(rule: LearningRule) {
    try {
      await api.learningRules.update(rule.id, { status: rule.status === "active" ? "archived" : "active" });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not update rule.");
    }
  }

  if (error) return <div className="error-banner">{error}</div>;
  if (!rules) return <p>Loading…</p>;

  const visible = showArchived ? rules : rules.filter((r) => r.status === "active");

  return (
    <div>
      <div className="page-header">
        <h1>Learning</h1>
        <button onClick={() => setShowForm((v) => !v)}>{showForm ? "Cancel" : "Teach a rule"}</button>
      </div>
      <p className="hint">
        The strongest learning signal is an explicit correction, e.g. "when I say old client I
        mean a client from the last two years". A rule only changes how commands are
        interpreted if you set "Use as text substitution" — otherwise it's just a stored
        definition.
      </p>
      {showForm && (
        <NewRuleForm
          onCreated={() => {
            setShowForm(false);
            load();
          }}
        />
      )}
      <label style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
        Show archived rules
      </label>
      {visible.length === 0 ? (
        <p className="hint">No learning rules yet.</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Term</th>
              <th>Meaning</th>
              <th>Substitutes to</th>
              <th>Category</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <tr key={r.id}>
                <td>
                  {r.term}
                  {r.status === "archived" && <span className="hint"> (archived)</span>}
                </td>
                <td>{r.meaning}</td>
                <td>{r.aliasFor ?? <span className="hint">—</span>}</td>
                <td>{r.category ?? "—"}</td>
                <td>
                  <button onClick={() => toggleArchived(r)}>{r.status === "active" ? "Archive" : "Reactivate"}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function NewRuleForm({ onCreated }: { onCreated: () => void }) {
  const [term, setTerm] = useState("");
  const [meaning, setMeaning] = useState("");
  const [aliasFor, setAliasFor] = useState("");
  const [category, setCategory] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await api.learningRules.create({
        term,
        meaning,
        alias_for: aliasFor || undefined,
        category: category || undefined,
      });
      setTerm("");
      setMeaning("");
      setAliasFor("");
      setCategory("");
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create rule.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} style={{ marginBottom: 16 }}>
      <label>
        When I say
        <input placeholder='e.g. "old client" or "RAL"' value={term} onChange={(e) => setTerm(e.target.value)} required />
      </label>
      <label>
        I mean
        <input
          placeholder="the explanation, in your own words"
          value={meaning}
          onChange={(e) => setMeaning(e.target.value)}
          required
        />
      </label>
      <label>
        Use as text substitution (optional)
        <input
          placeholder='e.g. "Riverside Apartments Ltd" — leave blank to just store the meaning'
          value={aliasFor}
          onChange={(e) => setAliasFor(e.target.value)}
        />
      </label>
      <label>
        Category (optional)
        <input value={category} onChange={(e) => setCategory(e.target.value)} />
      </label>
      <button type="submit" disabled={submitting}>
        {submitting ? "Saving…" : "Save"}
      </button>
      {error && <div className="error-banner">{error}</div>}
    </form>
  );
}
