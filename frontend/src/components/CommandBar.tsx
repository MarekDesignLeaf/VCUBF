import { useState } from "react";
import { api } from "../api/client";

interface HistoryEntry {
  text: string;
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

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    setSubmitting(true);
    try {
      const res = await api.command.text(text);
      setHistory((h) => [{ text, ok: res.ok, intent: res.intent, message: res.message }, ...h].slice(0, 8));
      setText("");
    } catch {
      setHistory((h) => [{ text, ok: false, intent: "unrecognized", message: "Request failed." }, ...h].slice(0, 8));
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
        />
        <button type="submit" disabled={submitting}>
          {submitting ? "Running…" : "Run"}
        </button>
      </form>
      <p className="hint">
        Examples:{" "}
        {EXAMPLES.map((ex, i) => (
          <span key={ex}>
            <button type="button" className="link-button" onClick={() => setText(ex)}>
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
              <code>{h.text}</code> → <strong>{h.intent}</strong>
              {h.message ? ` — ${h.message}` : h.ok ? " — done" : ""}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
