import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  api,
  ApiError,
  type CommunicationRecord,
  type Client,
  COMMUNICATION_CHANNELS,
  COMMUNICATION_CHANNEL_LABELS,
  COMMUNICATION_DIRECTIONS,
  COMMUNICATION_DIRECTION_LABELS,
} from "../api/client";

// Communication Log Module — the manual-entry foundation of the
// Communication Intelligence Module. There is no email/WhatsApp/SMS
// connector yet, so every record here is typed in by hand; this page (and
// the underlying table/CRM linkage) is designed so a future automated
// extraction workflow can reuse the same records instead of being a
// disconnected system.
export function CommunicationLog() {
  const [searchParams] = useSearchParams();
  const prefillClientId = searchParams.get("client_id") ?? "";
  const prefillJobId = searchParams.get("job_id") ?? "";

  const [records, setRecords] = useState<CommunicationRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(Boolean(prefillClientId));
  const [channelFilter, setChannelFilter] = useState("");
  const [followUpOnly, setFollowUpOnly] = useState(false);

  function load() {
    api.communications
      .list({
        channel: channelFilter || undefined,
        followUpNeeded: followUpOnly ? true : undefined,
      })
      .then(setRecords)
      .catch(() => setError("Could not load communications."));
  }

  useEffect(load, [channelFilter, followUpOnly]);

  if (error) return <div className="error-banner">{error}</div>;

  return (
    <div>
      <div className="page-header">
        <h1>Communications</h1>
        <button onClick={() => setShowForm((v) => !v)}>{showForm ? "Cancel" : "Log communication"}</button>
      </div>
      <p className="hint">
        Manual entry only — there is no email/WhatsApp/SMS connector yet, so nothing here is
        auto-extracted. Every record is exactly what was typed in, always linked to a real
        client (and optionally a job).
      </p>

      {showForm && (
        <LogCommunicationForm
          defaultClientId={prefillClientId}
          defaultJobId={prefillJobId}
          onCreated={() => {
            setShowForm(false);
            load();
          }}
        />
      )}

      <div className="inline-form" style={{ marginTop: 16 }}>
        <select value={channelFilter} onChange={(e) => setChannelFilter(e.target.value)}>
          <option value="">All channels</option>
          {COMMUNICATION_CHANNELS.map((c) => (
            <option key={c} value={c}>
              {COMMUNICATION_CHANNEL_LABELS[c]}
            </option>
          ))}
        </select>
        <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <input type="checkbox" checked={followUpOnly} onChange={(e) => setFollowUpOnly(e.target.checked)} />
          Follow-up needed only
        </label>
      </div>

      {!records ? (
        <p>Loading…</p>
      ) : records.length === 0 ? (
        <p className="hint">No communications logged yet.</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>When</th>
              <th>Client</th>
              <th>Job</th>
              <th>Channel</th>
              <th>Direction</th>
              <th>Summary</th>
              <th>Follow-up</th>
            </tr>
          </thead>
          <tbody>
            {records.map((r) => (
              <tr key={r.id}>
                <td>{new Date(r.occurredAt).toLocaleString()}</td>
                <td>{r.client ? <Link to={`/clients/${r.client.id}`}>{r.client.displayName}</Link> : "—"}</td>
                <td>{r.job ? <Link to={`/jobs/${r.job.id}`}>{r.job.jobTitle}</Link> : "—"}</td>
                <td>{COMMUNICATION_CHANNEL_LABELS[r.channel]}</td>
                <td>{COMMUNICATION_DIRECTION_LABELS[r.direction]}</td>
                <td>{r.summary}</td>
                <td>
                  {r.followUpNeeded
                    ? r.followUpDueAt
                      ? `Due ${new Date(r.followUpDueAt).toLocaleDateString()}`
                      : "Needed"
                    : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function LogCommunicationForm({
  defaultClientId = "",
  defaultJobId = "",
  onCreated,
}: {
  defaultClientId?: string;
  defaultJobId?: string;
  onCreated: () => void;
}) {
  const [clients, setClients] = useState<Client[]>([]);
  const [clientId, setClientId] = useState(defaultClientId);
  const jobId = defaultJobId;
  const [channel, setChannel] = useState<string>("phone_call");
  const [direction, setDirection] = useState<string>("outbound");
  const [summary, setSummary] = useState("");
  const [occurredAt, setOccurredAt] = useState(() => new Date().toISOString().slice(0, 16));
  const [followUpNeeded, setFollowUpNeeded] = useState(false);
  const [followUpDueAt, setFollowUpDueAt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (defaultClientId) return;
    api.clients.list().then(setClients).catch(() => undefined);
  }, [defaultClientId]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await api.communications.create({
        client_id: clientId,
        job_id: jobId || undefined,
        channel,
        direction,
        summary,
        occurred_at: new Date(occurredAt).toISOString(),
        follow_up_needed: followUpNeeded,
        follow_up_due_at: followUpNeeded && followUpDueAt ? new Date(followUpDueAt).toISOString() : undefined,
      });
      setSummary("");
      setFollowUpNeeded(false);
      setFollowUpDueAt("");
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not log communication.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="inline-form" onSubmit={handleSubmit}>
      {!defaultClientId && (
        <select value={clientId} onChange={(e) => setClientId(e.target.value)} required>
          <option value="">— Select client —</option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.displayName}
            </option>
          ))}
        </select>
      )}
      <select value={channel} onChange={(e) => setChannel(e.target.value)}>
        {COMMUNICATION_CHANNELS.map((c) => (
          <option key={c} value={c}>
            {COMMUNICATION_CHANNEL_LABELS[c]}
          </option>
        ))}
      </select>
      <select value={direction} onChange={(e) => setDirection(e.target.value)}>
        {COMMUNICATION_DIRECTIONS.map((d) => (
          <option key={d} value={d}>
            {COMMUNICATION_DIRECTION_LABELS[d]}
          </option>
        ))}
      </select>
      <input type="datetime-local" value={occurredAt} onChange={(e) => setOccurredAt(e.target.value)} required />
      <input
        placeholder="What was discussed/promised"
        value={summary}
        onChange={(e) => setSummary(e.target.value)}
        required
        style={{ minWidth: 260 }}
      />
      <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <input type="checkbox" checked={followUpNeeded} onChange={(e) => setFollowUpNeeded(e.target.checked)} />
        Follow-up needed
      </label>
      {followUpNeeded && (
        <input type="date" value={followUpDueAt} onChange={(e) => setFollowUpDueAt(e.target.value)} />
      )}
      <button type="submit" disabled={submitting}>
        {submitting ? "Saving…" : "Save"}
      </button>
      {error && <div className="error-banner">{error}</div>}
    </form>
  );
}
