import { Fragment, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError, type ClientLinkedRecordCounts, type ClientMergeRecordSummary, type UnmergeClientsPreview } from "../api/client";

const RECORD_LABELS: Record<keyof ClientLinkedRecordCounts, string> = {
  jobs: "jobs",
  quotes: "quotes",
  invoices: "invoices",
  communicationRecords: "communications",
  communicationIntakes: "intakes",
  portfolioPhotos: "photos",
  contacts: "contacts",
  documentRecords: "documents",
  tasks: "tasks",
};

function countsText(counts: ClientLinkedRecordCounts) {
  const parts = (Object.keys(RECORD_LABELS) as (keyof ClientLinkedRecordCounts)[])
    .filter((key) => counts[key] > 0)
    .map((key) => `${counts[key]} ${RECORD_LABELS[key]}`);
  return parts.length ? parts.join(", ") : "no linked records";
}

// Merge history with the confirmation-gated un-merge flow. Mirrors the
// two-step preview/confirm pattern used for the merge itself: "Preview
// un-merge" changes nothing and shows exactly which records would move back
// and which no longer can; only "Confirm un-merge" performs the reversal.
export function MergeHistory({ refreshKey, onChanged }: { refreshKey: number; onChanged: () => Promise<void> | void }) {
  const [merges, setMerges] = useState<ClientMergeRecordSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [preview, setPreview] = useState<UnmergeClientsPreview | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  function load() {
    return api.dataQuality
      .merges()
      .then((result) => setMerges(result.merges))
      .catch(() => setError("Could not load merge history."));
  }

  useEffect(() => {
    void load();
  }, [refreshKey]);

  async function requestPreview(id: string) {
    setOpenId(id);
    setPreview(null);
    setActionError(null);
    setSubmitting(true);
    try {
      await api.dataQuality.unmergeClients(id, false);
      setActionError("Unexpected response — un-merge was not previewed.");
    } catch (err) {
      if (err instanceof ApiError && err.code === "CONFIRMATION_REQUIRED") {
        setPreview((err.details?.preview as UnmergeClientsPreview) ?? null);
      } else {
        setActionError(err instanceof ApiError ? err.message : "Could not preview un-merge.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function confirmUnmerge(id: string) {
    setSubmitting(true);
    setActionError(null);
    try {
      await api.dataQuality.unmergeClients(id, true);
      setOpenId(null);
      setPreview(null);
      await load();
      await onChanged();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Could not complete un-merge.");
    } finally {
      setSubmitting(false);
    }
  }

  if (error) return <div className="error-banner">{error}</div>;
  if (!merges) return null;

  return (
    <>
      <h2 style={{ marginTop: 24 }}>Merge history ({merges.length})</h2>
      <p className="hint">Every confirmed client merge is recorded so it can be reversed. Un-merging moves back only the records that merge re-pointed and that still belong to the kept client; records added or moved since stay where they are and are reported.</p>
      {merges.length === 0 ? (
        <p className="hint">No client merges have been recorded yet.</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Merged</th>
              <th>Kept client</th>
              <th>Archived duplicate</th>
              <th>Re-linked records</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {merges.map((merge) => (
              <Fragment key={merge.id}>
                <tr>
                  <td>{new Date(merge.mergedAt).toLocaleString()}</td>
                  <td><Link to={`/clients/${merge.primaryClient.id}`}>{merge.primaryClient.label ?? merge.primaryClient.id}</Link></td>
                  <td><Link to={`/clients/${merge.duplicateClient.id}`}>{merge.duplicateClient.label ?? merge.duplicateClient.id}</Link>{merge.duplicateClient.isActive === false ? " (archived)" : ""}</td>
                  <td className="hint">{countsText(merge.relinkedCounts)}</td>
                  <td>{merge.mergeStatus === "unmerged" ? `Reversed ${merge.unmergedAt ? new Date(merge.unmergedAt).toLocaleString() : ""}` : "Merged"}</td>
                  <td>
                    {merge.mergeStatus === "merged" && openId !== merge.id && (
                      <button onClick={() => void requestPreview(merge.id)} disabled={submitting}>Preview un-merge</button>
                    )}
                  </td>
                </tr>
                {openId === merge.id && (
                  <tr>
                    <td colSpan={6}>
                      <div className="card">
                        {actionError && <div className="error-banner">{actionError}</div>}
                        {preview ? (
                          <>
                            <p><strong>Un-merge preview</strong> — nothing has changed yet.</p>
                            <ul>
                              <li>{`Records that will move back to ${preview.duplicateClientLabel}: ${countsText(preview.recordsToRestore)}`}</li>
                              <li>{`Records from this merge that can no longer be restored (deleted or moved since): ${countsText(preview.recordsNoLongerLinked)}`}</li>
                              <li>{preview.duplicateWillBeReactivated ? "The archived duplicate will be reactivated." : "The duplicate stays archived, as it was before the merge."}</li>
                            </ul>
                            <div style={{ display: "flex", gap: 8 }}>
                              <button onClick={() => void confirmUnmerge(merge.id)} disabled={submitting}>{submitting ? "Reversing…" : "Confirm un-merge"}</button>
                              <button type="button" onClick={() => { setOpenId(null); setPreview(null); }} disabled={submitting}>Cancel</button>
                            </div>
                          </>
                        ) : (
                          <p className="hint">{submitting ? "Checking…" : "Preview unavailable."}</p>
                        )}
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
