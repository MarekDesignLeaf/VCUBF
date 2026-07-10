import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  api,
  ApiError,
  type PortfolioPhoto,
  type Client,
  PORTFOLIO_PHOTO_SOURCES,
  PORTFOLIO_PHOTO_SOURCE_LABELS,
} from "../api/client";

// Portfolio and Photo Intelligence Module — the manual-entry foundation of a
// future automated photo-selection/website-publishing workflow. There is no
// image upload/storage connector yet, so every record here is typed in by
// hand: `filename` is exactly the reference the user entered, `source` is
// always picked from a fixed list, never guessed. Flipping "usable for
// marketing" is only an internal review tag reviewed by a human — it does
// not publish anything to a website or social channel by itself, since no
// such connector exists yet.
export function Portfolio() {
  const [searchParams] = useSearchParams();
  const prefillClientId = searchParams.get("client_id") ?? "";
  const prefillJobId = searchParams.get("job_id") ?? "";

  const [photos, setPhotos] = useState<PortfolioPhoto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(Boolean(prefillClientId || prefillJobId));
  const [tagFilter, setTagFilter] = useState("");
  const [sourceFilter, setSourceFilter] = useState("");
  const [marketingOnly, setMarketingOnly] = useState(false);

  function load() {
    api.portfolio
      .list({
        tag: tagFilter || undefined,
        source: sourceFilter || undefined,
        usableForMarketing: marketingOnly ? true : undefined,
      })
      .then(setPhotos)
      .catch(() => setError("Could not load photos."));
  }

  useEffect(load, [tagFilter, sourceFilter, marketingOnly]);

  if (error) return <div className="error-banner">{error}</div>;

  return (
    <div>
      <div className="page-header">
        <h1>Portfolio Photos</h1>
        <button onClick={() => setShowForm((v) => !v)}>{showForm ? "Cancel" : "Log photo"}</button>
      </div>
      <p className="hint">
        Manual entry only — there is no image upload/storage connector yet, so no actual image
        files are stored here, only real photo references (filename, caption, tags, source) you
        enter by hand. "Usable for marketing" is an internal review tag only; nothing is
        published to a website or social channel by this module.
      </p>

      {showForm && (
        <LogPortfolioPhotoForm
          defaultClientId={prefillClientId}
          defaultJobId={prefillJobId}
          onCreated={() => {
            setShowForm(false);
            load();
          }}
        />
      )}

      <div className="inline-form" style={{ marginTop: 16 }}>
        <input placeholder="Filter by tag" value={tagFilter} onChange={(e) => setTagFilter(e.target.value)} />
        <select value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)}>
          <option value="">All sources</option>
          {PORTFOLIO_PHOTO_SOURCES.map((s) => (
            <option key={s} value={s}>
              {PORTFOLIO_PHOTO_SOURCE_LABELS[s]}
            </option>
          ))}
        </select>
        <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <input type="checkbox" checked={marketingOnly} onChange={(e) => setMarketingOnly(e.target.checked)} />
          Usable for marketing only
        </label>
      </div>

      {!photos ? (
        <p>Loading…</p>
      ) : photos.length === 0 ? (
        <p className="hint">No photos logged yet.</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Filename</th>
              <th>Client</th>
              <th>Job</th>
              <th>Tags</th>
              <th>Source</th>
              <th>Caption</th>
              <th>Marketing</th>
            </tr>
          </thead>
          <tbody>
            {photos.map((p) => (
              <tr key={p.id}>
                <td>{p.filename}</td>
                <td>{p.client ? <Link to={`/clients/${p.client.id}`}>{p.client.displayName}</Link> : "—"}</td>
                <td>{p.job ? <Link to={`/jobs/${p.job.id}`}>{p.job.jobTitle}</Link> : "—"}</td>
                <td>
                  {p.tags.length > 0
                    ? p.tags.map((t) => (
                        <span className="skill-tag" key={t}>
                          {t}
                        </span>
                      ))
                    : "—"}
                </td>
                <td>{PORTFOLIO_PHOTO_SOURCE_LABELS[p.source]}</td>
                <td>{p.caption ?? "—"}</td>
                <td>{p.usableForMarketing ? "Yes" : "No"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function LogPortfolioPhotoForm({
  defaultClientId = "",
  defaultJobId = "",
  onCreated,
}: {
  defaultClientId?: string;
  defaultJobId?: string;
  onCreated: () => void;
}) {
  const [clients, setClients] = useState<Client[]>([]);
  const [clientId, setClientId] = useState(defaultClientId);
  const jobId = defaultJobId;
  const [filename, setFilename] = useState("");
  const [caption, setCaption] = useState("");
  const [tags, setTags] = useState("");
  const [source, setSource] = useState<string>("employee_upload");
  const [usableForMarketing, setUsableForMarketing] = useState(false);
  const [usableForMarketingNotes, setUsableForMarketingNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (defaultClientId) return;
    api.clients.list().then(setClients).catch(() => undefined);
  }, [defaultClientId]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await api.portfolio.create({
        client_id: clientId || undefined,
        job_id: jobId || undefined,
        filename,
        caption: caption || undefined,
        tags: tags
          ? tags.split(",").map((t) => t.trim()).filter(Boolean)
          : undefined,
        source,
        usable_for_marketing: usableForMarketing,
        usable_for_marketing_notes: usableForMarketing && usableForMarketingNotes ? usableForMarketingNotes : undefined,
      });
      setFilename("");
      setCaption("");
      setTags("");
      setUsableForMarketing(false);
      setUsableForMarketingNotes("");
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not log photo.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="inline-form" onSubmit={handleSubmit}>
      {!defaultClientId && (
        <select value={clientId} onChange={(e) => setClientId(e.target.value)}>
          <option value="">— No client —</option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.displayName}
            </option>
          ))}
        </select>
      )}
      <input
        placeholder="Filename (e.g. IMG_001.jpg)"
        value={filename}
        onChange={(e) => setFilename(e.target.value)}
        required
      />
      <input placeholder="Caption" value={caption} onChange={(e) => setCaption(e.target.value)} style={{ minWidth: 220 }} />
      <input placeholder="Tags (comma-separated)" value={tags} onChange={(e) => setTags(e.target.value)} />
      <select value={source} onChange={(e) => setSource(e.target.value)}>
        {PORTFOLIO_PHOTO_SOURCES.map((s) => (
          <option key={s} value={s}>
            {PORTFOLIO_PHOTO_SOURCE_LABELS[s]}
          </option>
        ))}
      </select>
      <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <input
          type="checkbox"
          checked={usableForMarketing}
          onChange={(e) => setUsableForMarketing(e.target.checked)}
        />
        Usable for marketing
      </label>
      {usableForMarketing && (
        <input
          placeholder="Notes (e.g. client gave written permission)"
          value={usableForMarketingNotes}
          onChange={(e) => setUsableForMarketingNotes(e.target.value)}
          style={{ minWidth: 220 }}
        />
      )}
      <button type="submit" disabled={submitting}>
        {submitting ? "Saving…" : "Save"}
      </button>
      {error && <div className="error-banner">{error}</div>}
    </form>
  );
}
