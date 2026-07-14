import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError } from "../api/client";
import { useAuth } from "../context/useAuth";

export function InitialSetup() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [companyName, setCompanyName] = useState("");
  const [administratorName, setAdministratorName] = useState("");
  const [administratorEmail, setAdministratorEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    if (password !== confirmPassword) { setError("The administrator passwords do not match."); return; }
    setSubmitting(true);
    try {
      await api.setup({
        company_name: companyName.trim(),
        administrator_name: administratorName.trim(),
        administrator_email: administratorEmail.trim(),
        administrator_password: password,
      });
      await login(administratorEmail.trim(), password);
      navigate("/");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create the company workspace.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="login-page">
      <section className="login-introduction" aria-label="Secretary first-time setup">
        <div className="login-brand"><span className="login-brand-mark" aria-hidden="true">S</span><span><strong>VCUF</strong><small>Secretary</small></span></div>
        <div className="login-introduction-copy">
          <p className="login-eyebrow">FIRST-TIME SETUP</p>
          <h1>Start with the company that owns this workspace.</h1>
          <p>Secretary creates the company and its primary administrator together. Only then can the administrator add other user accounts and choose their access.</p>
        </div>
        <ol className="setup-steps">
          <li><strong>1. Company</strong><span>Defines the workspace and its data boundary.</span></li>
          <li><strong>2. Administrator</strong><span>Controls company settings, users and permissions.</span></li>
          <li><strong>3. Users</strong><span>Added later with a role profile and optional individual rights.</span></li>
        </ol>
      </section>
      <main className="login-panel">
        <form className="login-card" onSubmit={handleSubmit}>
          <div className="login-card-heading"><p className="login-eyebrow">CREATE COMPANY WORKSPACE</p><h2>Company and administrator</h2><p className="subtitle">This account becomes the first active administrator. You can add more administrators later.</p></div>
          <label>Company name<input value={companyName} onChange={(event) => setCompanyName(event.target.value)} minLength={2} maxLength={160} required autoFocus /></label>
          <label>Administrator name<input value={administratorName} onChange={(event) => setAdministratorName(event.target.value)} minLength={2} maxLength={120} required /></label>
          <label>Administrator email<input type="email" autoComplete="username" value={administratorEmail} onChange={(event) => setAdministratorEmail(event.target.value)} required /></label>
          <label>Administrator password<input type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={12} required /></label>
          <label>Confirm password<input type="password" autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} minLength={12} required /></label>
          {error && <div className="error-banner" role="alert">{error}</div>}
          <button className="login-submit" type="submit" disabled={submitting}>{submitting ? "Creating workspace…" : "Create company and administrator"}</button>
        </form>
      </main>
    </div>
  );
}
