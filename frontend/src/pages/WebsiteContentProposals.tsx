import { useEffect, useState } from "react";
import {
  api,
  ApiError,
  WEBSITE_CONTENT_PROPOSAL_TYPES,
  WEBSITE_CONTENT_PROPOSAL_TYPE_LABELS,
  type BusinessContextItem,
  type PortfolioPhoto,
  type ServiceCatalogueItem,
  type WebsiteAudit,
  type WebsiteAuditFinding,
  type WebsiteContentProposal,
  type WebsiteContentProposalDecisionPreview,
  type WebsiteContentProposalType,
} from "../api/client";

const REVIEW_STATUSES = ["ready_for_review", "approved", "rejected"] as const;

function toggleSelection(current: string[], id: string, checked: boolean) {
  if (checked) return current.includes(id) ? current : [...current, id];
  return current.filter((currentId) => currentId !== id);
}

// Website Content Workflow — proposals are manual drafts backed by selected,
// verified Secretary records. Approval is a two-step preview + confirmation
// action. There is deliberately no publish button or publish API in this MVP
// slice: approval changes internal state only.
export function WebsiteContentProposals() {
  const [proposals, setProposals] = useState<WebsiteContentProposal[] | null>(null);
  const [selectedProposal, setSelectedProposal] = useState<WebsiteContentProposal | null>(null);
  const [statusFilter, setStatusFilter] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setProposals(null);
    api.websiteContentProposals
      .list(statusFilter || undefined)
      .then((result) => {
        if (!cancelled) setProposals(result);
      })
      .catch(() => {
        if (!cancelled) setError("Could not load website content proposals.");
      });
    return () => {
      cancelled = true;
    };
  }, [statusFilter]);

  async function viewProposal(id: string) {
    setError(null);
    try {
      setSelectedProposal(await api.websiteContentProposals.get(id));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load the proposal.");
    }
  }

  function handleCreated(created: WebsiteContentProposal) {
    setProposals((current) => [created, ...(current ?? []).filter((proposal) => proposal.id !== created.id)]);
    setSelectedProposal(created);
    setShowForm(false);
  }

  function handleUpdated(updated: WebsiteContentProposal) {
    setProposals((current) =>
      (current ?? []).map((proposal) => (proposal.id === updated.id ? updated : proposal))
    );
    setSelectedProposal(updated);
  }

  return (
    <div>
      <div className="page-header">
        <h1>Website Content Proposals</h1>
        <button onClick={() => setShowForm((current) => !current)}>
          {showForm ? "Cancel" : "Prepare proposal"}
        </button>
      </div>
      <p className="hint">
        Draft content from selected, verified Secretary records and send it through explicit
        review. Approval is an internal status only. This module has no website connector and
        cannot publish or verify a public change.
      </p>

      {showForm ? <WebsiteContentProposalForm onCreated={handleCreated} /> : null}
      {error ? <div className="error-banner">{error}</div> : null}

      <div className="inline-form" style={{ marginTop: 16 }}>
        <label>
          Status
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
            <option value="">All statuses</option>
            {REVIEW_STATUSES.map((status) => (
              <option key={status} value={status}>
                {status.replaceAll("_", " ")}
              </option>
            ))}
          </select>
        </label>
      </div>

      {!proposals ? (
        <p>Loading…</p>
      ) : proposals.length === 0 ? (
        <p className="hint">No website content proposals found.</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Type</th>
              <th>Target page</th>
              <th>Headline</th>
              <th>Status</th>
              <th>Created</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {proposals.map((proposal) => (
              <tr key={proposal.id}>
                <td>{WEBSITE_CONTENT_PROPOSAL_TYPE_LABELS[proposal.proposalType]}</td>
                <td>{proposal.targetPageUrl}</td>
                <td>{proposal.headline ?? "—"}</td>
                <td>
                  <span className={`status-pill status-${proposal.status}`}>{proposal.status.replaceAll("_", " ")}</span>
                </td>
                <td>{new Date(proposal.createdAt).toLocaleString()}</td>
                <td>
                  <button className="secondary" onClick={() => viewProposal(proposal.id)}>
                    Review
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {selectedProposal ? (
        <WebsiteContentProposalDetail proposal={selectedProposal} onUpdated={handleUpdated} />
      ) : null}
    </div>
  );
}

function WebsiteContentProposalDetail({
  proposal,
  onUpdated,
}: {
  proposal: WebsiteContentProposal;
  onUpdated: (proposal: WebsiteContentProposal) => void;
}) {
  const [decision, setDecision] = useState<"approved" | "rejected">("approved");
  const [decisionNotes, setDecisionNotes] = useState("");
  const [preview, setPreview] = useState<WebsiteContentProposalDecisionPreview | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sources = proposal.sourceSnapshot;

  async function requestDecisionPreview() {
    setSubmitting(true);
    setError(null);
    try {
      await api.websiteContentProposals.decide(proposal.id, decision, decisionNotes, false);
      setError("Unexpected response: the decision was not previewed.");
    } catch (err) {
      if (err instanceof ApiError && err.code === "CONFIRMATION_REQUIRED") {
        setPreview((err.details?.preview as WebsiteContentProposalDecisionPreview) ?? null);
      } else {
        setError(err instanceof ApiError ? err.message : "Could not preview the decision.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function confirmDecision() {
    if (!preview) return;
    setSubmitting(true);
    setError(null);
    try {
      onUpdated(await api.websiteContentProposals.decide(proposal.id, decision, decisionNotes, true));
      setPreview(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not record the decision.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section style={{ marginTop: 24 }} aria-labelledby="website-proposal-detail-heading">
      <h2 id="website-proposal-detail-heading">Proposal review</h2>
      <p>
        <strong>Target:</strong> {proposal.targetPageUrl}
      </p>
      {proposal.headline ? <h3>{proposal.headline}</h3> : null}
      <pre style={{ whiteSpace: "pre-wrap", fontFamily: "inherit" }}>{proposal.contentBody}</pre>
      {proposal.notes ? <p className="hint">Draft notes: {proposal.notes}</p> : null}

      <h3>Evidence snapshot</h3>
      <ul>
        <li>Website audit: {sources.websiteAudit ? sources.websiteAudit.websiteUrl : "none"}</li>
        <li>Confirmed Business Context items: {sources.businessContext.length}</li>
        <li>Active services: {sources.services.map((service) => service.name).join(", ") || "none"}</li>
        <li>Reviewed photographs: {sources.photos.map((photo) => photo.filename).join(", ") || "none"}</li>
        <li>Audit findings: {sources.auditFindings.map((finding) => finding.title).join(", ") || "none"}</li>
      </ul>

      {proposal.status === "ready_for_review" ? (
        <div className="warning-banner">
          <h3>Decision</h3>
          <label>
            <input
              type="radio"
              name={`decision-${proposal.id}`}
              checked={decision === "approved"}
              onChange={() => {
                setDecision("approved");
                setPreview(null);
              }}
            />{" "}
            Approve for a future, separate publication workflow
          </label>
          <label style={{ display: "block" }}>
            <input
              type="radio"
              name={`decision-${proposal.id}`}
              checked={decision === "rejected"}
              onChange={() => {
                setDecision("rejected");
                setPreview(null);
              }}
            />{" "}
            Reject
          </label>
          <label style={{ display: "block", marginTop: 8 }}>
            Decision notes
            <input
              value={decisionNotes}
              onChange={(event) => {
                setDecisionNotes(event.target.value);
                setPreview(null);
              }}
            />
          </label>
          {error ? <div className="error-banner">{error}</div> : null}
          {preview ? (
            <div style={{ marginTop: 12 }}>
              <strong>Confirm status change:</strong>
              <p>
                {preview.currentStatus.replaceAll("_", " ")} → {preview.proposedStatus}
              </p>
              <p className="hint">
                This records the review decision only. It does not publish the content.
              </p>
              <button onClick={confirmDecision} disabled={submitting} style={{ marginRight: 8 }}>
                {submitting ? "Saving…" : `Confirm ${preview.proposedStatus}`}
              </button>
              <button className="secondary" onClick={() => setPreview(null)} disabled={submitting}>
                Back
              </button>
            </div>
          ) : (
            <button onClick={requestDecisionPreview} disabled={submitting} style={{ marginTop: 12 }}>
              {submitting ? "Checking…" : "Preview decision"}
            </button>
          )}
        </div>
      ) : (
        <p>
          <strong>Decision:</strong> {proposal.status}
          {proposal.decisionNotes ? ` — ${proposal.decisionNotes}` : ""}
        </p>
      )}
    </section>
  );
}

function WebsiteContentProposalForm({
  onCreated,
}: {
  onCreated: (proposal: WebsiteContentProposal) => void;
}) {
  const [services, setServices] = useState<ServiceCatalogueItem[]>([]);
  const [contexts, setContexts] = useState<BusinessContextItem[]>([]);
  const [photos, setPhotos] = useState<PortfolioPhoto[]>([]);
  const [audits, setAudits] = useState<WebsiteAudit[]>([]);
  const [auditFindings, setAuditFindings] = useState<WebsiteAuditFinding[]>([]);
  const [sourcesLoading, setSourcesLoading] = useState(true);
  const [proposalType, setProposalType] = useState<WebsiteContentProposalType>("service_page");
  const [targetPageUrl, setTargetPageUrl] = useState("");
  const [headline, setHeadline] = useState("");
  const [contentBody, setContentBody] = useState("");
  const [notes, setNotes] = useState("");
  const [websiteAuditId, setWebsiteAuditId] = useState("");
  const [contextIds, setContextIds] = useState<string[]>([]);
  const [serviceIds, setServiceIds] = useState<string[]>([]);
  const [photoIds, setPhotoIds] = useState<string[]>([]);
  const [findingIds, setFindingIds] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.catalogue.list(true),
      api.businessContext.list({ activeOnly: true }),
      api.portfolio.list({ usableForMarketing: true }),
      api.websiteAudits.list(),
    ])
      .then(([serviceResult, contextResult, photoResult, auditResult]) => {
        if (cancelled) return;
        setServices(serviceResult);
        setContexts(contextResult.filter((context) => context.verificationStatus === "confirmed"));
        setPhotos(
          photoResult.filter(
            (photo) =>
              Boolean(photo.takenAt) &&
              photo.qualityReviewStatus === "approved" &&
              photo.duplicateReviewStatus === "unique" &&
              photo.sensitiveDataReviewStatus === "clear" &&
              ["confirmed", "not_required"].includes(photo.usagePermissionStatus)
          )
        );
        setAudits(auditResult);
      })
      .catch(() => {
        if (!cancelled) setError("Could not load verified proposal sources.");
      })
      .finally(() => {
        if (!cancelled) setSourcesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function changeAudit(id: string) {
    setWebsiteAuditId(id);
    setFindingIds([]);
    setAuditFindings([]);
    if (!id) return;
    try {
      const audit = await api.websiteAudits.get(id);
      setAuditFindings(audit.findings ?? []);
      setTargetPageUrl((current) => current || audit.websiteUrl);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load audit findings.");
    }
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      onCreated(
        await api.websiteContentProposals.create({
          website_audit_id: websiteAuditId || undefined,
          proposal_type: proposalType,
          target_page_url: targetPageUrl,
          headline: headline || undefined,
          content_body: contentBody,
          notes: notes || undefined,
          business_context_ids: contextIds,
          service_catalogue_item_ids: serviceIds,
          portfolio_photo_ids: photoIds,
          website_audit_finding_ids: findingIds,
        })
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not prepare the proposal.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="inline-form" onSubmit={handleSubmit}>
      <label>
        Proposal type
        <select
          value={proposalType}
          onChange={(event) => setProposalType(event.target.value as WebsiteContentProposalType)}
        >
          {WEBSITE_CONTENT_PROPOSAL_TYPES.map((type) => (
            <option key={type} value={type}>
              {WEBSITE_CONTENT_PROPOSAL_TYPE_LABELS[type]}
            </option>
          ))}
        </select>
      </label>
      <label>
        Target page URL
        <input
          type="url"
          value={targetPageUrl}
          onChange={(event) => setTargetPageUrl(event.target.value)}
          required
        />
      </label>
      <label>
        Headline
        <input value={headline} onChange={(event) => setHeadline(event.target.value)} />
      </label>
      <label style={{ flexBasis: "100%" }}>
        Proposed content
        <textarea
          value={contentBody}
          onChange={(event) => setContentBody(event.target.value)}
          rows={6}
          required
          style={{ width: "100%" }}
        />
      </label>
      <label>
        Notes
        <input value={notes} onChange={(event) => setNotes(event.target.value)} />
      </label>

      {sourcesLoading ? <p>Loading verified sources…</p> : null}
      <fieldset>
        <legend>Website audit source</legend>
        <select value={websiteAuditId} onChange={(event) => changeAudit(event.target.value)}>
          <option value="">No linked audit</option>
          {audits.map((audit) => (
            <option key={audit.id} value={audit.id}>
              {audit.websiteUrl} — {new Date(audit.createdAt).toLocaleDateString()}
            </option>
          ))}
        </select>
        {auditFindings.map((finding) => (
          <SourceCheckbox
            key={finding.id}
            label={`${finding.severity}: ${finding.title}`}
            checked={findingIds.includes(finding.id)}
            onChange={(checked) => setFindingIds((current) => toggleSelection(current, finding.id, checked))}
          />
        ))}
      </fieldset>
      <SourceGroup
        legend="Confirmed Business Context"
        items={contexts.map((context) => ({ id: context.id, label: `${context.label}: ${context.value}` }))}
        selectedIds={contextIds}
        setSelectedIds={setContextIds}
      />
      <SourceGroup
        legend="Active services"
        items={services.map((service) => ({ id: service.id, label: service.name }))}
        selectedIds={serviceIds}
        setSelectedIds={setServiceIds}
      />
      <SourceGroup
        legend="Reviewed photographs"
        items={photos.map((photo) => ({ id: photo.id, label: photo.filename }))}
        selectedIds={photoIds}
        setSelectedIds={setPhotoIds}
      />

      <button type="submit" disabled={submitting || sourcesLoading}>
        {submitting ? "Preparing…" : "Prepare for review"}
      </button>
      {error ? <div className="error-banner">{error}</div> : null}
    </form>
  );
}

function SourceGroup({
  legend,
  items,
  selectedIds,
  setSelectedIds,
}: {
  legend: string;
  items: Array<{ id: string; label: string }>;
  selectedIds: string[];
  setSelectedIds: React.Dispatch<React.SetStateAction<string[]>>;
}) {
  return (
    <fieldset>
      <legend>{legend}</legend>
      {items.length === 0 ? <span className="hint">None available</span> : null}
      {items.map((item) => (
        <SourceCheckbox
          key={item.id}
          label={item.label}
          checked={selectedIds.includes(item.id)}
          onChange={(checked) =>
            setSelectedIds((current) => toggleSelection(current, item.id, checked))
          }
        />
      ))}
    </fieldset>
  );
}

function SourceCheckbox({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label style={{ display: "block" }}>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /> {label}
    </label>
  );
}
