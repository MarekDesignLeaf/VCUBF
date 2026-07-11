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

  function load() {
    api.notifications
      .feed(showAcknowledged)
      .then(setItems)
      .catch(() => setError("Could not load the attention feed."));
  }

  useEffect(load, [showAcknowledged]);

  async function acknowledge(key: string) {
    await api.notifications.acknowledge(key);
    load();
  }

  async function unacknowledge(key: string) {
    await api.notifications.unacknowledge(key);
    load();
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
      </div>
      <p className="hint">
        Everything here is computed from real data already in the system — unresolved inbound
        intakes, overdue Communication Log follow-ups, real capacity overload and other stored
        signals. Nothing is invented. Acknowledging an item only marks it as
        seen/handled — it never changes the underlying record, and can always be undone.
      </p>

      <label style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 12 }}>
        <input
          type="checkbox"
          checked={showAcknowledged}
          onChange={(e) => setShowAcknowledged(e.target.checked)}
        />
        Show acknowledged items too
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
                    <button onClick={() => unacknowledge(item.key)}>Unacknowledge</button>
                  ) : (
                    <button onClick={() => acknowledge(item.key)}>Acknowledge</button>
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
