import { useEffect, useState } from "react";
import {
  api,
  ApiError,
  type ReferenceActivity,
  type ReferenceActivityList,
  type ServiceCatalogueItem,
} from "../api/client";

// Service Catalogue Module — the company's real, user-entered menu of
// services. Nothing shown here is invented: every field is what the user
// typed in. Later modules (quoting, website content) read from this list
// instead of re-typing or guessing service names/prices.
export function ServiceCatalogue() {
  const [services, setServices] = useState<ServiceCatalogueItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [showInactive, setShowInactive] = useState(false);
  const [showReference, setShowReference] = useState(false);

  function load() {
    api.catalogue
      .list()
      .then(setServices)
      .catch(() => setError("Could not load the service catalogue."));
  }

  useEffect(load, []);

  async function toggleActive(service: ServiceCatalogueItem) {
    try {
      await api.catalogue.update(service.id, { is_active: !service.isActive });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not update service.");
    }
  }

  if (error) return <div className="error-banner">{error}</div>;
  if (!services) return <p>Loading…</p>;

  const visible = showInactive ? services : services.filter((s) => s.isActive);

  return (
    <div>
      <div className="page-header">
        <h1>Service catalogue</h1>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="secondary" onClick={() => setShowReference((value) => !value)}>
            {showReference ? "Close reference catalogue" : "Browse reference activities"}
          </button>
          <button onClick={() => setShowForm((v) => !v)}>{showForm ? "Cancel" : "New service"}</button>
        </div>
      </div>
      <p className="hint">
        The real menu of services the company offers — used to prefill jobs (and later quotes and
        website content) instead of retyping or guessing.
      </p>
      {showReference ? <ReferenceActivities onActivated={load} /> : null}
      {showForm && (
        <NewServiceForm
          onCreated={() => {
            setShowForm(false);
            load();
          }}
        />
      )}
      <label style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
        Show inactive services
      </label>
      {visible.length === 0 ? (
        <p className="hint">No services yet.</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Category</th>
              <th>Price</th>
              <th>Default hours</th>
              <th>Skills</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {visible.map((s) => (
              <tr key={s.id}>
                <td>
                  {s.name}
                  {!s.isActive && <span className="hint"> (inactive)</span>}
                  {s.referenceActivityCode ? <div className="hint">Confirmed from reference catalogue</div> : null}
                </td>
                <td>{s.category ?? "—"}</td>
                <td>
                  {s.basePriceMin != null || s.basePriceMax != null
                    ? `${s.basePriceMin ?? "?"}–${s.basePriceMax ?? "?"} ${s.priceUnit ?? ""}`
                    : "—"}
                </td>
                <td>{s.defaultDurationHours ?? "—"}</td>
                <td>
                  {s.defaultRequiredSkills.length === 0 ? (
                    <span className="hint">—</span>
                  ) : (
                    s.defaultRequiredSkills.map((sk) => (
                      <span className="skill-tag" key={sk}>
                        {sk}
                      </span>
                    ))
                  )}
                </td>
                <td>
                  <button onClick={() => toggleActive(s)}>{s.isActive ? "Deactivate" : "Activate"}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function ReferenceActivities({ onActivated }: { onActivated: () => void }) {
  const [result, setResult] = useState<ReferenceActivityList | null>(null);
  const [search, setSearch] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [industryCode, setIndustryCode] = useState("");
  const [offset, setOffset] = useState(0);
  const [busyCode, setBusyCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const limit = 25;

  useEffect(() => {
    let cancelled = false;
    setError(null);
    api.catalogue.referenceActivities({
      search: appliedSearch || undefined,
      industryCode: industryCode || undefined,
      offset,
      limit,
    }).then((data) => {
      if (!cancelled) setResult(data);
    }).catch((err) => {
      if (!cancelled) setError(err instanceof ApiError ? err.message : "Could not load reference activities.");
    });
    return () => { cancelled = true; };
  }, [appliedSearch, industryCode, offset]);

  async function activate(activity: ReferenceActivity) {
    setError(null);
    setNotice(null);
    setBusyCode(activity.activityCode);
    try {
      await api.catalogue.activateReferenceActivity(activity.activityCode, { confirmed: false });
    } catch (err) {
      if (!(err instanceof ApiError) || err.code !== "CONFIRMATION_REQUIRED") {
        setError(err instanceof ApiError ? err.message : "Could not prepare activity activation.");
        setBusyCode(null);
        return;
      }
      const confirmed = window.confirm(
        `Confirm that the company really performs “${activity.activityName}” in “${activity.industryName}”? `
        + `The Oxfordshire reference rate (${activity.oxfordshireRateGbp} ${activity.rateUnit}) will not become the company price.`
      );
      if (!confirmed) {
        setBusyCode(null);
        return;
      }
    }
    try {
      await api.catalogue.activateReferenceActivity(activity.activityCode, { confirmed: true });
      setNotice(`${activity.activityName} was added as a confirmed company service. Company pricing remains unset.`);
      onActivated();
      const refreshed = await api.catalogue.referenceActivities({
        search: appliedSearch || undefined,
        industryCode: industryCode || undefined,
        offset,
        limit,
      });
      setResult(refreshed);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not activate the reference activity.");
    } finally {
      setBusyCode(null);
    }
  }

  return (
    <section className="card" style={{ marginBottom: 20 }}>
      <h2>Reference activities</h2>
      <p className="hint">
        Search 1,810 deduplicated activity templates across 14 industries. These are candidates, not claims about the company.
        Oxfordshire rates are reference values only and are never copied into company prices automatically.
      </p>
      <form onSubmit={(event) => { event.preventDefault(); setOffset(0); setAppliedSearch(search.trim()); }} style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        <input placeholder="Search activity, subtype or code" value={search} onChange={(event) => setSearch(event.target.value)} style={{ minWidth: 280 }} />
        <select value={industryCode} onChange={(event) => { setIndustryCode(event.target.value); setOffset(0); }}>
          <option value="">All industries</option>
          {(result?.industries ?? []).map((industry) => <option key={industry.code} value={industry.code}>{industry.name}</option>)}
        </select>
        <button type="submit">Search</button>
      </form>
      {error ? <div className="error-banner">{error}</div> : null}
      {notice ? <div className="success-banner">{notice}</div> : null}
      {!result ? <p>Loading…</p> : result.items.length === 0 ? <p className="hint">No matching reference activities.</p> : (
        <>
          <table className="data-table">
            <thead><tr><th>Activity</th><th>Industry / subtype</th><th>Pricing reference</th><th></th></tr></thead>
            <tbody>{result.items.map((activity) => (
              <tr key={activity.activityCode}>
                <td><strong>{activity.activityName}</strong><div className="hint">{activity.activityCode}</div></td>
                <td>{activity.industryName}<div className="hint">{activity.subtypeName}</div></td>
                <td>{activity.oxfordshireRateGbp} {activity.rateUnit}<div className="hint">Reference only · {activity.defaultPricingMethod}</div></td>
                <td>{activity.activatedServiceId ? (
                  <span>{activity.activatedServiceIsActive ? "Activated" : "Activated (inactive)"}</span>
                ) : (
                  <button onClick={() => activate(activity)} disabled={busyCode === activity.activityCode}>
                    {busyCode === activity.activityCode ? "Activating…" : "Activate for company"}
                  </button>
                )}</td>
              </tr>
            ))}</tbody>
          </table>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12 }}>
            <button className="secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))}>Previous</button>
            <span className="hint">{offset + 1}–{Math.min(offset + result.items.length, result.total)} of {result.total}</span>
            <button className="secondary" disabled={offset + limit >= result.total} onClick={() => setOffset(offset + limit)}>Next</button>
          </div>
        </>
      )}
    </section>
  );
}

function NewServiceForm({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [description, setDescription] = useState("");
  const [priceMin, setPriceMin] = useState("");
  const [priceMax, setPriceMax] = useState("");
  const [priceUnit, setPriceUnit] = useState("per job");
  const [defaultHours, setDefaultHours] = useState("");
  const [skills, setSkills] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await api.catalogue.create({
        name,
        category: category || undefined,
        description: description || undefined,
        base_price_min: priceMin ? Number(priceMin) : undefined,
        base_price_max: priceMax ? Number(priceMax) : undefined,
        price_unit: priceUnit || undefined,
        default_duration_hours: defaultHours ? Number(defaultHours) : undefined,
        default_required_skills: skills
          ? skills.split(",").map((s) => s.trim()).filter(Boolean)
          : undefined,
      });
      setName("");
      setCategory("");
      setDescription("");
      setPriceMin("");
      setPriceMax("");
      setDefaultHours("");
      setSkills("");
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create service.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="inline-form" onSubmit={handleSubmit}>
      <input placeholder="Service name" value={name} onChange={(e) => setName(e.target.value)} required />
      <input placeholder="Category" value={category} onChange={(e) => setCategory(e.target.value)} />
      <input placeholder="Description" value={description} onChange={(e) => setDescription(e.target.value)} />
      <input
        placeholder="Price min"
        type="number"
        min="0"
        step="0.01"
        style={{ width: 100 }}
        value={priceMin}
        onChange={(e) => setPriceMin(e.target.value)}
      />
      <input
        placeholder="Price max"
        type="number"
        min="0"
        step="0.01"
        style={{ width: 100 }}
        value={priceMax}
        onChange={(e) => setPriceMax(e.target.value)}
      />
      <input placeholder="Price unit" style={{ width: 110 }} value={priceUnit} onChange={(e) => setPriceUnit(e.target.value)} />
      <input
        placeholder="Default hours"
        type="number"
        min="0"
        step="0.5"
        style={{ width: 110 }}
        value={defaultHours}
        onChange={(e) => setDefaultHours(e.target.value)}
      />
      <input
        placeholder="Required skills (comma-separated)"
        value={skills}
        onChange={(e) => setSkills(e.target.value)}
      />
      <button type="submit" disabled={submitting}>
        {submitting ? "Saving…" : "Save"}
      </button>
      {error && <div className="error-banner">{error}</div>}
    </form>
  );
}
