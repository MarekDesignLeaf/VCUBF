import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  api,
  ApiError,
  COMMUNICATION_CHANNELS,
  COMMUNICATION_CHANNEL_LABELS,
  type EnquiryListItem,
  type EnquiryResolution,
} from "../api/client";

const PERIOD_OPTIONS = [
  { value: "", label: "All time" },
  { value: "3", label: "Last 3 days" },
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
] as const;

export function Enquiries() {
  const [items, setItems] = useState<EnquiryListItem[] | null>(null);
  const [resolution, setResolution] = useState<EnquiryResolution>("unresolved");
  const [channel, setChannel] = useState("");
  const [periodDays, setPeriodDays] = useState("");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const days = periodDays ? Number(periodDays) : null;
    const since = days ? new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString() : undefined;
    try {
      setItems(await api.communications.enquiries({ resolution, channel: channel || undefined, since }));
      setError(null);
    } catch {
      setError("Could not load enquiries.");
    }
  }, [channel, periodDays, resolution]);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggleResolution(item: EnquiryListItem) {
    setBusyKey(item.key);
    setError(null);
    try {
      if (item.sourceType === "communication_intake") {
        await api.communications.intakes.setResolution(item.sourceId, !item.resolutionNeeded);
      } else {
        await api.communications.update(item.sourceId, { follow_up_needed: !item.resolutionNeeded });
      }
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not update the enquiry.");
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1>Enquiries</h1>
        <Link to="/communication-intake">Add inbound message</Link>
      </div>
      <p className="hint">
        “Unresolved” is an explicit stored state: an intake still marked as needing resolution, or an inbound
        Communication Log record with follow-up needed. Secretary does not guess from message wording whether a reply was sent.
      </p>

      <div className="inline-form" style={{ marginBottom: 16 }}>
        <label>
          Resolution
          <select value={resolution} onChange={(event) => setResolution(event.target.value as EnquiryResolution)}>
            <option value="unresolved">Unresolved</option>
            <option value="resolved">Resolved</option>
            <option value="all">All</option>
          </select>
        </label>
        <label>
          Channel
          <select value={channel} onChange={(event) => setChannel(event.target.value)}>
            <option value="">All channels</option>
            {COMMUNICATION_CHANNELS.map((item) => (
              <option key={item} value={item}>{COMMUNICATION_CHANNEL_LABELS[item]}</option>
            ))}
          </select>
        </label>
        <label>
          Received
          <select value={periodDays} onChange={(event) => setPeriodDays(event.target.value)}>
            {PERIOD_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
      </div>

      {error ? <div className="error-banner">{error}</div> : null}
      {!items ? (
        <p>Loading…</p>
      ) : items.length === 0 ? (
        <p className="hint">No enquiries match these evidence-based filters.</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Status</th>
              <th>Received</th>
              <th>Sender / client</th>
              <th>Channel</th>
              <th>Message</th>
              <th>Source</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.key}>
                <td>
                  <span className={`badge badge-${item.overdue ? "urgent" : item.resolutionNeeded ? "warning" : "info"}`}>
                    {item.overdue ? "overdue" : item.resolutionNeeded ? "unresolved" : "resolved"}
                  </span>
                  <div className="hint">{item.ageDays}d old</div>
                </td>
                <td>{new Date(item.receivedAt).toLocaleString()}</td>
                <td>
                  <strong>{item.senderLabel}</strong>
                  {item.client ? <div><Link to={`/clients/${item.client.id}`}>{item.client.displayName}</Link></div> : null}
                </td>
                <td>{COMMUNICATION_CHANNEL_LABELS[item.channel]}</td>
                <td>
                  {item.summary}
                  {item.followUpDueAt ? <div className="hint">Follow-up due {new Date(item.followUpDueAt).toLocaleDateString()}</div> : null}
                </td>
                <td>
                  <Link to={item.sourceType === "communication_intake" ? "/communication-intake" : "/communications"}>
                    {item.sourceType === "communication_intake" ? "Intake" : "Communication Log"}
                  </Link>
                  {item.sourceReference ? <div className="hint">{item.sourceReference}</div> : null}
                </td>
                <td>
                  <button
                    onClick={() => void toggleResolution(item)}
                    disabled={busyKey === item.key}
                  >
                    {busyKey === item.key ? "Saving…" : item.resolutionNeeded ? "Mark resolved" : "Reopen"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
