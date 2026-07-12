import { useCallback, useRef, useState } from "react";
import { api } from "../api/client";
import { useSpeechRecognition } from "../hooks/useSpeechRecognition";
import { useAuth } from "../context/useAuth";
import { extractWakeCommand } from "../lib/voice";

interface HistoryEntry {
  text: string;
  inputMethod: "text" | "voice_transcript";
  ok: boolean;
  intent: string;
  message?: string;
}

const EXAMPLES = [
  "create client Jane Smith, email jane@example.com",
  "create lead Alice Green for fencing",
  "create job Hedge trimming for Jane Smith",
  "set job Hedge trimming as scheduled",
  "convert lead Alice Green",
  "list jobs",
];

export function CommandBar() {
  const { user } = useAuth();
  const [text, setText] = useState("");
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [inputMethod, setInputMethod] = useState<"text" | "voice_transcript">("text");
  const voiceBaseText = useRef("");
  const stopSpeechRef = useRef<() => void>(() => undefined);
  const wakeUntilRef = useRef(0);
  const lastFinalRef = useRef("");
  const [wakeListening, setWakeListening] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState<string | null>(null);
  const handleVoiceTranscript = useCallback((transcript: string, isFinal: boolean) => {
    if (wakeListening) {
      if (!isFinal || !transcript || transcript === lastFinalRef.current) return;
      lastFinalRef.current = transcript;
      const command = extractWakeCommand(transcript, user?.voiceWakeWord ?? "Emma");
      if (command !== null) {
        if (!command) {
          wakeUntilRef.current = Date.now() + 8000;
          setVoiceStatus(`Wake word heard. Say the command within 8 seconds.`);
          return;
        }
        setText(command); setInputMethod("voice_transcript"); setVoiceStatus("Command captured. Review the transcript, then choose Run.");
        setWakeListening(false); stopSpeechRef.current(); return;
      }
      if (Date.now() <= wakeUntilRef.current) {
        setText(transcript); setInputMethod("voice_transcript"); setVoiceStatus("Command captured. Review the transcript, then choose Run.");
        setWakeListening(false); stopSpeechRef.current(); return;
      }
      setVoiceStatus(`Listening for “${user?.voiceWakeWord ?? "Emma"}”…`);
      return;
    }
    setText([voiceBaseText.current, transcript].filter(Boolean).join(" "));
    setInputMethod("voice_transcript");
  }, [user?.voiceWakeWord, wakeListening]);
  const speech = useSpeechRecognition(handleVoiceTranscript, user?.voiceLanguage ?? "en-GB");
  stopSpeechRef.current = speech.stop;

  function toggleVoiceInput() {
    if (speech.isListening) {
      speech.stop();
      return;
    }
    voiceBaseText.current = text.trim();
    setVoiceStatus("Listening for one command…");
    speech.start(false);
  }

  function toggleWakeListening() {
    if (wakeListening) { setWakeListening(false); setVoiceStatus(null); speech.stop(); return; }
    setText(""); setInputMethod("voice_transcript"); lastFinalRef.current = ""; wakeUntilRef.current = 0;
    setWakeListening(true); setVoiceStatus(`Listening for “${user?.voiceWakeWord ?? "Emma"}”…`); speech.start(true);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    setSubmitting(true);
    try {
      const res = await api.command.text(text, inputMethod);
      setHistory((h) => [
        { text, inputMethod, ok: res.ok, intent: res.intent, message: res.message },
        ...h,
      ].slice(0, 8));
      setText("");
      setInputMethod("text");
      setVoiceStatus(null);
    } catch {
      setHistory((h) => [
        { text, inputMethod, ok: false, intent: "unrecognized", message: "Request failed." },
        ...h,
      ].slice(0, 8));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="command-bar" aria-label="Voice and text command centre">
      <form onSubmit={handleSubmit} className="inline-form">
        <input
          placeholder='Try: "create client Jane Smith, email jane@example.com"'
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="command-input"
          readOnly={speech.isListening}
          aria-describedby="voice-input-privacy"
        />
        <button
          type="button"
          className={speech.isListening ? "voice-button voice-button-listening" : "voice-button"}
          onClick={toggleVoiceInput}
          disabled={!speech.supported || submitting || wakeListening}
          aria-pressed={speech.isListening}
          title={speech.supported ? undefined : "Voice input is not supported by this browser."}
        >
          {speech.isListening ? "Stop listening" : "Voice input"}
        </button>
        {user?.voiceContinuous && <button type="button" className={wakeListening ? "voice-button voice-button-listening" : "voice-button"} onClick={toggleWakeListening} disabled={!speech.supported || submitting || (speech.isListening && !wakeListening)} aria-pressed={wakeListening}>
          {wakeListening ? `Stop ${user.voiceWakeWord}` : `Listen for ${user.voiceWakeWord}`}
        </button>}
        <button type="submit" disabled={submitting || speech.isListening || !text.trim()}>
          {submitting ? "Running…" : "Run"}
        </button>
      </form>
      {voiceStatus && <div className={wakeListening ? "voice-status voice-status-live" : "voice-status"} role="status">{voiceStatus}</div>}
      <p id="voice-input-privacy" className="hint voice-privacy-note" aria-live="polite">
        {speech.supported
          ? speech.isListening
            ? wakeListening ? `Wake-word mode is active. Say “${user?.voiceWakeWord ?? "Emma"}” followed by a command.` : "Listening for one English command… Stop, review the transcript, then choose Run."
            : "Voice input is handled by your browser and may use its online speech service. Secretary stores no audio, and its backend receives nothing until you review the transcript and choose Run."
          : "This browser does not provide speech recognition. Text commands remain fully available."}
      </p>
      {speech.error ? <div className="error-banner" role="alert">{speech.error}</div> : null}
      <p className="hint">
        Examples:{" "}
        {EXAMPLES.map((ex, i) => (
          <span key={ex}>
            <button
              type="button"
              className="link-button"
              onClick={() => {
                setText(ex);
                setInputMethod("text");
              }}
              disabled={speech.isListening}
            >
              {ex}
            </button>
            {i < EXAMPLES.length - 1 ? ", " : ""}
          </span>
        ))}
      </p>
      {history.length > 0 && (
        <ul className="command-history">
          {history.map((h, i) => (
            <li key={i} className={h.ok ? "command-ok" : "command-error"}>
              <code>{h.text}</code>{" "}
              <span className="hint">({h.inputMethod === "voice_transcript" ? "voice transcript" : "text"})</span>
              {" "}→ <strong>{h.intent}</strong>
              {h.message ? ` — ${h.message}` : h.ok ? " — done" : ""}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
