import { useEffect, useState } from "react";
import { api, ApiError, type Industry, type ServiceCatalogueItem } from "../api/client";

export function Industries() {
  const [industries, setIndustries] = useState<Industry[] | null>(null);
  const [services, setServices] = useState<ServiceCatalogueItem[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [activeOnly, setActiveOnly] = useState(true);
  const [error, setError] = useState<string | null>(null);
  function load() { api.industries.list(activeOnly).then(setIndustries).catch(() => setError("Could not load industries.")); }
  useEffect(load, [activeOnly]);
  useEffect(() => { api.catalogue.list(true).then(setServices).catch(() => setError("Could not load services.")); }, []);

  async function archive(industry: Industry) {
    try { await api.industries.update(industry.id, { is_active: false }); load(); }
    catch (err) { setError(err instanceof ApiError ? err.message : "Could not archive industry."); }
  }
  async function unlink(linkId: string) {
    try { await api.industries.updateServiceLink(linkId, { is_active: false }); load(); }
    catch (err) { setError(err instanceof ApiError ? err.message : "Could not archive service link."); }
  }
  return <div>
    <div className="page-header"><h1>Industries</h1><button onClick={() => setShowForm((value) => !value)}>{showForm ? "Cancel" : "Add industry"}</button></div>
    <p className="hint">Structured, source-labelled industries linked only to real Service Catalogue entries. Secretary does not infer industries or service applicability.</p>
    {showForm ? <IndustryForm onCreated={() => { setShowForm(false); load(); }} /> : null}
    {error ? <div className="error-banner">{error}</div> : null}
    <label style={{ display: "block", margin: "16px 0" }}><input type="checkbox" checked={activeOnly} onChange={(event) => setActiveOnly(event.target.checked)} /> Active industries only</label>
    {!industries ? <p>Loading…</p> : industries.length === 0 ? <p className="hint">No industries recorded yet.</p> : industries.map((industry) =>
      <section key={industry.id} className="card" style={{ marginBottom: 16 }}>
        <div className="page-header"><div><h2>{industry.name}</h2><p>{industry.description ?? "No description entered."}</p></div>{industry.isActive ? <button className="secondary" onClick={() => archive(industry)}>Archive industry</button> : null}</div>
        <p className="hint">Source: {industry.source.replaceAll("_", " ")} · Verification: {industry.verificationStatus.replaceAll("_", " ")} · {industry.isActive ? "Active" : "Archived"}</p>
        <h3>Applicable services</h3>
        {industry.serviceLinks.filter((link) => link.isActive).length === 0 ? <p className="hint">No active services linked.</p> : <ul>{industry.serviceLinks.filter((link) => link.isActive).map((link) =>
          <li key={link.id}>{link.serviceCatalogueItem.name}{link.notes ? ` — ${link.notes}` : ""} <button className="secondary" onClick={() => unlink(link.id)}>Archive link</button></li>
        )}</ul>}
        {industry.isActive ? <ServiceLinkForm industry={industry} services={services} onLinked={load} /> : null}
      </section>
    )}
  </div>;
}

function IndustryForm({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState(""); const [description, setDescription] = useState("");
  const [verification, setVerification] = useState("user_entered"); const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setSubmitting(true); setError(null);
    try { await api.industries.create({ name, description: description || undefined, source: "user_input", verification_status: verification }); onCreated(); }
    catch (err) { setError(err instanceof ApiError ? err.message : "Could not create industry."); } finally { setSubmitting(false); }
  }
  return <form className="inline-form" onSubmit={submit}>
    <input placeholder="Industry name" value={name} onChange={(event) => setName(event.target.value)} required />
    <input placeholder="Description" value={description} onChange={(event) => setDescription(event.target.value)} />
    <select value={verification} onChange={(event) => setVerification(event.target.value)}><option value="user_entered">User entered</option><option value="confirmed">Confirmed</option><option value="unverified">Unverified</option><option value="needs_review">Needs review</option></select>
    <button type="submit" disabled={submitting}>{submitting ? "Saving…" : "Save industry"}</button>{error ? <div className="error-banner">{error}</div> : null}
  </form>;
}

function ServiceLinkForm({ industry, services, onLinked }: { industry: Industry; services: ServiceCatalogueItem[]; onLinked: () => void }) {
  const [serviceId, setServiceId] = useState(""); const [notes, setNotes] = useState(""); const [error, setError] = useState<string | null>(null);
  const activeIds = new Set(industry.serviceLinks.filter((link) => link.isActive).map((link) => link.serviceCatalogueItemId));
  const available = services.filter((service) => !activeIds.has(service.id));
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setError(null);
    try { await api.industries.linkService(industry.id, serviceId, notes || undefined); setServiceId(""); setNotes(""); onLinked(); }
    catch (err) { setError(err instanceof ApiError ? err.message : "Could not link service."); }
  }
  if (available.length === 0) return null;
  return <form className="inline-form" onSubmit={submit}>
    <select value={serviceId} onChange={(event) => setServiceId(event.target.value)} required><option value="">Select catalogue service</option>{available.map((service) => <option key={service.id} value={service.id}>{service.name}</option>)}</select>
    <input placeholder="Applicability note" value={notes} onChange={(event) => setNotes(event.target.value)} />
    <button type="submit">Link service</button>{error ? <div className="error-banner">{error}</div> : null}
  </form>;
}
