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
    <div className="page-center">
      <form className="login-card" onSubmit={handleSubmit}>
        <h1>Secretary</h1>
        <p className="subtitle">Sign in to VCUF</p>
        <label>
          Email
          <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label>
          Password
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {error && <div className="error-banner">{error}</div>}
        <button type="submit" disabled={submitting}>
          {submitting ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
