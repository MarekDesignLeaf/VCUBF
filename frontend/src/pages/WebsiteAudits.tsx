import { useEffect, useState } from "react";
import {
  api,
  ApiError,
  type WebsiteAudit,
  type WebsiteAuditFinding,
} from "../api/client";

type CheckState = "" | "present" | "missing";

const FINDING_CATEGORY_LABELS: Record<string, string> = {
  technical: "Technical",
  content: "Content",
  contact: "Contact details",
  form: "Contact form",
  service_content: "Service content",
  missing_service_page: "Missing service page",
  photos: "Photographs",
  data_gap: "Secretary data gap",
};

function checkStateToBoolean(value: CheckState) {
  if (value === "present") return true;
  if (value === "missing") return false;
  return undefined;
}

function splitCommaSeparated(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

// Basic Website Audit — a connector-free, manual-observation workflow. It
// records what a human actually checked, then compares that evidence with
// Secretary's real company data. Unknown checks stay unknown; the UI never
// silently converts an empty field into a negative finding and never
// publishes any recommendation.
export function WebsiteAudits() {
  const [audits, setAudits] = useState<WebsiteAudit[] | null>(null);
  const [selectedAudit, setSelectedAudit] = useState<WebsiteAudit | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.websiteAudits
      .list()
      .then((result) => {
        if (!cancelled) setAudits(result);
      })
      .catch(() => {
        if (!cancelled) setError("Could not load website audits.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function viewAudit(id: string) {
    setError(null);
    setLoadingDetail(true);
    try {
      setSelectedAudit(await api.websiteAudits.get(id));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load the website audit.");
    } finally {
      setLoadingDetail(false);
    }
  }

  function handleCreated(created: WebsiteAudit) {
    setAudits((current) => [created, ...(current ?? []).filter((audit) => audit.id !== created.id)]);
    setSelectedAudit(created);
    setShowForm(false);
  }

  return (
    <div>
      <div className="page-header">
        <h1>Website Audit</h1>
        <button onClick={() => setShowForm((current) => !current)}>
          {showForm ? "Cancel" : "New audit"}
        </button>
      </div>
      <p className="hint">
        Record only checks you actually performed. This version does not crawl the website: it
        compares your observations with real Service Catalogue records, confirmed Business
        Context and reviewed Portfolio photographs. It prepares findings only and cannot publish
        or change the website.
      </p>

      {showForm ? <WebsiteAuditForm onCreated={handleCreated} /> : null}
      {error ? <div className="error-banner">{error}</div> : null}

      {!audits ? (
        <p>Loading…</p>
      ) : audits.length === 0 ? (
        <p className="hint">No website audit has been recorded yet.</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Website</th>
              <th>Date</th>
              <th>Pages</th>
              <th>Urgent</th>
              <th>Warnings</th>
              <th>Info</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {audits.map((audit) => (
              <tr key={audit.id}>
                <td>{audit.websiteUrl}</td>
                <td>{new Date(audit.createdAt).toLocaleString()}</td>
                <td>{audit.pageCount}</td>
                <td>{audit.urgentCount}</td>
                <td>{audit.warningCount}</td>
                <td>{audit.infoCount}</td>
                <td>
                  <button className="secondary" onClick={() => viewAudit(audit.id)} disabled={loadingDetail}>
                    View findings
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {loadingDetail ? <p>Loading findings…</p> : null}
      {selectedAudit ? <WebsiteAuditDetail audit={selectedAudit} /> : null}
    </div>
  );
}

function WebsiteAuditDetail({ audit }: { audit: WebsiteAudit }) {
  const findings = audit.findings ?? [];
  return (
    <section style={{ marginTop: 24 }} aria-labelledby="website-audit-findings-heading">
      <h2 id="website-audit-findings-heading">Findings for {audit.websiteUrl}</h2>
      {audit.notes ? <p className="hint">Audit notes: {audit.notes}</p> : null}
      {findings.length === 0 ? (
        <p className="hint">No findings were produced from the recorded evidence.</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Severity</th>
              <th>Category</th>
              <th>Finding</th>
              <th>Evidence</th>
              <th>Recommendation</th>
              <th>Source</th>
            </tr>
          </thead>
          <tbody>
            {findings.map((finding: WebsiteAuditFinding) => (
              <tr key={finding.id}>
                <td>
                  <span className={`badge badge-${finding.severity}`}>{finding.severity}</span>
                </td>
                <td>{FINDING_CATEGORY_LABELS[finding.category] ?? finding.category}</td>
                <td>{finding.title}</td>
                <td>{finding.evidence}</td>
                <td>{finding.recommendation}</td>
                <td>{finding.sourceType.replaceAll("_", " ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function WebsiteAuditForm({ onCreated }: { onCreated: (audit: WebsiteAudit) => void }) {
  const [websiteUrl, setWebsiteUrl] = useState("");
  const [pageUrl, setPageUrl] = useState("");
  const [statusCode, setStatusCode] = useState("");
  const [titleState, setTitleState] = useState<CheckState>("");
  const [pageTitle, setPageTitle] = useState("");
  const [contactState, setContactState] = useState<CheckState>("");
  const [formState, setFormState] = useState<CheckState>("");
  const [serviceContentState, setServiceContentState] = useState<CheckState>("");
  const [photoState, setPhotoState] = useState<CheckState>("");
  const [serviceNames, setServiceNames] = useState("");
  const [brokenLinks, setBrokenLinks] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function changeWebsiteUrl(value: string) {
    const previousWebsiteUrl = websiteUrl;
    setWebsiteUrl(value);
    setPageUrl((current) => (!current || current === previousWebsiteUrl ? value : current));
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const page: Record<string, unknown> = {
        url: pageUrl,
        service_names: splitCommaSeparated(serviceNames),
        broken_links: splitCommaSeparated(brokenLinks),
      };
      if (statusCode) page.status_code = Number(statusCode);
      if (titleState === "present") page.title = pageTitle;
      if (titleState === "missing") page.title = "";
      const hasContactDetails = checkStateToBoolean(contactState);
      const hasContactForm = checkStateToBoolean(formState);
      const hasServiceContent = checkStateToBoolean(serviceContentState);
      if (hasContactDetails !== undefined) page.has_contact_details = hasContactDetails;
      if (hasContactForm !== undefined) page.has_contact_form = hasContactForm;
      if (hasServiceContent !== undefined) page.has_service_content = hasServiceContent;
      if (photoState === "present") page.photo_count = 1;
      if (photoState === "missing") page.photo_count = 0;

      onCreated(
        await api.websiteAudits.create({
          website_url: websiteUrl,
          notes: notes || undefined,
          pages: [page],
        })
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create the website audit.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="inline-form" onSubmit={handleSubmit}>
      <label>
        Website URL
        <input
          type="url"
          value={websiteUrl}
          onChange={(event) => changeWebsiteUrl(event.target.value)}
          placeholder="https://example.com"
          required
        />
      </label>
      <label>
        Observed page URL
        <input
          type="url"
          value={pageUrl}
          onChange={(event) => setPageUrl(event.target.value)}
          required
        />
      </label>
      <label>
        HTTP status (if checked)
        <input
          type="number"
          min="100"
          max="599"
          value={statusCode}
          onChange={(event) => setStatusCode(event.target.value)}
        />
      </label>
      <AuditCheckSelect label="Page title" value={titleState} onChange={setTitleState} />
      {titleState === "present" ? (
        <label>
          Observed title
          <input value={pageTitle} onChange={(event) => setPageTitle(event.target.value)} required />
        </label>
      ) : null}
      <AuditCheckSelect label="Contact details" value={contactState} onChange={setContactState} />
      <AuditCheckSelect label="Contact form" value={formState} onChange={setFormState} />
      <AuditCheckSelect label="Service content" value={serviceContentState} onChange={setServiceContentState} />
      <AuditCheckSelect label="Photographs" value={photoState} onChange={setPhotoState} />
      <label>
        Observed service names
        <input
          value={serviceNames}
          onChange={(event) => setServiceNames(event.target.value)}
          placeholder="Painting, Roofing"
        />
      </label>
      <label>
        Broken links recorded
        <input
          value={brokenLinks}
          onChange={(event) => setBrokenLinks(event.target.value)}
          placeholder="Comma-separated full URLs"
        />
      </label>
      <label>
        Audit notes
        <input value={notes} onChange={(event) => setNotes(event.target.value)} />
      </label>
      <button type="submit" disabled={submitting}>
        {submitting ? "Analysing…" : "Create audit"}
      </button>
      {error ? <div className="error-banner">{error}</div> : null}
    </form>
  );
}

function AuditCheckSelect({
  label,
  value,
  onChange,
}: {
  label: string;
  value: CheckState;
  onChange: (value: CheckState) => void;
}) {
  return (
    <label>
      {label}
      <select value={value} onChange={(event) => onChange(event.target.value as CheckState)}>
        <option value="">Not checked / unknown</option>
        <option value="present">Present</option>
        <option value="missing">Missing</option>
      </select>
    </label>
  );
}
