import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  api, ApiError, DOCUMENT_SENSITIVITIES, DOCUMENT_TYPES,
  type Client, type DocumentRecord, type DocumentSensitivity, type DocumentType, type Job,
} from "../api/client";

export function Documents() {
  const [documents, setDocuments] = useState<DocumentRecord[] | null>(null);
  const [typeFilter, setTypeFilter] = useState("");
  const [sensitivityFilter, setSensitivityFilter] = useState("");
  const [activeOnly, setActiveOnly] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  function load() {
    api.documents.list({ documentType: typeFilter || undefined, sensitivity: sensitivityFilter || undefined, activeOnly })
      .then(setDocuments).catch(() => setError("Could not load document records."));
  }
  useEffect(load, [typeFilter, sensitivityFilter, activeOnly]);
  async function archive(document: DocumentRecord) {
    try { await api.documents.update(document.id, { is_active: false }); load(); }
    catch (err) { setError(err instanceof ApiError ? err.message : "Could not archive document record."); }
  }
  return <div>
    <div className="page-header"><h1>Documents</h1><button onClick={() => setShowForm((value) => !value)}>{showForm ? "Cancel" : "Register document"}</button></div>
    <p className="hint">Metadata registry only. Secretary stores the title, classification, relationship and reference you enter; it does not upload or retain the underlying file in this MVP.</p>
    {showForm ? <DocumentForm onCreated={() => { setShowForm(false); load(); }} /> : null}
    {error ? <div className="error-banner">{error}</div> : null}
    <div className="inline-form" style={{ marginTop: 16 }}>
      <select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)}><option value="">All document types</option>{DOCUMENT_TYPES.map((value) => <option key={value} value={value}>{value.replaceAll("_", " ")}</option>)}</select>
      <select value={sensitivityFilter} onChange={(event) => setSensitivityFilter(event.target.value)}><option value="">All sensitivities</option>{DOCUMENT_SENSITIVITIES.map((value) => <option key={value} value={value}>{value.replaceAll("_", " ")}</option>)}</select>
      <label><input type="checkbox" checked={activeOnly} onChange={(event) => setActiveOnly(event.target.checked)} /> Active only</label>
    </div>
    {!documents ? <p>Loading…</p> : documents.length === 0 ? <p className="hint">No document records match the current filters.</p> :
      <table className="data-table"><thead><tr><th>Title</th><th>Type</th><th>Related to</th><th>Reference</th><th>Sensitivity</th><th>Verification</th><th>Dates</th><th>Status</th><th></th></tr></thead>
      <tbody>{documents.map((document) => <tr key={document.id}>
        <td><strong>{document.title}</strong></td><td>{document.documentType.replaceAll("_", " ")}</td>
        <td>{document.job ? <Link to={`/jobs/${document.job.id}`}>{document.job.jobTitle}</Link> : document.client ? <Link to={`/clients/${document.client.id}`}>{document.client.displayName}</Link> : "Company"}</td>
        <td>{document.documentReference}</td><td>{document.sensitivity.replaceAll("_", " ")}</td><td>{document.verificationStatus.replaceAll("_", " ")}</td>
        <td>{document.issuedAt ? `Issued ${new Date(document.issuedAt).toLocaleDateString()}` : "Issue unknown"}{document.expiresAt ? ` · expires ${new Date(document.expiresAt).toLocaleDateString()}` : ""}</td>
        <td>{document.isActive ? "Active" : "Archived"}</td><td>{document.isActive ? <button className="secondary" onClick={() => archive(document)}>Archive</button> : null}</td>
      </tr>)}</tbody></table>}
  </div>;
}

function DocumentForm({ onCreated }: { onCreated: () => void }) {
  const [clients, setClients] = useState<Client[]>([]); const [jobs, setJobs] = useState<Job[]>([]);
  const [title, setTitle] = useState(""); const [documentType, setDocumentType] = useState<DocumentType>("other");
  const [reference, setReference] = useState(""); const [sensitivity, setSensitivity] = useState<DocumentSensitivity>("normal");
  const [clientId, setClientId] = useState(""); const [jobId, setJobId] = useState("");
  const [issuedAt, setIssuedAt] = useState(""); const [expiresAt, setExpiresAt] = useState("");
  const [error, setError] = useState<string | null>(null); const [submitting, setSubmitting] = useState(false);
  useEffect(() => { let cancelled = false; Promise.all([api.clients.list(), api.jobs.list()]).then(([clientResult, jobResult]) => { if (!cancelled) { setClients(clientResult); setJobs(jobResult); } }).catch(() => { if (!cancelled) setError("Could not load document links."); }); return () => { cancelled = true; }; }, []);
  function changeJob(id: string) { setJobId(id); const job = jobs.find((value) => value.id === id); if (job) setClientId(job.clientId); }
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setSubmitting(true); setError(null);
    try { await api.documents.create({ title, document_type: documentType, document_reference: reference, source: "user_input", sensitivity, verification_status: "user_entered", client_id: clientId || undefined, job_id: jobId || undefined, issued_at: issuedAt ? new Date(issuedAt).toISOString() : undefined, expires_at: expiresAt ? new Date(expiresAt).toISOString() : undefined }); onCreated(); }
    catch (err) { setError(err instanceof ApiError ? err.message : "Could not register document."); } finally { setSubmitting(false); }
  }
  return <form className="inline-form" onSubmit={submit}>
    <input placeholder="Document title" value={title} onChange={(event) => setTitle(event.target.value)} required />
    <select value={documentType} onChange={(event) => setDocumentType(event.target.value as DocumentType)}>{DOCUMENT_TYPES.map((value) => <option key={value} value={value}>{value.replaceAll("_", " ")}</option>)}</select>
    <input placeholder="File path, URL or storage reference" value={reference} onChange={(event) => setReference(event.target.value)} required style={{ minWidth: 280 }} />
    <select value={sensitivity} onChange={(event) => setSensitivity(event.target.value as DocumentSensitivity)}>{DOCUMENT_SENSITIVITIES.map((value) => <option key={value} value={value}>{value.replaceAll("_", " ")}</option>)}</select>
    <select value={clientId} onChange={(event) => setClientId(event.target.value)}><option value="">Company level</option>{clients.map((client) => <option key={client.id} value={client.id}>{client.displayName}</option>)}</select>
    <select value={jobId} onChange={(event) => changeJob(event.target.value)}><option value="">No job</option>{jobs.map((job) => <option key={job.id} value={job.id}>{job.jobTitle}</option>)}</select>
    <label>Issued <input type="date" value={issuedAt} onChange={(event) => setIssuedAt(event.target.value)} /></label>
    <label>Expires <input type="date" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} /></label>
    <button type="submit" disabled={submitting}>{submitting ? "Saving…" : "Register"}</button>
    {error ? <div className="error-banner">{error}</div> : null}
  </form>;
}
