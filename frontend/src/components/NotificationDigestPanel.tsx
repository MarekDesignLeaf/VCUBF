import { useEffect, useState } from "react";
import { api, ApiError, type DigestPreferences, type DigestPreview } from "../api/client";

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

// Daily digest opt-in. The digest is a plain-text copy of this same feed and
// always goes to the signed-in user's own account email — there is no
// recipient field, so it can never reach a client. "Preview digest" asks the
// backend for the exact message and sends nothing.
export function NotificationDigestPanel() {
  const [preferences, setPreferences] = useState<DigestPreferences | null>(null);
  const [preview, setPreview] = useState<DigestPreview | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.notifications.digestPreferences().then(setPreferences).catch(() => setError("Could not load digest settings."));
  }, []);

  async function save(enabled: boolean, hourUtc: number) {
    setBusy(true); setError(null); setMessage(null);
    try {
      setPreferences(await api.notifications.updateDigestPreferences(enabled, hourUtc));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save digest settings.");
    } finally { setBusy(false); }
  }

  async function requestPreview() {
    setBusy(true); setError(null); setMessage(null); setPreview(null);
    try {
      await api.notifications.sendDigest(false);
      setError("Unexpected response — nothing was previewed.");
    } catch (err) {
      if (err instanceof ApiError && err.code === "CONFIRMATION_REQUIRED") setPreview(err.details?.preview as DigestPreview);
      else setError(err instanceof ApiError ? err.message : "Could not prepare the digest.");
    } finally { setBusy(false); }
  }

  async function confirmSend() {
    setBusy(true); setError(null);
    try {
      const result = await api.notifications.sendDigest(true);
      setPreview(null);
      setMessage(`Digest with ${result.itemCount} item(s) sent to ${result.to.join(", ")}.`);
      setPreferences(await api.notifications.digestPreferences());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not send the digest.");
    } finally { setBusy(false); }
  }

  if (!preferences) return error ? <div className="error-banner">{error}</div> : null;
  return <section className="card" style={{ marginBottom: 16 }}>
    <h2>Daily digest</h2>
    <p className="hint">{`A plain-text copy of this feed, sent once a day to your own account email (${preferences.recipient}) through the company's authorised Gmail source. It is never sent to a client.`}</p>
    <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
      <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <input type="checkbox" checked={preferences.enabled} disabled={busy} onChange={(event) => void save(event.target.checked, preferences.hourUtc)} />
        Send me a daily digest
      </label>
      <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
        Hour (UTC)
        <select value={preferences.hourUtc} disabled={busy || !preferences.enabled} onChange={(event) => void save(preferences.enabled, Number(event.target.value))}>
          {HOURS.map((hour) => <option key={hour} value={hour}>{`${String(hour).padStart(2, "0")}:00`}</option>)}
        </select>
      </label>
      <button type="button" onClick={() => void requestPreview()} disabled={busy || !preferences.enabled}>Preview digest</button>
    </div>
    {preferences.lastSentAt && <p className="hint">{`Last sent ${new Date(preferences.lastSentAt).toLocaleString()}.`}</p>}
    {error && <div className="error-banner">{error}</div>}
    {message && <div className="success-banner">{message}</div>}
    {preview && <div style={{ marginTop: 12 }}>
      <p><strong>{preview.subject}</strong></p>
      <pre style={{ whiteSpace: "pre-wrap" }}>{preview.body}</pre>
      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" onClick={() => void confirmSend()} disabled={busy}>{busy ? "Sending…" : "Confirm and send"}</button>
        <button type="button" onClick={() => setPreview(null)} disabled={busy}>Cancel</button>
      </div>
    </div>}
  </section>;
}
