import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError, type AgentShadowSummary, type ControlTowerOverview } from "../api/client";

function percent(value: number | null): string {
  return value === null ? "—" : `${Math.round(value * 1000) / 10} %`;
}

function when(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "—";
}

/**
 * Agent Control Tower v1 (masterplan layer I). Read only: everything shown is
 * decided and computed by the backend; this page changes nothing.
 */
export function AgentControlTower() {
  const [overview, setOverview] = useState<ControlTowerOverview | null>(null);
  const [shadow, setShadow] = useState<AgentShadowSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [tower, summary] = await Promise.all([api.audit.controlTower(), api.audit.agentShadow()]);
      setOverview(tower); setShadow(summary);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load the control tower.");
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (!overview) return error ? <div className="error-banner">{error}</div> : <p>Loading…</p>;
  const segments = shadow
    ? Object.entries(shadow.byLanguage).flatMap(([language, channels]) => Object.entries(channels).map(([channel, verdict]) => ({ language, channel, verdict })))
    : [];

  return <div className="settings-page">
    <div className="page-header">
      <div>
        <h1>Agent control tower</h1>
        <p className="hint">What the AI side of Secretary is doing for this company. Read only — nothing here changes anything, and no message text is stored or shown.</p>
      </div>
      <button type="button" onClick={() => void load()} disabled={loading}>{loading ? "Refreshing…" : "Refresh"}</button>
    </div>
    {error && <div className="error-banner">{error}</div>}

    <section className="settings-card">
      <h2>State</h2>
      <p><strong>Emergency stop:</strong> {overview.safeMode.enabled ? `On since ${when(overview.safeMode.since)}` : "Off"} <Link to="/company">Company settings</Link></p>
      <p><strong>Agent in shadow:</strong> {overview.shadow.enabled
        ? `On for ${Math.round(overview.shadow.sampleRate * 100)} % of commands`
        : "Off — set AGENT_SHADOW_SAMPLE_RATE on Railway to switch it on"}
        {overview.shadow.enabled && !overview.shadow.modelKeyConfigured && " (no model key: every selected command is recorded as an error)"}</p>
      <p><strong>Build:</strong> <code>{overview.build}</code></p>
      <p><strong>Last 24 hours:</strong> {`${overview.lastDay.runs} agent runs, ${overview.lastDay.errors} errors, ${overview.lastDay.tokensIn} tokens in, ${overview.lastDay.tokensOut} tokens out`}</p>
    </section>

    <section className="settings-card" style={{ marginTop: 24 }}>
      <h2>Models</h2>
      <table className="data-table">
        <thead><tr><th>Task</th><th>Model</th></tr></thead>
        <tbody>{overview.models.map((entry) => <tr key={entry.task}><td><code>{entry.task}</code></td><td><code>{entry.model}</code></td></tr>)}</tbody>
      </table>
    </section>

    <section className="settings-card" style={{ marginTop: 24 }}>
      <h2>Waiting for a yes</h2>
      {overview.pendingReviews.length === 0
        ? <p className="hint">Nothing is waiting.</p>
        : <table className="data-table">
          <thead><tr><th>Action</th><th>Waiting</th><th>Oldest</th><th>Next expiry</th></tr></thead>
          <tbody>{overview.pendingReviews.map((entry) => <tr key={entry.actionType}>
            <td><code>{entry.actionType}</code></td><td>{entry.waiting}</td><td>{when(entry.oldestCreatedAt)}</td><td>{when(entry.nextExpiresAt)}</td>
          </tr>)}</tbody>
        </table>}
    </section>

    <section className="settings-card" style={{ marginTop: 24 }}>
      <h2>Shadow acceptance</h2>
      <p className="hint">The agent may only be switched on for a language and request path that is accepted: at least 95 % agreement on 100 compared commands of the current build, model and tool set.</p>
      {shadow && <p className="hint">{`Current cohort: model ${shadow.cohort.model}, build ${shadow.cohort.build}. Runs of earlier cohorts: ${shadow.otherCohortRuns}.`}</p>}
      {segments.length === 0
        ? <p className="hint">No shadow runs in the current cohort yet.</p>
        : <div className="table-scroll"><table className="data-table">
          <thead><tr><th>Language</th><th>Path</th><th>Compared</th><th>Agreement</th><th>On actions</th><th>Errors</th><th>Status</th></tr></thead>
          <tbody>{segments.map(({ language, channel, verdict }) => <tr key={`${language}-${channel}`}>
            <td>{language}</td><td>{channel}</td><td>{verdict.compared}</td><td>{percent(verdict.agreementRate)}</td>
            <td>{percent(verdict.actionableAgreementRate)}</td><td>{percent(verdict.errorRate)}</td>
            <td>{verdict.met ? <strong>Accepted</strong> : `Not yet: ${verdict.unmet.join("; ")}`}</td>
          </tr>)}</tbody>
        </table></div>}
    </section>

    <section className="settings-card" style={{ marginTop: 24 }}>
      <h2>Latest agent runs</h2>
      {overview.recentRuns.length === 0
        ? <p className="hint">No agent runs yet.</p>
        : <div className="table-scroll"><table className="data-table">
          <thead><tr><th>Time</th><th>User</th><th>Path</th><th>Language</th><th>Parser did</th><th>Agent proposed</th><th>Agreement</th><th>Tokens</th><th>Duration (ms)</th></tr></thead>
          <tbody>{overview.recentRuns.map((runEntry) => <tr key={runEntry.id}>
            <td>{when(runEntry.createdAt)}</td>
            <td>{runEntry.userName}</td>
            <td>{runEntry.channel}</td>
            <td>{runEntry.language}</td>
            <td><code>{runEntry.parserAction ?? runEntry.parserIntent}</code></td>
            <td>{runEntry.proposedTools.length === 0 ? "—" : runEntry.proposedTools.map((tool, index) =>
              <code key={`${tool.tool}-${index}`} className={tool.valid ? "proposed-tool" : "proposed-tool proposed-tool-invalid"}>{tool.tool}</code>)}</td>
            <td>{runEntry.agreement}{runEntry.errorCode ? ` (${runEntry.errorCode})` : ""}</td>
            <td>{(runEntry.tokensIn ?? 0) + (runEntry.tokensOut ?? 0)}</td>
            <td>{runEntry.durationMs}</td>
          </tr>)}</tbody>
        </table></div>}
    </section>
  </div>;
}
