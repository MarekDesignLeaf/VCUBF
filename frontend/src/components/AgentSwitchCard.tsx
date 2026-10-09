import { useEffect, useState } from "react";
import { api, ApiError, type AgentModeState } from "../api/client";

function segmentList(segments: Array<{ language: string; channel: string }>) {
  return segments.map((segment) => `${segment.language} / ${segment.channel}`).join(", ");
}

/**
 * The administrator's agent switch (masterplan F2). The backend decides where
 * the agent may act; this card only shows it and asks before switching.
 */
export function AgentSwitchCard({ canSwitch, onChanged }: { canSwitch: boolean; onChanged?: () => void }) {
  const [state, setState] = useState<AgentModeState | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.company.agentMode().then(setState).catch(() => setError("Could not load the agent switch."));
  }, []);

  async function apply() {
    if (!state) return;
    setSaving(true); setError(null);
    try {
      setState(await api.company.setAgentMode(!state.enabled));
      setConfirming(false);
      onChanged?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not switch the agent.");
    } finally { setSaving(false); }
  }

  if (!state) return error ? <div className="error-banner">{error}</div> : null;
  return <section className="settings-card" style={{ marginTop: 24 }}>
    <h2>Agent switch</h2>
    <p className="hint">
      When it is on, the agent may handle a request only for a language and request path that passed the shadow acceptance,
      never during an emergency stop, and only by proposing — every change still waits for your yes.
    </p>
    <p><strong>{state.enabled ? "On" : "Off"}</strong></p>
    <p>{state.accepted.length === 0 ? "No language and path has passed the shadow acceptance yet." : `Accepted: ${segmentList(state.accepted)}`}</p>
    <p>{state.effective.length === 0 ? "The agent acts nowhere right now." : `The agent may act for: ${segmentList(state.effective)}`}</p>
    {error && <div className="error-banner">{error}</div>}
    {canSwitch && (!confirming
      ? <button type="button" onClick={() => setConfirming(true)}>{state.enabled ? "Switch the agent off" : "Switch the agent on"}</button>
      : <div className="inline-form">
        <button type="button" disabled={saving} onClick={() => void apply()}>{saving ? "Switching…" : state.enabled ? "Yes, switch it off" : "Yes, switch it on"}</button>
        <button type="button" className="secondary" disabled={saving} onClick={() => setConfirming(false)}>Cancel</button>
      </div>)}
  </section>;
}
