import { useEffect, useState } from "react";
import { api, ApiError, type NotificationThresholds, type NotificationThresholdsView } from "../api/client";

const FIELDS: { key: keyof NotificationThresholds; label: string; help: string }[] = [
  { key: "quoteExpiryWarningDays", label: "Quote expiry warning (days before valid-until)", help: "A draft or sent quote appears in Notifications this many days before its valid-until date." },
  { key: "staleLeadDays", label: "Stale lead (days since creation)", help: "An open lead is flagged once it is older than this; twice this age becomes urgent." },
  { key: "stuckJobDays", label: "Stuck job (days without a status change)", help: "An active job whose status has not changed for this long is flagged; twice this age becomes urgent." },
  { key: "resourceReadinessDays", label: "Resource readiness (days before planned start)", help: "A job starting within this many days with a not-ready requirement is flagged as urgent." },
];

// Per-company notification thresholds. Only the number of days changes —
// what is measured stays the same real data. Defaults remain visible so the
// administrator can always see how far the company deviates from them.
export function NotificationThresholdsForm() {
  const [view, setView] = useState<NotificationThresholdsView | null>(null);
  const [draft, setDraft] = useState<NotificationThresholds | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.company.notificationThresholds()
      .then((value) => { setView(value); setDraft(value.thresholds); })
      .catch(() => setError("Could not load notification thresholds."));
  }, []);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!draft) return;
    setError(null); setMessage(null); setSaving(true);
    try {
      const updated = await api.company.updateNotificationThresholds(draft);
      setView(updated); setDraft(updated.thresholds); setMessage("Notification thresholds saved.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save notification thresholds.");
    } finally { setSaving(false); }
  }

  if (!view || !draft) return error ? <div className="error-banner">{error}</div> : null;
  return <section className="settings-card" style={{ marginTop: 24 }}>
    <h2>Notification thresholds</h2>
    <p className="hint">Day thresholds behind the computed Notifications feed. Changing them only changes when an already-recorded fact is surfaced; nothing is invented. Every change is audited.</p>
    <form className="inline-form" style={{ maxWidth: 520, flexDirection: "column", alignItems: "stretch" }} onSubmit={save}>
      {FIELDS.map((field) => <label key={field.key}>{field.label}
        <input type="number" min={view.limits[field.key].min} max={view.limits[field.key].max} step={1} required value={draft[field.key]}
          onChange={(event) => setDraft({ ...draft, [field.key]: Number(event.target.value) })} />
        <span className="hint">{`${field.help} Default: ${view.defaults[field.key]} days; allowed ${view.limits[field.key].min}–${view.limits[field.key].max}.`}</span>
      </label>)}
      {error && <div className="error-banner">{error}</div>}
      {message && <div className="success-banner">{message}</div>}
      <div style={{ display: "flex", gap: 8 }}>
        <button type="submit" disabled={saving}>{saving ? "Saving…" : "Save thresholds"}</button>
        <button type="button" disabled={saving || view.isDefault} onClick={() => setDraft(view.defaults)}>Reset to defaults</button>
      </div>
    </form>
  </section>;
}
