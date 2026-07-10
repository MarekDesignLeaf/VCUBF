import { useEffect, useState } from "react";
import { api, ApiError, type ServiceCatalogueItem } from "../api/client";

// Service Catalogue Module — the company's real, user-entered menu of
// services. Nothing shown here is invented: every field is what the user
// typed in. Later modules (quoting, website content) read from this list
// instead of re-typing or guessing service names/prices.
export function ServiceCatalogue() {
  const [services, setServices] = useState<ServiceCatalogueItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [showInactive, setShowInactive] = useState(false);

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
        <button onClick={() => setShowForm((v) => !v)}>{showForm ? "Cancel" : "New service"}</button>
      </div>
      <p className="hint">
        The real menu of services the company offers — used to prefill jobs (and later quotes and
        website content) instead of retyping or guessing.
      </p>
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
