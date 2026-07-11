import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError, type JobOpening, type RecruitmentRecommendation } from "../api/client";

// Recruitment and Workforce Expansion Module — a real hiring need the user
// entered (role, skills, reason, urgency), tracked through to candidates.
// This module never legally hires anyone, sets a wage, or confirms
// employment terms — it only tracks openings/candidates and drafts content
// for the user to review and place manually.
export function Recruitment() {
  const [openings, setOpenings] = useState<JobOpening[] | null>(null);
  const [recommendation, setRecommendation] = useState<RecruitmentRecommendation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  function load() {
    Promise.all([api.recruitment.listJobOpenings(), api.recruitment.capacityRecommendation()])
      .then(([openingResult, recommendationResult]) => {
        setOpenings(openingResult);
        setRecommendation(recommendationResult);
      })
      .catch(() => setError("Could not load job openings."));
  }

  useEffect(load, []);

  if (error) return <div className="error-banner">{error}</div>;
  if (!openings || !recommendation) return <p>Loading…</p>;

  return (
    <div>
      <div className="page-header">
        <h1>Recruitment</h1>
        <button onClick={() => setShowForm((v) => !v)}>{showForm ? "Cancel" : "New job opening"}</button>
      </div>
      <p className="hint">
        Tracks real hiring needs and candidates only — no advert is placed and no employment
        terms are confirmed automatically; that always stays a manual, deliberate step.
      </p>
      <CapacityRecommendation recommendation={recommendation} />
      {showForm && (
        <NewOpeningForm
          onCreated={() => {
            setShowForm(false);
            load();
          }}
        />
      )}
      {openings.length === 0 ? (
        <p className="hint">No job openings yet.</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Title</th>
              <th>Status</th>
              <th>Urgency</th>
              <th>Skills</th>
              <th>Candidates</th>
            </tr>
          </thead>
          <tbody>
            {openings.map((o) => (
              <tr key={o.id}>
                <td>
                  <Link to={`/recruitment/${o.id}`}>{o.title}</Link>
                </td>
                <td>{o.openingStatus}</td>
                <td>{o.urgency}</td>
                <td>
                  {o.skillsRequired.length === 0 ? (
                    <span className="hint">—</span>
                  ) : (
                    o.skillsRequired.map((s) => (
                      <span className="skill-tag" key={s}>
                        {s}
                      </span>
                    ))
                  )}
                </td>
                <td>{o.candidates.length}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function CapacityRecommendation({ recommendation }: { recommendation: RecruitmentRecommendation }) {
  if (!recommendation.recommendation) {
    return <div className="card" style={{ marginBottom: 20 }}>
      <h2>Capacity-backed recommendation</h2>
      <p>No recruitment recommendation yet. {recommendation.reason}</p>
      <p className="hint">Evidence: {recommendation.evidence.distinctOverloadedWeeks} distinct overloaded week(s) in the next {recommendation.evidence.weeksAhead} weeks.</p>
    </div>;
  }
  const detail = recommendation.recommendation;
  return <div className="warning-banner" style={{ marginBottom: 20 }}>
    <h2>Recruitment review recommended</h2>
    <p>{recommendation.reason}</p>
    <dl className="detail-list">
      <dt>Role</dt><dd>{detail.role}</dd>
      <dt>Skills</dt><dd>{detail.requiredSkills.length ? detail.requiredSkills.join(", ") : "Unknown — review required"}</dd>
      <dt>Evidence tasks</dt><dd>{detail.expectedTasks.length ? detail.expectedTasks.join("; ") : "Unknown — review required"}</dd>
      <dt>Urgency</dt><dd>{detail.urgency}</dd>
      <dt>Fastest route</dt><dd>{detail.fastestRoute}</dd>
    </dl>
    <p className="hint">Decision support only. No opening, advert, candidate action or employment commitment was created.</p>
    {recommendation.missingData.length ? <p className="hint">Missing evidence: {recommendation.missingData.join(", ")}</p> : null}
  </div>;
}

function NewOpeningForm({ onCreated }: { onCreated: () => void }) {
  const [title, setTitle] = useState("");
  const [reason, setReason] = useState("");
  const [urgency, setUrgency] = useState("medium");
  const [skills, setSkills] = useState("");
  const [expectedTasks, setExpectedTasks] = useState("");
  const [minExperience, setMinExperience] = useState("");
  const [languages, setLanguages] = useState("");
  const [availability, setAvailability] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await api.recruitment.createJobOpening({
        title,
        reason: reason || undefined,
        urgency,
        skills_required: skills ? skills.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
        expected_tasks: expectedTasks || undefined,
        min_experience_years: minExperience ? Number(minExperience) : undefined,
        language_requirements: languages ? languages.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
        availability_requirements: availability || undefined,
        description: description || undefined,
      });
      setTitle("");
      setReason("");
      setSkills("");
      setExpectedTasks("");
      setMinExperience("");
      setLanguages("");
      setAvailability("");
      setDescription("");
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create job opening.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="inline-form" onSubmit={handleSubmit}>
      <input placeholder="Role title" value={title} onChange={(e) => setTitle(e.target.value)} required />
      <select value={urgency} onChange={(e) => setUrgency(e.target.value)}>
        <option value="low">Low urgency</option>
        <option value="medium">Medium urgency</option>
        <option value="high">High urgency</option>
      </select>
      <input placeholder="Reason for hiring" value={reason} onChange={(e) => setReason(e.target.value)} />
      <input placeholder="Required skills (comma-separated)" value={skills} onChange={(e) => setSkills(e.target.value)} />
      <input placeholder="Expected tasks" value={expectedTasks} onChange={(e) => setExpectedTasks(e.target.value)} />
      <input
        placeholder="Min. experience (years)"
        type="number"
        min="0"
        step="0.5"
        style={{ width: 150 }}
        value={minExperience}
        onChange={(e) => setMinExperience(e.target.value)}
      />
      <input
        placeholder="Language requirements (comma-separated)"
        value={languages}
        onChange={(e) => setLanguages(e.target.value)}
      />
      <input placeholder="Availability requirements" value={availability} onChange={(e) => setAvailability(e.target.value)} />
      <input placeholder="Description" value={description} onChange={(e) => setDescription(e.target.value)} />
      <button type="submit" disabled={submitting}>
        {submitting ? "Saving…" : "Save"}
      </button>
      {error && <div className="error-banner">{error}</div>}
    </form>
  );
}
