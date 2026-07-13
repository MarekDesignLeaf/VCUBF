import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type AssistantMemory, type RepeatedActionPattern } from "../api/client";

export function MemoryModel() {
  const [memories, setMemories] = useState<AssistantMemory[] | null>(null);
  const [patterns, setPatterns] = useState<RepeatedActionPattern[] | null>(null);
  const [content, setContent] = useState("");
  const [scope, setScope] = useState<"personal" | "company">("personal");
  const [saving, setSaving] = useState(false);
  const [memoryError, setMemoryError] = useState<string | null>(null);
  const [patternError, setPatternError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadMemories = useCallback(async () => {
    try {
      setMemories(await api.memoryModel.memories("all"));
      setMemoryError(null);
    } catch {
      setMemoryError("Could not load Emma's persistent memory.");
    }
  }, []);

  useEffect(() => {
    void loadMemories();
    api.memoryModel.patterns().then(setPatterns).catch(() => {
      setPatternError("Repeated action patterns require audit.read permission.");
    });
  }, [loadMemories]);

  async function saveMemory(event: FormEvent) {
    event.preventDefault();
    const value = content.trim();
    if (!value) return;
    setSaving(true);
    setMemoryError(null);
    setNotice(null);
    try {
      const saved = await api.memoryModel.createMemory(value, scope);
      setContent("");
      setNotice(saved.duplicate ? "Emma already had this active memory." : "Memory saved. Emma will receive it in future conversations.");
      await loadMemories();
    } catch {
      setMemoryError(scope === "company"
        ? "Could not save company memory. Company scope requires CRM management permission."
        : "Could not save the memory.");
    } finally {
      setSaving(false);
    }
  }

  async function archiveMemory(memory: AssistantMemory) {
    if (!window.confirm(`Archive this memory?\n\n${memory.content}`)) return;
    setMemoryError(null);
    setNotice(null);
    try {
      await api.memoryModel.archiveMemory(memory.id);
      setNotice("Memory archived. Emma will no longer use it as active context.");
      await loadMemories();
    } catch {
      setMemoryError("Could not archive the memory.");
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1>Emma Memory</h1>
      </div>

      <section className="card" style={{ marginBottom: 24 }}>
        <h2>Persistent memory</h2>
        <p className="hint">
          Emma stores a permanent note only after an explicit “remember that…” command or this form.
          Personal notes are visible only to you. Company notes are shared with your company and require
          CRM management permission. Archived notes stay visible here but are not sent to Emma.
        </p>
        <form onSubmit={saveMemory}>
          <label>
            What Emma should remember
            <textarea
              value={content}
              onChange={(event) => setContent(event.target.value)}
              maxLength={2000}
              rows={3}
              placeholder="For example: Invoice numbers use the format YYYY-001."
              required
            />
          </label>
          <label>
            Scope
            <select value={scope} onChange={(event) => setScope(event.target.value as "personal" | "company")}>
              <option value="personal">For me</option>
              <option value="company">For the company</option>
            </select>
          </label>
          <button type="submit" disabled={saving || !content.trim()}>{saving ? "Saving…" : "Remember"}</button>
        </form>
        {notice && <p>{notice}</p>}
        {memoryError && <div className="error-banner">{memoryError}</div>}

        {memories === null ? (
          <p>Loading…</p>
        ) : memories.length === 0 ? (
          <p className="hint">No persistent memory has been saved yet.</p>
        ) : (
          <table className="data-table">
            <thead>
              <tr><th>Memory</th><th>Scope</th><th>Status</th><th>Updated</th><th></th></tr>
            </thead>
            <tbody>
              {memories.map((memory) => (
                <tr key={memory.id}>
                  <td>{memory.content}</td>
                  <td>{memory.scope === "company" ? "Company" : "Personal"}</td>
                  <td>{memory.status}</td>
                  <td>{new Date(memory.updatedAt).toLocaleString()}</td>
                  <td>
                    {memory.status === "active" && (
                      <button type="button" onClick={() => void archiveMemory(memory)}>Archive</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h2>Repeated action patterns</h2>
        <p className="hint">
          Candidate patterns are review-only. The system scans the last 30 days for two different
          consecutive actions repeated by the same person at least three times. It never turns a
          detected pattern into a rule or playbook automatically.
        </p>
        {patternError ? (
          <p className="hint">{patternError}</p>
        ) : patterns === null ? (
          <p>Loading…</p>
        ) : patterns.length === 0 ? (
          <p className="hint">No repeated action pattern has recurred at least 3 times in the last 30 days.</p>
        ) : (
          <table className="data-table">
            <thead>
              <tr><th>Action sequence</th><th>Occurrences</th><th>Example timestamps</th><th></th></tr>
            </thead>
            <tbody>
              {patterns.map((pattern) => {
                const query = new URLSearchParams({
                  prefill_name: `Playbook: ${pattern.actionSequence.join(" then ")}`,
                  prefill_steps: pattern.actionSequence.join("\n"),
                }).toString();
                return (
                  <tr key={pattern.actionSequence.join(">")}>
                    <td><code>{pattern.actionSequence.join(" → ")}</code></td>
                    <td>{pattern.occurrenceCount}</td>
                    <td className="hint">{pattern.exampleTimestamps.map((t) => new Date(t).toLocaleString()).join(", ")}</td>
                    <td><Link to={`/playbooks?${query}`}>Build a playbook from this</Link></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
