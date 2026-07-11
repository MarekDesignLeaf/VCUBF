import { useEffect, useState } from "react";
import {
  api,
  ApiError,
  BUSINESS_CONTEXT_CATEGORIES,
  BUSINESS_CONTEXT_CATEGORY_LABELS,
  BUSINESS_CONTEXT_SOURCES,
  BUSINESS_CONTEXT_SOURCE_LABELS,
  BUSINESS_CONTEXT_VERIFICATION_STATUSES,
  BUSINESS_CONTEXT_VERIFICATION_LABELS,
  type BusinessContextCategory,
  type BusinessContextItem,
  type BusinessContextSource,
  type BusinessContextVerificationStatus,
} from "../api/client";

// Business Context Layer — this page records explicit company facts/rules
// for future Website, Business Growth and Communication workflows. It does
// not generate claims or publish anything; every item is typed in by a user
// and marked with source + verification status so downstream modules can
// avoid using unverified context as a confirmed fact.
export function BusinessContext() {
  const [items, setItems] = useState<BusinessContextItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [categoryFilter, setCategoryFilter] = useState("");
  const [activeOnly, setActiveOnly] = useState(true);

  function load() {
    api.businessContext
      .list({ category: categoryFilter || undefined, activeOnly })
      .then(setItems)
      .catch(() => setError("Could not load business context."));
  }

  useEffect(load, [categoryFilter, activeOnly]);

  async function archive(item: BusinessContextItem) {
    await api.businessContext.update(item.id, { is_active: false });
    load();
  }

  if (error) return <div className="error-banner">{error}</div>;

  return (
    <div>
      <div className="page-header">
        <h1>Business Context</h1>
        <button onClick={() => setShowForm((v) => !v)}>{showForm ? "Cancel" : "Add context"}</button>
      </div>
      <p className="hint">
        Structured company knowledge for Secretary. Store only real facts, rules and notes you can
        source or verify. This module does not generate marketing claims, send messages or publish
        website content; it only gives later workflows a safe source of company context.
      </p>

      {showForm && (
        <BusinessContextForm
          onCreated={() => {
            setShowForm(false);
            load();
          }}
        />
      )}

      <div className="inline-form" style={{ marginTop: 16 }}>
        <select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)}>
          <option value="">All categories</option>
          {BUSINESS_CONTEXT_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {BUSINESS_CONTEXT_CATEGORY_LABELS[c]}
            </option>
          ))}
        </select>
        <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <input type="checkbox" checked={activeOnly} onChange={(e) => setActiveOnly(e.target.checked)} />
          Active only
        </label>
      </div>

      {!items ? (
        <p>Loading…</p>
      ) : items.length === 0 ? (
        <p className="hint">No business context recorded yet.</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Category</th>
              <th>Label</th>
              <th>Value</th>
              <th>Source</th>
              <th>Verification</th>
              <th>Status</th>
              <th>Notes</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td>{BUSINESS_CONTEXT_CATEGORY_LABELS[item.category]}</td>
                <td>{item.label}</td>
                <td>{item.value}</td>
                <td>{BUSINESS_CONTEXT_SOURCE_LABELS[item.source]}</td>
                <td>{BUSINESS_CONTEXT_VERIFICATION_LABELS[item.verificationStatus]}</td>
                <td>{item.isActive ? "Active" : "Archived"}</td>
                <td>{item.notes ?? "—"}</td>
                <td>
                  {item.isActive && (
                    <button className="secondary" onClick={() => archive(item)}>
                      Archive
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function BusinessContextForm({ onCreated }: { onCreated: () => void }) {
  const [category, setCategory] = useState<BusinessContextCategory>("company_profile");
  const [label, setLabel] = useState("");
  const [value, setValue] = useState("");
  const [source, setSource] = useState<BusinessContextSource>("user_input");
  const [verificationStatus, setVerificationStatus] =
    useState<BusinessContextVerificationStatus>("user_entered");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await api.businessContext.create({
        category,
        label,
        value,
        source,
        verification_status: verificationStatus,
        notes: notes || undefined,
      });
      setLabel("");
      setValue("");
      setNotes("");
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save business context.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="inline-form" onSubmit={handleSubmit}>
      <select value={category} onChange={(e) => setCategory(e.target.value as BusinessContextCategory)}>
        {BUSINESS_CONTEXT_CATEGORIES.map((c) => (
          <option key={c} value={c}>
            {BUSINESS_CONTEXT_CATEGORY_LABELS[c]}
          </option>
        ))}
      </select>
      <input placeholder="Label" value={label} onChange={(e) => setLabel(e.target.value)} required />
      <input
        placeholder="Value / rule / fact"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        required
        style={{ minWidth: 280 }}
      />
      <select value={source} onChange={(e) => setSource(e.target.value as BusinessContextSource)}>
        {BUSINESS_CONTEXT_SOURCES.map((s) => (
          <option key={s} value={s}>
            {BUSINESS_CONTEXT_SOURCE_LABELS[s]}
          </option>
        ))}
      </select>
      <select
        value={verificationStatus}
        onChange={(e) => setVerificationStatus(e.target.value as BusinessContextVerificationStatus)}
      >
        {BUSINESS_CONTEXT_VERIFICATION_STATUSES.map((s) => (
          <option key={s} value={s}>
            {BUSINESS_CONTEXT_VERIFICATION_LABELS[s]}
          </option>
        ))}
      </select>
      <input placeholder="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
      <button type="submit" disabled={submitting}>
        {submitting ? "Saving…" : "Save"}
      </button>
      {error && <div className="error-banner">{error}</div>}
    </form>
  );
}
