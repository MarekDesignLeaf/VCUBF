import { Fragment, useEffect, useState } from "react";
import {
  ApiError,
  PERMANENT_DELETION_DEPENDENCY_LABELS,
  PERMANENT_DELETION_IDENTITY_LABELS,
  PERMANENT_DELETION_KEPT_LABELS,
  type PermanentDeletionConfirmation,
  type PermanentDeletionPreview,
} from "../api/client";

/**
 * Permanent deletion of one client or contact: a different action from
 * Archive, with its own panel. The backend owns every rule; this panel only
 * shows the backend's preview (exact identity, links, dependency counts,
 * blockers), asks for the record's name to be typed back, and sends the
 * preview's digest with it. A stale or blocked preview comes back from the
 * backend and is shown instead.
 */
export function PermanentDeletePanel({
  load,
  remove,
  onDeleted,
  onClose,
}: {
  load: () => Promise<PermanentDeletionPreview>;
  remove: (confirmation: PermanentDeletionConfirmation, idempotencyKey: string) => Promise<{ message: string }>;
  onDeleted: (message: string) => void;
  onClose: () => void;
}) {
  const [preview, setPreview] = useState<PermanentDeletionPreview | null>(null);
  const [typedName, setTypedName] = useState("");
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One key per reviewed preview: a repeated click or network retry is answered once.
  const [idempotencyKey, setIdempotencyKey] = useState(() => newKey());

  useEffect(() => {
    load().then(setPreview).catch((err) => setError(err instanceof ApiError ? err.message : "Could not load the deletion preview."));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function confirm() {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const result = await remove(
        { confirmed: true, preview_digest: preview.digest, confirm_display_name: typedName },
        idempotencyKey,
      );
      onDeleted(result.message);
    } catch (err) {
      const fresh = err instanceof ApiError ? (err.details?.preview as PermanentDeletionPreview | undefined) : undefined;
      if (fresh) {
        setPreview(fresh);
        setTypedName("");
        setUnderstood(false);
        setIdempotencyKey(newKey());
      }
      setError(err instanceof ApiError ? err.message : "Could not delete permanently.");
    } finally {
      setBusy(false);
    }
  }

  const identity = preview ? Object.entries(preview.identity).filter(([, value]) => value) : [];
  return (
    <section className="settings-card" data-panel="permanent-delete">
      <div className="page-header">
        <h2>Delete permanently</h2>
        <button type="button" className="secondary" onClick={onClose} disabled={busy}>Close</button>
      </div>
      <div className="warning-banner">
        Permanent deletion removes this record from the database and cannot be undone. Archive keeps it and can be used instead.
      </div>
      {error ? <div className="error-banner">{error}</div> : null}
      {!preview ? (error ? null : <p>Loading…</p>) : (
        <>
          <dl className="detail-list">
            <dt>Name</dt>
            <dd><strong>{preview.displayName}</strong></dd>
            <dt>Record id</dt>
            <dd><code>{preview.id}</code></dd>
            <dt>Status</dt>
            <dd>{preview.status === "archived" ? "Archived" : "Active"}</dd>
            {identity.map(([key, value]) => (
              <Fragment key={key}>
                <dt>{PERMANENT_DELETION_IDENTITY_LABELS[key] ?? key}</dt>
                <dd>{value}</dd>
              </Fragment>
            ))}
            {preview.client ? (<><dt>Client</dt><dd>{preview.client.displayName}</dd></>) : null}
            {preview.externalLinks?.length ? (
              <>
                <dt>Source links</dt>
                <dd>{preview.externalLinks.map((link) => `${link.sourceName} · ${link.externalResourceName}`).join(", ")}</dd>
              </>
            ) : null}
          </dl>
          {preview.dependencies ? (
            <table className="data-table">
              <thead><tr><th>Linked records</th><th>Count</th></tr></thead>
              <tbody>
                {Object.entries(preview.dependencies).map(([key, count]) => (
                  <tr key={key}>
                    <td>{PERMANENT_DELETION_DEPENDENCY_LABELS[key] ?? key}</td>
                    <td>{count > 0 ? <strong>{count}</strong> : count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          {preview.kept.length ? (
            <>
              <p className="hint">Kept after deletion:</p>
              <ul>{preview.kept.map((key) => <li key={key}>{PERMANENT_DELETION_KEPT_LABELS[key] ?? key}</li>)}</ul>
            </>
          ) : null}
          {!preview.canDelete ? (
            <div className="error-banner" data-state="deletion-blocked">
              This record cannot be deleted permanently while other records depend on it. Archive it instead; nothing is lost.
            </div>
          ) : (
            <div className="inline-form">
              <label>
                Type the exact name to confirm:{" "}
                <input
                  value={typedName}
                  onChange={(event) => setTypedName(event.target.value)}
                  placeholder={preview.displayName}
                  aria-label="Name to confirm permanent deletion"
                  autoComplete="off"
                />
              </label>
              <label className="checkbox-label">
                <input type="checkbox" checked={understood} onChange={(event) => setUnderstood(event.target.checked)} />
                I understand this cannot be undone
              </label>
              <button
                type="button"
                className="danger-button"
                data-action="confirm-permanent-delete"
                disabled={busy || !understood || typedName.trim() !== preview.displayName.trim()}
                onClick={() => void confirm()}
              >
                {busy ? "Deleting…" : "Delete permanently"}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function newKey() {
  try {
    return `permanent-delete-${crypto.randomUUID()}`;
  } catch {
    return `permanent-delete-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}
