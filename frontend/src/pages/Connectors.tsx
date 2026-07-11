import { useEffect, useState } from "react";
import {
  api,
  ApiError,
  type ConnectorDefinition,
  type ConnectorKey,
  type ConnectorSource,
  type ExternalContact,
  type ExternalCalendarEvent,
  type ExternalDriveImage,
} from "../api/client";
import { useAuth } from "../context/useAuth";

interface PickerBuilder {
  addView(view: unknown): PickerBuilder; setOAuthToken(token: string): PickerBuilder;
  setDeveloperKey(key: string): PickerBuilder; setAppId(id: string): PickerBuilder;
  setOrigin(origin: string): PickerBuilder; enableFeature(feature: string): PickerBuilder;
  setCallback(callback: (data: { action?: string; docs?: Array<{ id?: string }> }) => void): PickerBuilder;
  build(): { setVisible(visible: boolean): void };
}
interface PickerNamespace {
  PickerBuilder: new () => PickerBuilder;
  DocsView: new (viewId: string) => { setMimeTypes(types: string): unknown };
  ViewId: { DOCS_IMAGES: string }; Feature: { MULTISELECT_ENABLED: string };
}
declare global { interface Window { gapi?: { load(name: string, callback: () => void): void }; google?: { picker: PickerNamespace } } }

function loadPickerScript() {
  return new Promise<void>((resolve, reject) => {
    if (window.gapi) return window.gapi.load("picker", resolve);
    const existing = document.querySelector<HTMLScriptElement>('script[data-google-picker="true"]');
    const script = existing ?? document.createElement("script");
    if (!existing) { script.src = "https://apis.google.com/js/api.js"; script.dataset.googlePicker = "true"; document.head.appendChild(script); }
    script.addEventListener("load", () => window.gapi?.load("picker", resolve), { once: true });
    script.addEventListener("error", () => reject(new Error("Google Picker failed to load")), { once: true });
  });
}

export function Connectors() {
  const { user } = useAuth();
  const canManage = user?.permissions.includes("connectors.manage") ?? false;
  const canImportContacts = user?.permissions.includes("crm.manage") ?? false;
  const [definitions, setDefinitions] = useState<ConnectorDefinition[] | null>(null);
  const [sources, setSources] = useState<ConnectorSource[] | null>(null);
  const [activeOnly, setActiveOnly] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(() =>
    new URLSearchParams(window.location.search).get("gmail") === "connected"
      ? "Gmail authorization completed. Review the access and enable the source before synchronising."
      : new URLSearchParams(window.location.search).get("google_contacts") === "connected"
        ? "Google Contacts authorization completed. Review the read-only access and enable the source before synchronising."
        : new URLSearchParams(window.location.search).get("google_calendar") === "connected"
          ? "Google Calendar authorization completed. Review the read-only access and enable the source before synchronising."
          : new URLSearchParams(window.location.search).get("google_drive_photos") === "connected"
            ? "Google Drive authorization completed. Enable the source, then explicitly select image files."
            : null
  );
  const [busySourceId, setBusySourceId] = useState<string | null>(null);
  const [contactSourceId, setContactSourceId] = useState<string | null>(null);
  const [externalContacts, setExternalContacts] = useState<ExternalContact[] | null>(null);
  const [calendarSourceId, setCalendarSourceId] = useState<string | null>(null);
  const [externalEvents, setExternalEvents] = useState<ExternalCalendarEvent[] | null>(null);
  const [driveSourceId, setDriveSourceId] = useState<string | null>(null);
  const [driveImages, setDriveImages] = useState<ExternalDriveImage[] | null>(null);

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
      setError(err instanceof ApiError ? err.message : "Could not start Google authorization.");
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
      const impact = source.connectorKey === "google_contacts"
        ? "Enable read-only Google Contacts access? Synchronisation will stage contact previews but will not create CRM contacts."
        : source.connectorKey === "google_calendar"
          ? "Enable read-only Google Calendar access? Synchronisation will stage event previews but will not change jobs, tasks or capacity."
        : "Enable read-only Gmail access? Synchronisation will import messages into Communication Intake.";
      if (!window.confirm(impact)) {
        setBusySourceId(null);
        return;
      }
    }
    try {
      await api.connectors.enableSource(source.id, true);
      await loadSources();
      setNotice(`${source.definition.serviceName} enabled. No external write access was granted.`);
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
      const result = await api.connectors.syncSource(source.id, source.connectorKey === "gmail" ? { max_results: 25 } : {});
      await loadSources();
      const mode = result.mode === "incremental" ? "incremental" : "full";
      const more = result.hasMore ? " More provider pages remain; run sync again." : "";
      if (source.connectorKey === "google_contacts") {
        const fallback = result.fallbackFromExpiredSyncToken ? " Sync token expired, so a safe full sync was used." : "";
        setNotice(`Google Contacts ${mode} sync: ${result.upsertedCount ?? 0} staged, ${result.deletedCount ?? 0} provider deletions.${fallback}${more}`);
        await showExternalContacts(source);
      } else if (source.connectorKey === "google_calendar") {
        setNotice(`Google Calendar ${mode} sync: ${result.calendarsSeen ?? 0} calendars checked, ${result.eventsUpserted ?? 0} events staged, ${result.eventsDeleted ?? 0} cancellations.${more}`);
        await showExternalEvents(source);
      } else {
        const fallback = result.fallbackFromExpiredHistory ? " History cursor expired, so a safe full sync was used." : "";
        setNotice(`Gmail ${mode} sync: ${result.importedCount} imported, ${result.skippedCount} skipped.${fallback}${more}`);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not synchronise the source.");
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
        setError(err instanceof ApiError ? err.message : "Could not prepare provider disconnection.");
        setBusySourceId(null);
        return;
      }
      const confirmed = window.confirm(
        `Disconnect ${source.definition.serviceName} and revoke the Google OAuth grant? Google warns that revocation can remove every scope granted to this Google Cloud project for the account. The encrypted local credential and sync cursor will be deleted; staged and CRM records remain.`
      );
      if (!confirmed) {
        setBusySourceId(null);
        return;
      }
    }
    try {
      const result = await api.connectors.disconnectSource(source.id, true);
      await loadSources();
      setNotice(result.providerGrantRevoked ? `${source.definition.serviceName} disconnected and Google OAuth grant revoked.` : "Source disconnected locally.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not disconnect the provider. The source remains disabled for a safe retry.");
    } finally {
      setBusySourceId(null);
    }
  }

  async function showExternalContacts(source: ConnectorSource) {
    setError(null);
    setContactSourceId(source.id);
    try {
      const result = await api.connectors.externalContacts(source.id);
      setExternalContacts(result.items);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load staged Google contacts.");
    }
  }

  async function importExternalContact(contact: ExternalContact) {
    if (!contactSourceId) return;
    setError(null);
    try {
      await api.connectors.importExternalContact(contactSourceId, contact.id, false);
    } catch (err) {
      if (!(err instanceof ApiError) || err.code !== "CONFIRMATION_REQUIRED") {
        setError(err instanceof ApiError ? err.message : "Could not prepare CRM contact import.");
        return;
      }
      if (!window.confirm(`Create CRM contact “${contact.displayName ?? contact.email ?? contact.phone}” from this reviewed Google contact?`)) return;
    }
    try {
      await api.connectors.importExternalContact(contactSourceId, contact.id, true);
      const source = sources?.find((item) => item.id === contactSourceId);
      if (source) await showExternalContacts(source);
      setNotice("Reviewed Google contact imported into CRM.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not import the CRM contact.");
    }
  }
  async function showExternalEvents(source: ConnectorSource) {
    setError(null); setCalendarSourceId(source.id);
    try { setExternalEvents((await api.connectors.externalCalendarEvents(source.id)).items); }
    catch (err) { setError(err instanceof ApiError ? err.message : "Could not load staged Google events."); }
  }
  async function loadDriveImages(source: ConnectorSource) {
    setDriveSourceId(source.id); setError(null);
    try { setDriveImages(await api.connectors.driveImages(source.id)); }
    catch (err) { setError(err instanceof ApiError ? err.message : "Could not load selected Drive images."); }
  }
  async function openDrivePicker(source: ConnectorSource) {
    setBusySourceId(source.id); setError(null);
    try {
      const config = await api.connectors.drivePickerToken(source.id); await loadPickerScript();
      const picker = window.google?.picker; if (!picker) throw new Error("Google Picker unavailable");
      const view = new picker.DocsView(picker.ViewId.DOCS_IMAGES); view.setMimeTypes("image/jpeg,image/png,image/webp,image/gif,image/heic,image/heif");
      new picker.PickerBuilder().addView(view).setOAuthToken(config.accessToken).setDeveloperKey(config.developerKey)
        .setAppId(config.appId).setOrigin(window.location.origin).enableFeature(picker.Feature.MULTISELECT_ENABLED)
        .setCallback((data) => { if (data.action !== "picked") return; const ids = (data.docs ?? []).flatMap(doc => doc.id ? [doc.id] : []); if (ids.length) void api.connectors.stageDriveImages(source.id, ids).then(() => loadDriveImages(source)).catch(err => setError(err instanceof ApiError ? err.message : "Could not stage selected images.")); }).build().setVisible(true);
    } catch (err) { setError(err instanceof ApiError ? err.message : "Could not open Google Picker."); }
    finally { setBusySourceId(null); }
  }
  async function registerDrivePhoto(image: ExternalDriveImage) {
    if (!driveSourceId) return;
    try { await api.connectors.registerDrivePhoto(driveSourceId, image.id, false); }
    catch (err) { if (!(err instanceof ApiError) || err.code !== "CONFIRMATION_REQUIRED") { setError(err instanceof ApiError ? err.message : "Could not prepare photo registration."); return; } if (!window.confirm(`Register “${image.name}” as an internal Portfolio Photo reference? No image bytes will be copied and marketing use remains disabled.`)) return; }
    try { await api.connectors.registerDrivePhoto(driveSourceId, image.id, true); const source = sources?.find(item => item.id === driveSourceId); if (source) await loadDriveImages(source); setNotice("Drive image registered as an internal portfolio reference; marketing use remains disabled."); }
    catch (err) { setError(err instanceof ApiError ? err.message : "Could not register the portfolio photo."); }
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
        Gmail, Contacts and Calendar are read-only. Drive uses per-file access: only images explicitly selected in Google Picker are staged.
        Never paste an OAuth token, client secret or password here.
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
                <td>{source.authorizationConfigured ? "Configured" : "Not configured"}</td>
                <td>{source.connectionStatus.replaceAll("_", " ")}</td>
                <td>{source.definition.adapterAvailable ? "Available" : "Contract only"}</td>
                <td>
                  {canManage ? <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {!source.authorizationConfigured ? (
                      <button onClick={() => authorize(source)} disabled={busySourceId === source.id}>Authorize {source.connectorKey === "gmail" ? "Gmail" : source.connectorKey === "google_contacts" ? "Contacts" : source.connectorKey === "google_calendar" ? "Calendar" : "Drive"}</button>
                    ) : null}
                    {source.authorizationConfigured && !source.isEnabled ? (
                      <button onClick={() => enable(source)} disabled={busySourceId === source.id}>Enable</button>
                    ) : null}
                    {["gmail", "google_contacts", "google_calendar"].includes(source.connectorKey) && source.isEnabled ? (
                      <button onClick={() => sync(source)} disabled={busySourceId === source.id}>
                        {source.incrementalSyncConfigured ? "Sync changes" : "Initial sync"}
                      </button>
                    ) : null}
                    {source.connectorKey === "google_contacts" ? (
                      <button className="secondary" onClick={() => showExternalContacts(source)}>Review contacts</button>
                    ) : null}
                    {source.connectorKey === "google_calendar" ? <button className="secondary" onClick={() => showExternalEvents(source)}>Review events</button> : null}
                    {source.connectorKey === "google_drive_photos" && source.isEnabled ? <button onClick={() => openDrivePicker(source)} disabled={busySourceId === source.id}>Select Drive images</button> : null}
                    {source.connectorKey === "google_drive_photos" ? <button className="secondary" onClick={() => loadDriveImages(source)}>Review images</button> : null}
                    {source.authorizationConfigured ? (
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

      {contactSourceId ? (
        <section className="card" style={{ marginTop: 20 }}>
          <div className="page-header">
            <h2>Staged Google contacts</h2>
            <button className="secondary" onClick={() => { setContactSourceId(null); setExternalContacts(null); }}>Close</button>
          </div>
          <p className="hint">Read-only provider data. Nothing becomes a CRM contact until you review and confirm it.</p>
          {!externalContacts ? <p>Loading…</p> : externalContacts.length === 0 ? <p className="hint">No active contacts staged.</p> : (
            <table className="data-table">
              <thead><tr><th>Name</th><th>Contact</th><th>Organisation</th><th>Status</th><th></th></tr></thead>
              <tbody>{externalContacts.map((contact) => <tr key={contact.id}>
                <td><strong>{contact.displayName ?? "Unnamed contact"}</strong><div className="hint">{contact.jobTitle ?? ""}</div></td>
                <td>{contact.email ?? "—"}<div className="hint">{contact.phone ?? ""}</div></td>
                <td>{contact.organisation ?? "—"}<div className="hint">{contact.department ?? ""}</div></td>
                <td>{contact.importedContactId ? "Imported" : contact.importable ? "Ready for review" : "Missing email/phone"}</td>
                <td>{canImportContacts && contact.importable && !contact.importedContactId ? <button onClick={() => importExternalContact(contact)}>Import to CRM</button> : "—"}</td>
              </tr>)}</tbody>
            </table>
          )}
        </section>
      ) : null}
      {calendarSourceId ? <section className="card" style={{ marginTop: 20 }}>
        <div className="page-header"><h2>Staged Google Calendar events</h2><button className="secondary" onClick={() => { setCalendarSourceId(null); setExternalEvents(null); }}>Close</button></div>
        <p className="hint">Read-only preview. These events do not change Secretary jobs, tasks, assignments or capacity.</p>
        {!externalEvents ? <p>Loading…</p> : externalEvents.length === 0 ? <p className="hint">No active events staged.</p> : <table className="data-table">
          <thead><tr><th>Event</th><th>Calendar</th><th>When</th><th>Location</th></tr></thead><tbody>{externalEvents.map(event => <tr key={event.id}>
            <td><strong>{event.summary ?? "Private or untitled event"}</strong><div className="hint">{event.organiserEmail ?? ""}</div></td>
            <td>{event.externalCalendar.summary}</td><td>{event.startAt ? new Date(event.startAt).toLocaleString() : event.startDate ?? "Unknown"}</td><td>{event.location ?? "—"}</td>
          </tr>)}</tbody>
        </table>}
      </section> : null}
      {driveSourceId ? <section className="card" style={{ marginTop: 20 }}>
        <div className="page-header"><h2>Selected Google Drive images</h2><button className="secondary" onClick={() => { setDriveSourceId(null); setDriveImages(null); }}>Close</button></div>
        <p className="hint">Metadata references only. No image bytes are stored and marketing use remains disabled until a separate human review.</p>
        {!driveImages ? <p>Loading…</p> : driveImages.length === 0 ? <p className="hint">No images selected.</p> : <table className="data-table"><thead><tr><th>Image</th><th>Type</th><th>Dimensions</th><th>Status</th><th></th></tr></thead><tbody>{driveImages.map(image => <tr key={image.id}>
          <td><strong>{image.name}</strong>{image.webViewLink ? <div><a href={image.webViewLink} target="_blank" rel="noreferrer">Open in Drive</a></div> : null}</td><td>{image.mimeType}</td><td>{image.width && image.height ? `${image.width} × ${image.height}` : "Unknown"}</td><td>{image.portfolioPhotoId ? "Registered" : "Staged"}</td><td>{canImportContacts && !image.portfolioPhotoId ? <button onClick={() => registerDrivePhoto(image)}>Register portfolio reference</button> : "—"}</td>
        </tr>)}</tbody></table>}
      </section> : null}

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
    definitions[0].key === "gmail" ? ["read:messages"] : definitions[0].key === "google_contacts" ? ["read:contacts"] : definitions[0].key === "google_calendar" ? ["read:calendar"] : ["select:image_files"]
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const definition = definitions.find((item) => item.key === connectorKey) ?? definitions[0];

  function changeConnector(value: ConnectorKey) {
    setConnectorKey(value);
    setConfiguredScopes(value === "gmail" ? ["read:messages"] : value === "google_contacts" ? ["read:contacts"] : value === "google_calendar" ? ["read:calendar"] : ["select:image_files"]);
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
      <p className="hint">Google credentials are added through OAuth after this disabled source is registered.</p>
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
