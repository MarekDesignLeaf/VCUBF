import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../context/useAuth";
import { ApiError } from "../api/client";

export function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [email, setEmail] = useState(() => params.get("email") ?? localStorage.getItem("vcuf_last_email") ?? "");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const user = await login(email, password);
      localStorage.setItem("vcuf_last_email", email.trim());
      const requested=params.get("returnTo");
      navigate(user.mustChangePassword ? "/account" : requested?.startsWith("/") ? requested : "/");
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.code === "INVALID_CREDENTIALS" ? "Invalid email or password." : err.message);
      } else {
        setError("Could not reach the Secretary backend.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="login-page">
      <section className="login-introduction" aria-label="VCUF Secretary">
        <div className="login-brand">
          <span className="login-brand-mark" aria-hidden="true">S</span>
          <span><strong>VCUF</strong><small>Secretary</small></span>
        </div>
        <div className="login-introduction-copy">
          <p className="login-eyebrow">ONE WORKSPACE. CLEAR NEXT STEPS.</p>
          <h1>Run the day with less chasing and more clarity.</h1>
          <p>Secretary brings customers, work, finance and Emma into one focused workspace.</p>
        </div>
        <div className="login-feature-list" aria-label="Secretary features">
          <div><span>01</span><p><strong>Customer context</strong>Keep every contact, enquiry and conversation together.</p></div>
          <div><span>02</span><p><strong>Work in motion</strong>Move from lead to quote, job and invoice without losing the thread.</p></div>
          <div><span>03</span><p><strong>Emma at hand</strong>Use voice guidance and actions where you need them.</p></div>
        </div>
        <p className="login-version">VCUF Secretary · secure workspace</p>
      </section>

      <main className="login-panel">
        <form className="login-card" onSubmit={handleSubmit}>
          <div className="login-card-heading">
            <p className="login-eyebrow">WELCOME BACK</p>
            <h2>Sign in to your workspace</h2>
            <p className="subtitle">Your access, language and assistant settings load after sign in.</p>
          </div>
          <label>
            Email address
            <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
          </label>
          <label>
            Password
            <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </label>
          {error && <div className="error-banner" role="alert">{error}</div>}
          <button className="login-submit" type="submit" disabled={submitting}>
            {submitting ? "Signing in…" : "Enter Secretary"}
          </button>
        </form>
      </main>
    </div>
  );
}
