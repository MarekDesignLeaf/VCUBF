import { useEffect, useState } from "react";
import {
  api,
  ApiError,
  PORTFOLIO_PHOTO_SOURCE_LABELS,
  type PhotoSelectionPreview,
  type PhotoSelectionWorkspace,
  type ServiceCatalogueItem,
} from "../api/client";

const BLOCKER_LABELS: Record<string, string> = {
  SERVICE_RELEVANCE_NOT_FOUND: "No current service evidence",
  MARKETING_USE_NOT_APPROVED: "Marketing use is not approved",
  TAKEN_DATE_MISSING: "Date taken is missing",
  QUALITY_NOT_APPROVED: "Quality review is not approved",
  DUPLICATE_NOT_CLEARED: "Duplicate review is not cleared",
  SENSITIVE_DATA_NOT_CLEARED: "Sensitive-data review is not cleared",
  USAGE_PERMISSION_NOT_CONFIRMED: "Usage permission is not confirmed",
  OWN_PRODUCTION_SOURCE_REQUIRED: "Source is not recorded as own production",
};

const REASON_LABELS: Record<string, string> = {
  linked_job_service: "Job is linked to this service",
  exact_service_name_tag: "Exact service-name tag",
};

export function PhotoSelection() {
  const [services, setServices] = useState<ServiceCatalogueItem[]>([]);
  const [serviceId, setServiceId] = useState("");
  const [ownProductionOnly, setOwnProductionOnly] = useState(true);
  const [workspace, setWorkspace] = useState<PhotoSelectionWorkspace | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [reviewNotes, setReviewNotes] = useState("");
  const [preview, setPreview] = useState<PhotoSelectionPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.catalogue
      .list(true)
      .then((result) => {
        if (cancelled) return;
        setServices(result);
        setServiceId((current) => current || result[0]?.id || "");
      })
      .catch(() => {
        if (!cancelled) setError("Could not load the Service Catalogue.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!serviceId) {
      setWorkspace(null);
      setSelectedIds([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSuccess(null);
    setPreview(null);
    api.portfolio
      .selectionWorkspace(serviceId, ownProductionOnly)
      .then((result) => {
        if (cancelled) return;
        setWorkspace(result);
        setSelectedIds(result.selectedPhotoIds);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : "Could not load photo candidates.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [serviceId, ownProductionOnly]);

  function togglePhoto(id: string, checked: boolean) {
    setPreview(null);
    setSuccess(null);
    setSelectedIds((current) =>
      checked ? (current.includes(id) ? current : [...current, id]) : current.filter((value) => value !== id)
    );
  }

  async function saveSelection(confirmed: boolean) {
    if (!serviceId) return;
    setSubmitting(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await api.portfolio.selectForService({
        service_catalogue_item_id: serviceId,
        photo_ids: selectedIds,
        own_production_only: ownProductionOnly,
        review_notes: reviewNotes || undefined,
        confirmed,
      });
      setWorkspace(result);
      setSelectedIds(result.selectedPhotoIds);
      setPreview(null);
      setSuccess("The internal service selection was saved. No image was published or moved.");
    } catch (err) {
      if (err instanceof ApiError && err.code === "CONFIRMATION_REQUIRED") {
        setPreview((err.details?.preview as PhotoSelectionPreview) ?? null);
      } else {
        setError(err instanceof ApiError ? err.message : "Could not save the photo selection.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1>Photo Selection by Service</h1>
      </div>
      <p className="hint">
        Candidates come only from a job linked to the service or an exact user-entered service tag.
        Secretary has no image files here and performs no visual quality analysis. Human review states
        must be complete before a reference can be selected. Saving is internal only and never publishes.
      </p>

      <div className="inline-form">
        <label>
          Service
          <select value={serviceId} onChange={(event) => setServiceId(event.target.value)}>
            {services.length === 0 ? <option value="">No active services</option> : null}
            {services.map((service) => (
              <option key={service.id} value={service.id}>
                {service.name}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 22 }}>
          <input
            type="checkbox"
            checked={ownProductionOnly}
            onChange={(event) => setOwnProductionOnly(event.target.checked)}
          />
          Require own-production source
        </label>
      </div>

      {error ? <div className="error-banner">{error}</div> : null}
      {success ? <div className="warning-banner">{success}</div> : null}

      {loading ? (
        <p>Loading…</p>
      ) : !workspace ? (
        <p className="hint">Select an active service to inspect candidates.</p>
      ) : workspace.candidates.length === 0 ? (
        <p className="hint">
          No photo references have an explicit job/service link or exact service tag for {workspace.service.name}.
        </p>
      ) : (
        <>
          <table className="data-table">
            <thead>
              <tr>
                <th>Select</th>
                <th>Reference</th>
                <th>Evidence</th>
                <th>Source / date</th>
                <th>Review</th>
              </tr>
            </thead>
            <tbody>
              {workspace.candidates.map((candidate) => {
                const checked = selectedIds.includes(candidate.photo.id);
                return (
                  <tr key={candidate.photo.id}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Select ${candidate.photo.filename}`}
                        checked={checked}
                        disabled={!candidate.eligible && !checked}
                        onChange={(event) => togglePhoto(candidate.photo.id, event.target.checked)}
                      />
                    </td>
                    <td>
                      <strong>{candidate.photo.filename}</strong>
                      <div className="hint">{candidate.photo.caption || "No caption"}</div>
                    </td>
                    <td>
                      {candidate.reasons.map((reason) => REASON_LABELS[reason] ?? reason).join("; ") || "None"}
                    </td>
                    <td>
                      {PORTFOLIO_PHOTO_SOURCE_LABELS[candidate.photo.source]}
                      <div className="hint">
                        {candidate.photo.takenAt ? new Date(candidate.photo.takenAt).toLocaleDateString() : "Date missing"}
                      </div>
                    </td>
                    <td>
                      {candidate.eligible ? (
                        <span className="status-pill status-dokonceno">Eligible</span>
                      ) : (
                        <ul style={{ margin: 0, paddingLeft: 18 }}>
                          {candidate.blockers.map((blocker) => (
                            <li key={blocker}>{BLOCKER_LABELS[blocker] ?? blocker}</li>
                          ))}
                        </ul>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <div className="inline-form" style={{ marginTop: 16 }}>
            <label style={{ flex: 1 }}>
              Selection notes
              <input
                value={reviewNotes}
                onChange={(event) => {
                  setReviewNotes(event.target.value);
                  setPreview(null);
                }}
                placeholder="Human review notes"
                style={{ width: "100%" }}
              />
            </label>
            <button onClick={() => saveSelection(false)} disabled={submitting} style={{ marginTop: 20 }}>
              {submitting ? "Checking…" : "Preview exact selection"}
            </button>
          </div>
        </>
      )}

      {preview ? (
        <section className="warning-banner" aria-labelledby="photo-selection-preview-heading">
          <h2 id="photo-selection-preview-heading">Confirm internal selection</h2>
          <p>
            Add {preview.addedPhotoIds.length}, remove {preview.removedPhotoIds.length}, keep{" "}
            {preview.unchangedPhotoIds.length}. Final selected references: {preview.requestedPhotos.length}.
          </p>
          <ul>
            {preview.requestedPhotos.map((photo) => (
              <li key={photo.id}>{photo.filename}</li>
            ))}
          </ul>
          <p className="hint">No publication or file movement will occur.</p>
          <button onClick={() => saveSelection(true)} disabled={submitting} style={{ marginRight: 8 }}>
            {submitting ? "Saving…" : "Confirm selection"}
          </button>
          <button className="secondary" onClick={() => setPreview(null)} disabled={submitting}>
            Back
          </button>
        </section>
      ) : null}
    </div>
  );
}
