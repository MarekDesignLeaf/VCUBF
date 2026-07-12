import { useState } from "react";
import { api, ApiError } from "../api/client";
import { useAuth } from "../context/useAuth";

export function Account() {
  const { user } = useAuth();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setMessage(null);
    setError(null);
    if (newPassword !== confirmation) { setError("New password confirmation does not match."); return; }
    setSubmitting(true);
    try {
      await api.changePassword(currentPassword, newPassword);
      setCurrentPassword(""); setNewPassword(""); setConfirmation("");
      setMessage("Password changed successfully. Use the new password next time you sign in.");
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === "CURRENT_PASSWORD_INVALID") setError("Current password is incorrect.");
      else if (caught instanceof ApiError && caught.code === "PASSWORD_UNCHANGED") setError("The new password must differ from the current password.");
      else setError(caught instanceof ApiError ? caught.message : "Could not change password.");
    } finally { setSubmitting(false); }
  }

  return <div>
    <h1>Account</h1>
    <p>Signed in as <strong>{user?.displayName}</strong> ({user?.email}).</p>
    <form className="inline-form" onSubmit={submit} style={{ display: "grid", maxWidth: 520 }}>
      <h2>Change password</h2>
      <p className="hint">Use at least 12 characters with uppercase, lowercase and a number.</p>
      <label>Current password<input type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} required /></label>
      <label>New password<input type="password" autoComplete="new-password" minLength={12} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required /></label>
      <label>Confirm new password<input type="password" autoComplete="new-password" minLength={12} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} required /></label>
      {error && <div className="error-banner">{error}</div>}
      {message && <div className="success-banner">{message}</div>}
      <button type="submit" disabled={submitting}>{submitting ? "Changing…" : "Change password"}</button>
    </form>
  </div>;
}
