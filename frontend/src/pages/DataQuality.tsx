import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError, type DataQualityReport, type MergeClientsPreview } from "../api/client";

// Data Quality Engine — read-only, structural analysis over real CRM Core
// client data (duplicate email/phone/name matches, clients missing a
// contact method). Nothing here is invented, and nothing is ever merged or
// edited automatically — every finding is a suggestion for a human to
// review. The same findings also appear, additively, in the unified
// Notifications feed, where they can be acknowledged like any other
// attention-feed item.
//
// merge_clients is the one exception: it is a real, confirmation-gated
// write action (risk 3), so this page also offers a "Merge" flow per
// duplicate pair — mirroring the exact two-step confirm UI pattern already
// used on the Employee edit page (EmployeeEdit.tsx): the first submit
// requests a preview only (nothing changes), and only an explicit "Confirm
// merge" click performs the real re-linking + archive.
export function DataQuality() {
  const [report, setReport] = useState<DataQualityReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Which pair (by "clientAId:clientBId" key) currently has its merge panel
  // open, which client of that pair is chosen as the surviving "primary",
  // the preview returned by the confirmation-gated action once requested,
  // and per-panel submitting/error state.
  const [openPairKey, setOpenPairKey] = useState<string | null>(null);
  const [primaryChoice, setPrimaryChoice] = useState<string | null>(null);
  const [mergePreview, setMergePreview] = useState<MergeClientsPreview | null>(null);
  const [mergeSubmitting, setMergeSubmitting] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const [mergeDone, setMergeDone] = useState<Set<string>>(new Set());

  function loadReport() {
    return api.dataQuality
      .report()
      .then(setReport)
      .catch(() => setError("Could not load the data quality report."));
  }

  useEffect(() => {
    loadReport();
  }, []);

  function openMergePanel(pairKey: string, defaultPrimaryId: string) {
    setOpenPairKey(pairKey);
    setPrimaryChoice(defaultPrimaryId);
    setMergePreview(null);
    setMergeError(null);
  }

  function closeMergePanel() {
    setOpenPairKey(null);
    setPrimaryChoice(null);
    setMergePreview(null);
    setMergeError(null);
  }

  async function requestPreview(primaryId: string, duplicateId: string) {
    setMergeSubmitting(true);
    setMergeError(null);
    try {
      await api.dataQuality.mergeClients(primaryId, duplicateId, false);
      // The backend always returns CONFIRMATION_REQUIRED first — reaching
      // here would mean the API contract changed unexpectedly.
      setMergeError("Unexpected response — merge was not previewed.");
    } catch (err) {
      if (err instanceof ApiError && err.code === "CONFIRMATION_REQUIRED") {
        setMergePreview((err.details?.preview as MergeClientsPreview) ?? null);
      } else {
        setMergeError(err instanceof ApiError ? err.message : "Could not preview merge.");
      }
    } finally {
      setMergeSubmitting(false);
    }
  }

  async function confirmMerge(primaryId: string, duplicateId: string, pairKey: string) {
    setMergeSubmitting(true);
    setMergeError(null);
    try {
      await api.dataQuality.mergeClients(primaryId, duplicateId, true);
      setMergeDone((prev) => new Set(prev).add(pairKey));
      closeMergePanel();
      await loadReport();
    } catch (err) {
      setMergeError(err instanceof ApiError ? err.message : "Could not complete merge.");
    } finally {
      setMergeSubmitting(false);
    }
  }

  if (error) return <div className="error-banner">{error}</div>;

  return (
    <div>
      <div className="page-header">
        <h1>Data Quality</h1>
      </div>
      <p className="hint">
        A structural, rule-based scan of real client records already in the system — matching
        email, matching phone number, or matching/near-matching name, plus clients with no
        contact method on file. Nothing here is merged or changed automatically — review each
        finding and decide yourself. A possible duplicate pair can be merged below: this always
        shows a preview of exactly what would be re-linked before anything changes, and archives
        (never deletes) the client you choose not to keep. These findings also appear in
        Notifications, where you can acknowledge them once handled.
      </p>

      {!report ? (
        <p>Loading…</p>
      ) : (
        <>
          <h2>Possible duplicate clients ({report.duplicateClientGroups.length})</h2>
          {report.duplicateClientGroups.length === 0 ? (
            <p className="hint">No possible duplicates found.</p>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Client A</th>
                  <th>Client B</th>
                  <th>Reason</th>
                  <th>Detail</th>
                  <th>Merge</th>
                </tr>
              </thead>
              <tbody>
                {report.duplicateClientGroups.map((g) => {
                  const pairKey = `${g.clientAId}:${g.clientBId}`;
                  const isOpen = openPairKey === pairKey;
                  const duplicateId = primaryChoice === g.clientAId ? g.clientBId : g.clientAId;
                  return (
                    <>
                      <tr key={pairKey}>
                        <td>
                          <Link to={`/clients/${g.clientAId}`}>{g.clientALabel}</Link>
                        </td>
                        <td>
                          <Link to={`/clients/${g.clientBId}`}>{g.clientBLabel}</Link>
                        </td>
                        <td>{g.reason.replace(/_/g, " ")}</td>
                        <td className="hint">{g.detail}</td>
                        <td>
                          {mergeDone.has(pairKey) ? (
                            <span className="hint">Merged</span>
                          ) : isOpen ? (
                            <button onClick={closeMergePanel} disabled={mergeSubmitting}>
                              Cancel
                            </button>
                          ) : (
                            <button onClick={() => openMergePanel(pairKey, g.clientAId)}>Merge…</button>
                          )}
                        </td>
                      </tr>
                      {isOpen && (
                        <tr key={`${pairKey}-panel`}>
                          <td colSpan={5}>
                            <div className="warning-banner" style={{ marginTop: 4, marginBottom: 4 }}>
                              <strong>
                                Merge {g.clientALabel} / {g.clientBLabel}
                              </strong>
                              <p className="hint">
                                Choose which client to keep. The other client's jobs, quotes,
                                communications, and photos will be re-linked to the one you keep,
                                and the other client will be archived (not deleted).
                              </p>
                              <label style={{ display: "block" }}>
                                <input
                                  type="radio"
                                  name={`primary-${pairKey}`}
                                  checked={primaryChoice === g.clientAId}
                                  onChange={() => {
                                    setPrimaryChoice(g.clientAId);
                                    setMergePreview(null);
                                  }}
                                />{" "}
                                Keep {g.clientALabel}, archive {g.clientBLabel}
                              </label>
                              <label style={{ display: "block" }}>
                                <input
                                  type="radio"
                                  name={`primary-${pairKey}`}
                                  checked={primaryChoice === g.clientBId}
                                  onChange={() => {
                                    setPrimaryChoice(g.clientBId);
                                    setMergePreview(null);
                                  }}
                                />{" "}
                                Keep {g.clientBLabel}, archive {g.clientALabel}
                              </label>

                              {mergeError && <div className="error-banner">{mergeError}</div>}

                              {mergePreview ? (
                                <div style={{ marginTop: 8 }}>
                                  <strong>Confirm this merge:</strong>
                                  <ul>
                                    <li>Jobs to re-link: {mergePreview.recordsToRelink.jobs}</li>
                                    <li>Quotes to re-link: {mergePreview.recordsToRelink.quotes}</li>
                                    <li>
                                      Communication records to re-link:{" "}
                                      {mergePreview.recordsToRelink.communicationRecords}
                                    </li>
                                    <li>Photos to re-link: {mergePreview.recordsToRelink.portfolioPhotos}</li>
                                    <li>{mergePreview.duplicateClientLabel} will be archived (not deleted)</li>
                                  </ul>
                                  <button
                                    onClick={() =>
                                      primaryChoice &&
                                      confirmMerge(primaryChoice, duplicateId, pairKey)
                                    }
                                    disabled={mergeSubmitting}
                                    style={{ marginRight: 8 }}
                                  >
                                    {mergeSubmitting ? "Merging…" : "Confirm merge"}
                                  </button>
                                  <button onClick={() => setMergePreview(null)} disabled={mergeSubmitting}>
                                    Back
                                  </button>
                                </div>
                              ) : (
                                <button
                                  onClick={() =>
                                    primaryChoice && requestPreview(primaryChoice, duplicateId)
                                  }
                                  disabled={mergeSubmitting || !primaryChoice}
                                  style={{ marginTop: 8 }}
                                >
                                  {mergeSubmitting ? "Checking…" : "Preview merge"}
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </>
                  );
                })}
              </tbody>
            </table>
          )}

          <h2 style={{ marginTop: 24 }}>Clients missing a contact method ({report.missingContactIssues.length})</h2>
          {report.missingContactIssues.length === 0 ? (
            <p className="hint">Every client has an email or phone number on file.</p>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Client</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {report.missingContactIssues.map((m) => (
                  <tr key={m.clientId}>
                    <td>
                      <Link to={`/clients/${m.clientId}`}>{m.clientLabel}</Link>
                    </td>
                    <td className="hint">{m.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}
