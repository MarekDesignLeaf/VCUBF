import { useEffect, useState } from "react";
import {
  api,
  ApiError,
  type ConnectorDefinition,
  type ConnectorKey,
  type ConnectorSource,
} from "../api/client";
import { useAuth } from "../context/AuthContext";

export function Connectors() {
  const { user } = useAuth();
  const canManage = user?.permissions.includes("connectors.manage") ?? false;
  const [definitions, setDefinitions] = useState<ConnectorDefinition[] | null>(null);
  const [sources, setSources] = useState<ConnectorSource[] | null>(null);
  const [activeOnly, setActiveOnly] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(() =>
    new URLSearchParams(window.location.search).get("gmail") === "connected"
      ? "Gmail authorization completed. Review the access and enable the source before synchronising."
      : null
  );
  const [busySourceId, setBusySourceId] = useState<string | null>(null);

  function loadSources() {
    return api.connectors.sources(activeOnly).then(setSources);
  }

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.connectors.definitions(), api.connectors.sources(activeOnly)])
      .then(([definitionResult, sourceResult]) => {
        if (cancelled) return;
        setDefinitions(definitionResult);
        setSources(sourceResult);
      })
      .catch(() => {
        if (!cancelled) setError("Could not load connector contracts and sources.");
      });
    return () => {
      cancelled = true;
    };
  }, [activeOnly]);

  async function disable(source: ConnectorSource) {
    setError(null);
    try {
      await api.connectors.disableSource(source.id);
      await loadSources();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not disable the data source.");
    }
  }

  async function authorize(source: ConnectorSource) {
    setError(null);
    setNotice(null);
    setBusySourceId(source.id);
    try {
      const result = await api.connectors.startOAuth(source.id);
      window.location.assign(result.authorizationUrl);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not start Gmail authorization.");
      setBusySourceId(null);
    }
  }

  async function enable(source: ConnectorSource) {
    setError(null);
    setNotice(null);
    setBusySourceId(source.id);
    try {
      await api.connectors.enableSource(source.id, false);
    } catch (err) {
      if (!(err instanceof ApiError) || err.code !== "CONFIRMATION_REQUIRED") {
        setError(err instanceof ApiError ? err.message : "Could not enable the data source.");
        setBusySourceId(null);
        return;
      }
      if (!window.confirm("Enable read-only Gmail access for this source? Synchronisation will import messages into Communication Intake.")) {
        setBusySourceId(null);
        return;
      }
    }
    try {
      await api.connectors.enableSource(source.id, true);
      await loadSources();
      setNotice("Gmail source enabled. No external write access was granted.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not enable the data source.");
    } finally {
      setBusySourceId(null);
    }
  }

  async function sync(source: ConnectorSource) {
    setError(null);
    setNotice(null);
    setBusySourceId(source.id);
    try {
      const result = await api.connectors.syncSource(source.id, { max_results: 25 });
      await loadSources();
      const mode = result.mode === "incremental" ? "incremental" : "full";
      const fallback = result.fallbackFromExpiredHistory ? " History cursor expired, so a safe full sync was used." : "";
      const more = result.hasMore ? " More provider pages remain; run sync again." : "";
      setNotice(`Gmail ${mode} sync: ${result.importedCount} imported, ${result.skippedCount} skipped.${fallback}${more}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not synchronise Gmail.");
    } finally {
      setBusySourceId(null);
    }
  }

  async function disconnect(source: ConnectorSource) {
    setError(null);
    setNotice(null);
    setBusySourceId(source.id);
    try {
      await api.connectors.disconnectSource(source.id, false);
    } catch (err) {
      if (!(err instanceof ApiError) || err.code !== "CONFIRMATION_REQUIRED") {
        setError(err instanceof ApiError ? err.message : "Could not prepare Gmail disconnection.");
        setBusySourceId(null);
        return;
      }
      const confirmed = window.confirm(
        "Disconnect Gmail and revoke the Google OAuth grant? Google warns that revocation can remove every scope granted to this Google Cloud project for the account. The encrypted local credential and sync cursor will be deleted."
      );
      if (!confirmed) {
        setBusySourceId(null);
        return;
      }
    }
    try {
      const result = await api.connectors.disconnectSource(source.id, true);
      await loadSources();
      setNotice(result.providerGrantRevoked ? "Gmail disconnected and Google OAuth grant revoked." : "Gmail source disconnected locally.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not disconnect Gmail. The source remains disabled for a safe retry.");
    } finally {
      setBusySourceId(null);
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1>Connectors</h1>
        {canManage ? (
          <button onClick={() => setShowForm((value) => !value)}>
            {showForm ? "Cancel" : "Register data source"}
          </button>
        ) : null}
      </div>
      <p className="hint">
        Gmail supports read-only OAuth and imports messages into Communication Intake with provider provenance.
        Other connectors remain contract-only and fail closed. Never paste an OAuth token, client secret or password here.
      </p>

      {error ? <div className="error-banner">{error}</div> : null}
      {notice ? <div className="success-banner">{notice}</div> : null}
      {showForm && definitions && canManage ? (
        <RegisterSourceForm
          definitions={definitions}
          onCreated={() => {
            setShowForm(false);
            void loadSources();
          }}
        />
      ) : null}

      <label style={{ display: "block", margin: "16px 0" }}>
        <input type="checkbox" checked={activeOnly} onChange={(event) => setActiveOnly(event.target.checked)} /> Active sources only
      </label>

      <h2>Registered sources</h2>
      {!sources ? (
        <p>Loading…</p>
      ) : sources.length === 0 ? (
        <p className="hint">No connector sources registered yet.</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Source</th>
              <th>Type</th>
              <th>Scopes</th>
              <th>Authorization</th>
              <th>Status</th>
              <th>Adapter</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {sources.map((source) => (
              <tr key={source.id}>
                <td><strong>{source.displayName}</strong><div className="hint">{source.definition.serviceName}</div></td>
                <td>{source.serviceType.replaceAll("_", " ")}</td>
                <td>{source.configuredScopes.length ? source.configuredScopes.join(", ") : "None configured"}</td>
                <td>{(source.connectorKey === "gmail" ? source.authorizationConfigured : source.credentialReferenceConfigured) ? "Configured" : "Not configured"}</td>
                <td>{source.connectionStatus.replaceAll("_", " ")}</td>
                <td>{source.definition.adapterAvailable ? "Available" : "Contract only"}</td>
                <td>
                  {canManage ? <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {source.connectorKey === "gmail" && !source.authorizationConfigured ? (
                      <button onClick={() => authorize(source)} disabled={busySourceId === source.id}>Authorize Gmail</button>
                    ) : null}
                    {source.connectorKey === "gmail" && source.authorizationConfigured && !source.isEnabled ? (
                      <button onClick={() => enable(source)} disabled={busySourceId === source.id}>Enable</button>
                    ) : null}
                    {source.connectorKey === "gmail" && source.isEnabled ? (
                      <button onClick={() => sync(source)} disabled={busySourceId === source.id}>
                        {source.incrementalSyncConfigured ? "Sync changes" : "Initial sync"}
                      </button>
                    ) : null}
                    {source.connectorKey === "gmail" && source.authorizationConfigured ? (
                      <button className="secondary" onClick={() => disconnect(source)} disabled={busySourceId === source.id}>Disconnect</button>
                    ) : null}
                    <button className="secondary" onClick={() => disable(source)} disabled={source.connectionStatus === "disabled" || busySourceId === source.id}>
                      Disable
                    </button>
                  </div> : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2 style={{ marginTop: 28 }}>Connector contracts</h2>
      {!definitions ? <p>Loading…</p> : definitions.map((definition) => (
        <section className="card" key={definition.key} style={{ marginBottom: 16 }}>
          <div className="page-header">
            <div><h3>{definition.serviceName}</h3><span className="hint">{definition.serviceType.replaceAll("_", " ")}</span></div>
            <strong>{definition.adapterAvailable ? "Adapter available" : "Adapter not installed"}</strong>
          </div>
          <dl className="detail-list">
            <dt>Can read</dt><dd>{definition.canRead.join(", ")}</dd>
            <dt>Can write</dt><dd>{definition.canWrite.join(", ")}</dd>
            <dt>Returns</dt><dd>{definition.returnedDataTypes.join(", ")}</dd>
            <dt>Actions</dt><dd>{definition.supportedActions.join(", ")}</dd>
            <dt>Permissions</dt><dd>{definition.requiredPermissions.join(", ")}</dd>
            <dt>Safety</dt><dd>Audit: yes · Rollback: {definition.supportsRollback ? "yes" : "no"} · Mode: proposal then confirmed action</dd>
            <dt>Possible errors</dt><dd>{definition.possibleErrors.join(", ")}</dd>
          </dl>
        </section>
      ))}
    </div>
  );
}

function RegisterSourceForm({
  definitions,
  onCreated,
}: {
  definitions: ConnectorDefinition[];
  onCreated: () => void;
}) {
  const [connectorKey, setConnectorKey] = useState<ConnectorKey>(definitions[0].key);
  const [displayName, setDisplayName] = useState("");
  const [configuredScopes, setConfiguredScopes] = useState<string[]>(
    definitions[0].key === "gmail" ? ["read:messages"] : []
  );
  const [credentialReference, setCredentialReference] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const definition = definitions.find((item) => item.key === connectorKey) ?? definitions[0];

  function changeConnector(value: ConnectorKey) {
    setConnectorKey(value);
    setConfiguredScopes(value === "gmail" ? ["read:messages"] : []);
  }

  function toggleScope(scope: string) {
    setConfiguredScopes((current) =>
      current.includes(scope) ? current.filter((value) => value !== scope) : [...current, scope]
    );
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api.connectors.registerSource({
        connector_key: connectorKey,
        display_name: displayName,
        configured_scopes: configuredScopes,
        credential_reference: credentialReference || undefined,
      });
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not register the connector source.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="inline-form" onSubmit={submit}>
      <select value={connectorKey} onChange={(event) => changeConnector(event.target.value as ConnectorKey)}>
        {definitions.map((item) => <option key={item.key} value={item.key}>{item.serviceName}</option>)}
      </select>
      <input placeholder="Source display name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} required />
      {connectorKey !== "gmail" ? <input
          placeholder="Secret reference, e.g. env:VCUF_CONNECTOR_SECRET"
          value={credentialReference}
          onChange={(event) => setCredentialReference(event.target.value)}
          style={{ minWidth: 300 }}
        /> : <p className="hint">Gmail credentials are added through OAuth after this disabled source is registered.</p>}
      <fieldset>
        <legend>Logical scopes</legend>
        {definition.logicalScopes.map((scope) => (
          <label key={scope} style={{ display: "block" }}>
            <input type="checkbox" checked={configuredScopes.includes(scope)} onChange={() => toggleScope(scope)} /> {scope}
          </label>
        ))}
      </fieldset>
      <button type="submit" disabled={submitting}>{submitting ? "Saving…" : "Register disabled source"}</button>
      {error ? <div className="error-banner">{error}</div> : null}
    </form>
  );
}
