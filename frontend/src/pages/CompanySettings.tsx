import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError, type CompanyProfile } from "../api/client";

export function CompanySettings() {
  const [company, setCompany] = useState<CompanyProfile | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.company.get().then((value) => { setCompany(value); setName(value.name); }).catch(() => setError("Could not load the company profile."));
  }, []);

  async function save(event: React.FormEvent) {
    event.preventDefault(); setError(null); setMessage(null); setSaving(true);
    try {
      const updated = await api.company.update(name.trim());
      setCompany(updated); setName(updated.name); setMessage("Company profile saved.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save the company profile.");
    } finally { setSaving(false); }
  }

  if (!company) return error ? <div className="error-banner">{error}</div> : <p>Loading…</p>;
  return <div className="settings-page">
    <div className="page-header"><div><h1>Company</h1><p className="hint">The owning company is the root of this Secretary workspace.</p></div></div>
    <section className="settings-card">
      <h2>Access structure</h2>
      <p><strong>Company</strong> → <strong>primary administrator</strong> → <strong>user accounts</strong></p>
      <p className="hint">The primary administrator is {company.primaryAdministrator?.displayName ?? "not assigned"}. Add, deactivate and tailor other accounts from <Link to="/employees">Users & access</Link>.</p>
    </section>
    <form className="inline-form" style={{ maxWidth: 520, flexDirection: "column", alignItems: "stretch" }} onSubmit={save}>
      <label>Company name<input value={name} onChange={(event) => setName(event.target.value)} minLength={2} maxLength={160} required /></label>
      {error && <div className="error-banner">{error}</div>}
      {message && <div className="success-banner">{message}</div>}
      <button type="submit" disabled={saving}>{saving ? "Saving…" : "Save company profile"}</button>
    </form>
  </div>;
}
