import { useCallback, useRef, useState } from "react";
import { api } from "../api/client";
import { useSpeechRecognition } from "../hooks/useSpeechRecognition";

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
  const [text, setText] = useState("");
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [inputMethod, setInputMethod] = useState<"text" | "voice_transcript">("text");
  const voiceBaseText = useRef("");
  const handleVoiceTranscript = useCallback((transcript: string) => {
    setText([voiceBaseText.current, transcript].filter(Boolean).join(" "));
    setInputMethod("voice_transcript");
  }, []);
  const speech = useSpeechRecognition(handleVoiceTranscript);

  function toggleVoiceInput() {
    if (speech.isListening) {
      speech.stop();
      return;
    }
    voiceBaseText.current = text.trim();
    speech.start();
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
    <div className="command-bar">
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
          disabled={!speech.supported || submitting}
          aria-pressed={speech.isListening}
          title={speech.supported ? undefined : "Voice input is not supported by this browser."}
        >
          {speech.isListening ? "Stop listening" : "Voice input"}
        </button>
        <button type="submit" disabled={submitting || speech.isListening || !text.trim()}>
          {submitting ? "Running…" : "Run"}
        </button>
      </form>
      <p id="voice-input-privacy" className="hint voice-privacy-note" aria-live="polite">
        {speech.supported
          ? speech.isListening
            ? "Listening for one English command… Stop, review the transcript, then choose Run."
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
