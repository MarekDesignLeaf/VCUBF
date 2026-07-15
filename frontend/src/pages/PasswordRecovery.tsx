import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api, ApiError } from "../api/client";
import { DesignLeafCredit } from "../components/DesignLeafCredit";

const passwordHint = "Use at least 12 characters, including lowercase, uppercase and a number.";

export function PasswordRecovery() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const [email, setEmail] = useState(() => localStorage.getItem("vcuf_last_email") ?? "");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function requestReset(event: React.FormEvent) {
    event.preventDefault();
    setError(null); setMessage(null); setSubmitting(true);
    try {
      const result = await api.requestPasswordReset(email.trim());
      setMessage(result.message);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not request a password reset.");
    } finally { setSubmitting(false); }
  }

  async function setNewPassword(event: React.FormEvent) {
    event.preventDefault();
    setError(null); setMessage(null);
    if (password !== confirmPassword) { setError("The new passwords do not match."); return; }
    setSubmitting(true);
    try {
      await api.resetPassword(token, password);
      setMessage("Your password has been reset. You can now sign in.");
      window.setTimeout(() => navigate("/login"), 900);
    } catch (err) {
      if (err instanceof ApiError && err.code === "RESET_TOKEN_INVALID_OR_EXPIRED") {
        setError("This reset link is invalid or has expired. Request a new one.");
      } else setError(err instanceof ApiError ? err.message : "Could not reset your password.");
    } finally { setSubmitting(false); }
  }

  const hasToken = Boolean(token);
  return (
    <div className="login-page">
      <section className="login-introduction" aria-label="VCUF Secretary account recovery">
        <div className="login-brand"><span className="login-brand-mark" aria-hidden="true">S</span><span><strong>VCUF</strong><small>Secretary</small></span></div>
        <div className="login-introduction-copy">
          <p className="login-eyebrow">SECURE ACCOUNT RECOVERY</p>
          <h1>{hasToken ? "Choose a new password." : "Recover access without losing your work."}</h1>
          <p>Password recovery invalidates existing sessions, but never deletes company data, contacts, files or Emma transcripts.</p>
        </div>
        <DesignLeafCredit />
      </section>
      <main className="login-panel">
        <form className="login-card" onSubmit={hasToken ? setNewPassword : requestReset}>
          <div className="login-card-heading">
            <p className="login-eyebrow">{hasToken ? "NEW PASSWORD" : "RESET PASSWORD"}</p>
            <h2>{hasToken ? "Set a new password" : "Forgot your password?"}</h2>
            <p className="subtitle">{hasToken ? passwordHint : "Enter your account email. If recovery is available, a one-time link will be sent securely."}</p>
          </div>
          {hasToken ? <>
            <label>New password<input type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={12} required /></label>
            <label>Confirm new password<input type="password" autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} minLength={12} required /></label>
          </> : <label>Email address<input type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} required autoFocus /></label>}
          {error && <div className="error-banner" role="alert">{error}</div>}
          {message && <div className="success-banner" role="status">{message}</div>}
          <button className="login-submit" type="submit" disabled={submitting}>{submitting ? "Please wait…" : hasToken ? "Save new password" : "Send reset link"}</button>
          <Link className="login-secondary-link" to="/login">Back to sign in</Link>
        </form>
      </main>
    </div>
  );
}
