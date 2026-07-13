import { useEffect, useState } from "react";
import { api, type VoiceDeviceState } from "../api/client";

const OFFLINE: VoiceDeviceState = {
  status: "offline",
  mode: "wake_word",
  listening: false,
  lastTranscript: null,
  lastResponse: null,
  lastHeardAt: null,
  pendingControl: null,
  heartbeatAt: null,
};

const STATUS_LABELS: Record<VoiceDeviceState["status"], string> = {
  offline: "Offline",
  listening: "Listening for Emma",
  hearing: "Hearing you",
  thinking: "Thinking",
  speaking: "Speaking",
  paused: "Paused",
  error: "Needs attention",
};

export function VoiceControlCenter() {
  const [state, setState] = useState<VoiceDeviceState>(OFFLINE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const next = await api.command.voiceState();
        if (active) { setState(next); setError(null); }
      } catch {
        if (active) setError("Could not read the Windows Emma status.");
      } finally {
        if (active) timer = window.setTimeout(poll, 2000);
      }
    };
    poll();
    return () => { active = false; if (timer) window.clearTimeout(timer); };
  }, []);

  async function control(control: "pause" | "resume" | "end_conversation") {
    setBusy(true); setError(null);
    try { setState(await api.command.controlVoice(control)); }
    catch { setError("The control command could not be sent to Emma."); }
    finally { setBusy(false); }
  }

  async function clearHistory() {
    setBusy(true); setError(null);
    try { setState(await api.command.clearVoiceHistory()); }
    catch { setError("Emma's displayed text could not be cleared."); }
    finally { setBusy(false); }
  }

  const isPaused = state.status === "paused";
  return (
    <section className="voice-control-center" aria-label="Windows Emma control centre">
      <div className="voice-control-header">
        <div>
          <strong>Windows Emma</strong>{" "}
          <span className={`voice-device-status status-${state.status}`} role="status">{STATUS_LABELS[state.status]}</span>
          <span className="hint"> · {state.mode === "realtime" ? "Realtime conversation" : state.mode === "reviewed_text" ? "Reviewed transcript" : "Local wake word"}</span>
        </div>
        <div className="voice-control-actions">
          <button type="button" className="voice-button" disabled={busy || state.status === "offline"} onClick={() => control(isPaused ? "resume" : "pause")}>{isPaused ? "Resume listening" : "Pause listening"}</button>
          <button type="button" className="voice-button" disabled={busy || state.status === "offline"} onClick={() => control("end_conversation")}>End conversation</button>
          <button type="button" className="voice-button" disabled={busy || (!state.lastTranscript && !state.lastResponse)} onClick={clearHistory}>Clear displayed text</button>
        </div>
      </div>
      <div className="voice-observation-grid" aria-live="polite">
        <div><span className="voice-observation-label">Emma heard</span><div>{state.lastTranscript || "Nothing captured yet."}</div></div>
        <div><span className="voice-observation-label">Emma answered</span><div>{state.lastResponse || "No response yet."}</div></div>
      </div>
      <p className="hint voice-control-privacy">Only final text accepted after activation is shown and stored here. Background speech is not retained, and VCUBF does not store microphone audio. Pause listening disables wake-word reactions; Clear displayed text removes the retained transcript and answer.</p>
      {state.pendingControl && <div className="voice-control-pending">Waiting for Emma to apply: {state.pendingControl.replace("_", " ")}…</div>}
      {error && <div className="error-banner" role="alert">{error}</div>}
    </section>
  );
}
