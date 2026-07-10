import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import {
  api,
  ApiError,
  JOB_OPENING_STATUSES,
  CANDIDATE_STAGES,
  CANDIDATE_STAGE_LABELS,
  type JobOpening,
} from "../api/client";

export function JobOpeningDetail() {
  const { id } = useParams<{ id: string }>();
  const [opening, setOpening] = useState<JobOpening | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [showCandidateForm, setShowCandidateForm] = useState(false);

  function load() {
    if (!id) return;
    api.recruitment
      .getJobOpening(id)
      .then(setOpening)
      .catch(() => setError("Job opening not found."));
  }

  useEffect(load, [id]);

  async function handleStatusChange(status: string) {
    if (!id) return;
    try {
      const updated = await api.recruitment.updateJobOpening(id, { opening_status: status });
      setOpening(updated);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not change status.");
    }
  }

  async function handleDraftAdvert() {
    if (!id) return;
    setDrafting(true);
    setError(null);
    try {
      const updated = await api.recruitment.draftAdvert(id);
      setOpening(updated);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not draft advert.");
    } finally {
      setDrafting(false);
    }
  }

  async function handleCandidateStageChange(candidateId: string, stage: string) {
    try {
      await api.recruitment.updateCandidate(candidateId, { stage });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not update candidate.");
    }
  }

  if (error && !opening) return <div className="error-banner">{error}</div>;
  if (!opening) return <p>Loading…</p>;

  return (
    <div>
      <Link to="/recruitment">← Back to recruitment</Link>
      <h1>{opening.title}</h1>
      {error && <div className="error-banner">{error}</div>}

      <dl className="detail-list">
        <dt>Status</dt>
        <dd>
          <select value={opening.openingStatus} onChange={(e) => handleStatusChange(e.target.value)}>
            {JOB_OPENING_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </dd>
        <dt>Urgency</dt>
        <dd>{opening.urgency}</dd>
        <dt>Reason</dt>
        <dd>{opening.reason ?? "—"}</dd>
        <dt>Skills required</dt>
        <dd>
          {opening.skillsRequired.length === 0 ? (
            <span className="hint">—</span>
          ) : (
            opening.skillsRequired.map((s) => (
              <span className="skill-tag" key={s}>
                {s}
              </span>
            ))
          )}
        </dd>
        <dt>Expected tasks</dt>
        <dd>{opening.expectedTasks ?? "—"}</dd>
        <dt>Experience</dt>
        <dd>
          {opening.minExperienceYears != null ? `${opening.minExperienceYears}+ years min` : "—"}
          {opening.preferredExperienceYears != null ? `, ${opening.preferredExperienceYears}+ years preferred` : ""}
        </dd>
        <dt>Languages</dt>
        <dd>{opening.languageRequirements.length > 0 ? opening.languageRequirements.join(", ") : "—"}</dd>
        <dt>Availability</dt>
        <dd>{opening.availabilityRequirements ?? "—"}</dd>
        <dt>Description</dt>
        <dd>{opening.description ?? "—"}</dd>
      </dl>

      <div className="page-header">
        <h2>Draft advert</h2>
        <button onClick={handleDraftAdvert} disabled={drafting}>
          {drafting ? "Drafting…" : opening.draftAdvertText ? "Regenerate draft" : "Generate draft"}
        </button>
      </div>
      {opening.draftAdvertText ? (
        <pre style={{ whiteSpace: "pre-wrap", fontSize: "0.9rem", background: "var(--surface, #f5f5f5)", padding: 12, borderRadius: 6 }}>{opening.draftAdvertText}</pre>
      ) : (
        <p className="hint">
          No draft yet — generated only from the fields above (pay and employment terms are
          deliberately never included, and nothing is published automatically).
        </p>
      )}

      <div className="page-header">
        <h2>Candidates</h2>
        <button onClick={() => setShowCandidateForm((v) => !v)}>
          {showCandidateForm ? "Cancel" : "Add candidate"}
        </button>
      </div>
      {showCandidateForm && id && (
        <NewCandidateForm
          jobOpeningId={id}
          onCreated={() => {
            setShowCandidateForm(false);
            load();
          }}
        />
      )}
      {opening.candidates.length === 0 ? (
        <p className="hint">No candidates yet.</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Contact</th>
              <th>Stage</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            {opening.candidates.map((c) => (
              <tr key={c.id}>
                <td>{c.name}</td>
                <td>
                  {c.email ?? "—"}
                  {c.phone ? ` / ${c.phone}` : ""}
                </td>
                <td>
                  <select value={c.stage} onChange={(e) => handleCandidateStageChange(c.id, e.target.value)}>
                    {CANDIDATE_STAGES.map((s) => (
                      <option key={s} value={s}>
                        {CANDIDATE_STAGE_LABELS[s]}
                      </option>
                    ))}
                  </select>
                </td>
                <td>{c.notes ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {opening.candidates.some((c) => c.stage === "hired") && (
        <p className="hint">
          A candidate marked "Hired" is only a pipeline record — to give them real system
          access, create an employee account for them from the Employees page.
        </p>
      )}
    </div>
  );
}

function NewCandidateForm({ jobOpeningId, onCreated }: { jobOpeningId: string; onCreated: () => void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await api.recruitment.createCandidate(jobOpeningId, {
        name,
        email: email || undefined,
        phone: phone || undefined,
        notes: notes || undefined,
      });
      setName("");
      setEmail("");
      setPhone("");
      setNotes("");
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not add candidate.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="inline-form" onSubmit={handleSubmit}>
      <input placeholder="Candidate name" value={name} onChange={(e) => setName(e.target.value)} required />
      <input placeholder="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      <input placeholder="Phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
      <input placeholder="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
      <button type="submit" disabled={submitting}>
        {submitting ? "Saving…" : "Save"}
      </button>
      {error && <div className="error-banner">{error}</div>}
    </form>
  );
}
