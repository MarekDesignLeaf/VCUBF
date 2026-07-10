import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type DataQualityReport } from "../api/client";

// Data Quality Engine — read-only, structural analysis over real CRM Core
// client data (duplicate email/phone/name matches, clients missing a
// contact method). Nothing here is invented, and nothing is ever merged or
// edited from this page — every finding is a suggestion for a human to
// review directly on the client record. The same findings also appear,
// additively, in the unified Notifications feed, where they can be
// acknowledged like any other attention-feed item.
export function DataQuality() {
  const [report, setReport] = useState<DataQualityReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.dataQuality
      .report()
      .then(setReport)
      .catch(() => setError("Could not load the data quality report."));
  }, []);

  if (error) return <div className="error-banner">{error}</div>;

  return (
    <div>
      <div className="page-header">
        <h1>Data Quality</h1>
      </div>
      <p className="hint">
        A structural, rule-based scan of real client records already in the system — matching
        email, matching phone number, or matching/near-matching name, plus clients with no
        contact method on file. Nothing here is invented and nothing is merged or changed
        automatically — review each finding on the client record and decide yourself. These
        findings also appear in Notifications, where you can acknowledge them once handled.
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
                </tr>
              </thead>
              <tbody>
                {report.duplicateClientGroups.map((g) => (
                  <tr key={`${g.clientAId}:${g.clientBId}`}>
                    <td>
                      <Link to={`/clients/${g.clientAId}`}>{g.clientALabel}</Link>
                    </td>
                    <td>
                      <Link to={`/clients/${g.clientBId}`}>{g.clientBLabel}</Link>
                    </td>
                    <td>{g.reason.replace(/_/g, " ")}</td>
                    <td className="hint">{g.detail}</td>
                  </tr>
                ))}
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
