import { useEffect, useState } from "react";
import { api, ApiError, notifySafeModeChanged, type SafeModeState } from "../api/client";

/**
 * The administrator's emergency stop. Switching it is one deliberate step with
 * an explicit second click; the backend checks the administrator role, makes
 * the change and audits it.
 */
export function SafeModeCard() {
  const [state, setState] = useState<SafeModeState | null>(null);
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.company.safeMode().then(setState).catch(() => setError("Could not load the emergency stop state."));
  }, []);

  async function apply() {
    if (!state) return;
    setSaving(true); setError(null);
    try {
      const updated = await api.company.setSafeMode(!state.enabled, reason.trim() || undefined);
      setState(updated); setReason(""); setConfirming(false);
      notifySafeModeChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not switch the emergency stop.");
    } finally { setSaving(false); }
  }

  if (!state) return error ? <div className="error-banner">{error}</div> : null;
  return <section className="settings-card" style={{ marginTop: 24 }}>
    <h2>Emergency stop</h2>
    <p className="hint">
      While it is on, nothing new is changed or sent for the company: no edits, no emails or WhatsApp messages,
      no calendar changes, no confirmation of a waiting action and no scheduled digest or connector sync.
      Reading, the audit log, signing in and questions to the assistant keep working. Inbound WhatsApp messages are still recorded.
      While it is on, an administrator can still deactivate an account, give it a new temporary password or switch a connector off.
    </p>
    <p><strong>{state.enabled ? `On since ${new Date(state.since ?? "").toLocaleString()}` : "Off — normal operation."}</strong></p>
    <label>Reason (recorded in the audit log)
      <input value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} />
    </label>
    {error && <div className="error-banner">{error}</div>}
    {!confirming
      ? <button type="button" onClick={() => setConfirming(true)}>{state.enabled ? "Switch emergency stop off" : "Switch emergency stop on"}</button>
      : <div className="inline-form">
        <button type="button" disabled={saving} onClick={apply}>{saving ? "Switching…" : state.enabled ? "Yes, resume normal operation" : "Yes, stop all changes now"}</button>
        <button type="button" className="secondary" disabled={saving} onClick={() => setConfirming(false)}>Cancel</button>
      </div>}
  </section>;
}
