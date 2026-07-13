import { useState } from "react";
import { api } from "../api/client";

interface HistoryEntry {
  id: string;
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

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const command = text.trim();
    if (!command) return;
    setSubmitting(true);
    try {
      const response = await api.command.text(command, "text");
      setHistory((current) => [
        { id: crypto.randomUUID(), text: command, ok: response.ok, intent: response.intent, message: response.message },
        ...current,
      ].slice(0, 8));
      setText("");
    } catch {
      setHistory((current) => [
        { id: crypto.randomUUID(), text: command, ok: false, intent: "unrecognized", message: "Request failed." },
        ...current,
      ].slice(0, 8));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <details className="text-command-fallback">
      <summary>Type to Emma (optional)</summary>
      <div className="command-bar">
        <p id="text-command-help" className="hint">
          Windows Emma handles all voice interaction. Open this only when you prefer to type a command.
        </p>
        <form onSubmit={handleSubmit} className="inline-form">
          <input
            aria-label="Type a command for Emma"
            aria-describedby="text-command-help"
            placeholder='For example: "list jobs"'
            value={text}
            onChange={(event) => setText(event.target.value)}
            className="command-input"
          />
          <button type="submit" disabled={submitting || !text.trim()}>
            {submitting ? "Sending…" : "Send to Emma"}
          </button>
        </form>
        <p className="hint">
          Examples:{" "}
          {EXAMPLES.map((example, index) => (
            <span key={example}>
              <button type="button" className="link-button" onClick={() => setText(example)}>
                {example}
              </button>
              {index < EXAMPLES.length - 1 ? ", " : ""}
            </span>
          ))}
        </p>
        {history.length > 0 ? (
          <ul className="command-history">
            {history.map((entry) => (
              <li key={entry.id} className={entry.ok ? "command-ok" : "command-error"}>
                <code>{entry.text}</code> → <strong>{entry.intent}</strong>
                {entry.message ? ` — ${entry.message}` : entry.ok ? " — done" : ""}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </details>
  );
}
