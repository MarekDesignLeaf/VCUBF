import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  api,
  type AttentionItem,
  NOTIFICATION_TYPE_LABELS,
} from "../api/client";

// Notification and Escalation Module — a unified "things needing attention"
// feed computed from real data already owned by other modules (unresolved
// communication intakes, overdue follow-ups, capacity overload, quotes, etc.).
// Nothing here is invented; acknowledging only marks an item as seen/handled
// and never changes the underlying record — and is fully reversible.
export function Notifications() {
  const [items, setItems] = useState<AttentionItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAcknowledged, setShowAcknowledged] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  function load() {
    setError(null);
    api.notifications
      .feed(showAcknowledged)
      .then(setItems)
      .catch(() => setError("Could not load the attention feed."));
  }

  useEffect(load, [showAcknowledged]);

  async function deleteNotification(key: string) {
    setBusyKey(key);
    setError(null);
    try {
      await api.notifications.delete(key);
      load();
    } catch {
      setError("Could not delete the notification.");
    } finally {
      setBusyKey(null);
    }
  }

  async function unacknowledge(key: string) {
    setBusyKey(key);
    setError(null);
    try {
      await api.notifications.unacknowledge(key);
      load();
    } catch {
      setError("Could not restore the notification.");
    } finally {
      setBusyKey(null);
    }
  }

  async function deleteAll() {
    const visibleCount = items?.filter((item) => !item.acknowledged).length ?? 0;
    if (!visibleCount) return;
    if (!window.confirm(`Delete all ${visibleCount} visible notifications? Source records will not be changed.`)) return;
    setBusyKey("all");
    setError(null);
    try {
      await api.notifications.deleteAll();
      load();
    } catch {
      setError("Could not delete all notifications.");
    } finally {
      setBusyKey(null);
    }
  }

  function entityLink(item: AttentionItem): string | null {
    if (item.entity.type === "communication_intake") return "/enquiries";
    if (item.entity.type === "communication_record") return `/communications`;
    if (item.entity.type === "quote") return `/quotes/${item.entity.id}`;
    return null;
  }

  if (error) return <div className="error-banner">{error}</div>;

  return (
    <div>
      <div className="page-header">
        <h1>Notifications</h1>
        <button
          type="button"
          onClick={deleteAll}
          disabled={busyKey !== null || !items?.some((item) => !item.acknowledged)}
        >
          {busyKey === "all" ? "Deleting…" : "Delete all"}
        </button>
      </div>
      <p className="hint">
        Everything here is computed from real data already in the system — unresolved inbound
        intakes, overdue Communication Log follow-ups, real capacity overload and other stored
        signals. Nothing is invented. Deleting an item removes it from this feed only — it
        never changes the underlying record, and deleted items can always be restored.
      </p>

      <label style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 12 }}>
        <input
          type="checkbox"
          checked={showAcknowledged}
          onChange={(e) => setShowAcknowledged(e.target.checked)}
        />
        Show deleted items too
      </label>

      {!items ? (
        <p>Loading…</p>
      ) : items.length === 0 ? (
        <p className="hint">Nothing needs attention right now.</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Severity</th>
              <th>Type</th>
              <th>What</th>
              <th>Due / week</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.key}>
                <td>
                  <span className={`badge badge-${item.severity}`}>{item.severity}</span>
                </td>
                <td>{NOTIFICATION_TYPE_LABELS[item.type]}</td>
                <td>
                  <strong>{item.title}</strong>
                  <div className="hint">{item.message}</div>
                  {entityLink(item) && <Link to={entityLink(item)!}>Open</Link>}
                </td>
                <td>{item.dueAt ? new Date(item.dueAt).toLocaleDateString() : "—"}</td>
                <td>
                  {item.acknowledged ? (
                    <button disabled={busyKey !== null} onClick={() => unacknowledge(item.key)}>
                      {busyKey === item.key ? "Restoring…" : "Restore"}
                    </button>
                  ) : (
                    <button disabled={busyKey !== null} onClick={() => deleteNotification(item.key)}>
                      {busyKey === item.key ? "Deleting…" : "Delete"}
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
