import { useEffect, useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import {
  api,
  type Client,
  type Job,
  type ServiceCatalogueItem,
  type CommunicationRecord,
  type PortfolioPhoto,
  ApiError,
  JOB_STATUS_LABELS,
  COMMUNICATION_CHANNEL_LABELS,
} from "../api/client";

export function ClientDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [client, setClient] = useState<Client | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showJobForm, setShowJobForm] = useState(false);
  const [communications, setCommunications] = useState<CommunicationRecord[]>([]);
  const [photos, setPhotos] = useState<PortfolioPhoto[]>([]);
  const [showEditForm, setShowEditForm] = useState(false);
  const [archiving, setArchiving] = useState(false);

  function loadClient() {
    if (!id) return;
    api.clients
      .get(id)
      .then(setClient)
      .catch(() => setError("Client not found."));
  }

  function loadJobs() {
    if (!id) return;
    api.jobs.list({ clientId: id }).then(setJobs).catch(() => {});
  }

  function loadCommunications() {
    if (!id) return;
    api.communications.list({ clientId: id }).then(setCommunications).catch(() => {});
  }

  function loadPhotos() {
    if (!id) return;
    api.portfolio.list({ clientId: id }).then(setPhotos).catch(() => {});
  }

  useEffect(() => {
    loadClient();
    loadJobs();
    loadCommunications();
    loadPhotos();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (error) return <div className="error-banner">{error}</div>;
  if (!client) return <p>Loading…</p>;

  async function archiveCurrentClient() {
    if (!id || !client) return;
    setError(null);
    setArchiving(true);
    try {
      await api.clients.archive(id, false);
    } catch (err) {
      if (!(err instanceof ApiError) || err.code !== "CONFIRMATION_REQUIRED") {
        setError(err instanceof ApiError ? err.message : "Could not archive client.");
        setArchiving(false);
        return;
      }
      const preview = err.details?.preview as { preservedRecords?: Record<string, number> } | undefined;
      const recordCount = Object.values(preview?.preservedRecords ?? {}).reduce((sum, count) => sum + count, 0);
      const confirmed = window.confirm(
        `Archive ${client.displayName}? The client will disappear from the active client list. ${recordCount} linked record${recordCount === 1 ? "" : "s"} will be preserved.`
      );
      if (!confirmed) {
        setArchiving(false);
        return;
      }
      try {
        await api.clients.archive(id, true);
        navigate("/clients", { replace: true });
      } catch (confirmError) {
        setError(confirmError instanceof ApiError ? confirmError.message : "Could not archive client.");
      }
    } finally {
      setArchiving(false);
    }
  }

  return (
    <div>
      <Link to="/clients">← Back to clients</Link>
      <div className="page-header client-heading">
        <h1>{client.displayName}</h1>
        <div className="client-actions">
          <button type="button" onClick={() => setShowEditForm((visible) => !visible)}>
            {showEditForm ? "Cancel editing" : "Edit client"}
          </button>
          <button type="button" className="danger-button" disabled={archiving} onClick={() => void archiveCurrentClient()}>
            {archiving ? "Archiving…" : "Delete / archive client"}
          </button>
        </div>
      </div>
      {showEditForm && (
        <EditClientForm
          client={client}
          onSaved={(updated) => {
            setClient(updated);
            setShowEditForm(false);
          }}
        />
      )}
      <dl className="detail-list">
        <dt>Company</dt>
        <dd>{client.companyName ?? "—"}</dd>
        <dt>Email</dt>
        <dd>{client.emailPrimary ?? "—"}</dd>
        <dt>Phone</dt>
        <dd>{client.phonePrimary ?? "—"}</dd>
        <dt>Type</dt>
        <dd>{client.clientType ?? "—"}</dd>
        <dt>Source</dt>
        <dd>{client.source ?? "manual"}</dd>
        <dt>Notes</dt>
        <dd>{client.notes ?? "—"}</dd>
      </dl>

      <div className="page-header">
        <h2>Jobs</h2>
        <div style={{ display: "flex", gap: 12 }}>
          {id && <Link to={`/quotes/new?client_id=${id}`}>New quote</Link>}
          <button onClick={() => setShowJobForm((v) => !v)}>{showJobForm ? "Cancel" : "New job"}</button>
        </div>
      </div>
      {showJobForm && id && (
        <NewJobForm
          clientId={id}
          onCreated={() => {
            setShowJobForm(false);
            loadJobs();
          }}
        />
      )}
      {jobs.length === 0 ? (
        <p className="hint">No jobs for this client yet.</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Job</th>
              <th>Status</th>
              <th>Address</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((j) => (
              <tr key={j.id}>
                <td>
                  <Link to={`/jobs/${j.id}`}>{j.jobTitle}</Link>
                </td>
                <td>{JOB_STATUS_LABELS[j.jobStatus]}</td>
                <td>{j.propertyAddress ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="page-header">
        <h2>Communications</h2>
        {id && <Link to={`/communications?client_id=${id}`}>Log communication</Link>}
      </div>
      {communications.length === 0 ? (
        <p className="hint">No communications logged for this client yet.</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>When</th>
              <th>Channel</th>
              <th>Summary</th>
              <th>Follow-up</th>
            </tr>
          </thead>
          <tbody>
            {communications.slice(0, 5).map((c) => (
              <tr key={c.id}>
                <td>{new Date(c.occurredAt).toLocaleString()}</td>
                <td>{COMMUNICATION_CHANNEL_LABELS[c.channel]}</td>
                <td>{c.summary}</td>
                <td>{c.followUpNeeded ? "Needed" : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="page-header">
        <h2>Photos</h2>
        {id && <Link to={`/portfolio?client_id=${id}`}>Log photo</Link>}
      </div>
      {photos.length === 0 ? (
        <p className="hint">No photos logged for this client yet.</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Filename</th>
              <th>Caption</th>
              <th>Marketing</th>
            </tr>
          </thead>
          <tbody>
            {photos.slice(0, 5).map((p) => (
              <tr key={p.id}>
                <td>{p.filename}</td>
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

function EditClientForm({ client, onSaved }: { client: Client; onSaved: (client: Client) => void }) {
  const [displayName, setDisplayName] = useState(client.displayName);
  const [firstName, setFirstName] = useState(client.firstName ?? "");
  const [lastName, setLastName] = useState(client.lastName ?? "");
  const [companyName, setCompanyName] = useState(client.companyName ?? "");
  const [email, setEmail] = useState(client.emailPrimary ?? "");
  const [phone, setPhone] = useState(client.phonePrimary ?? "");
  const [clientType, setClientType] = useState(client.clientType ?? "");
  const [address, setAddress] = useState(client.billingLine1 ?? "");
  const [city, setCity] = useState(client.billingCity ?? "");
  const [postcode, setPostcode] = useState(client.billingPostcode ?? "");
  const [notes, setNotes] = useState(client.notes ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const updated = await api.clients.update(client.id, {
        display_name: displayName,
        first_name: firstName,
        last_name: lastName,
        company_name: companyName,
        email_primary: email,
        phone_primary: phone,
        client_type: clientType,
        billing_address_line1: address,
        billing_city: city,
        billing_postcode: postcode,
        notes,
      });
      onSaved(updated);
    } catch (err) {
      if (err instanceof ApiError && err.code === "EMAIL_BELONGS_TO_USER") {
        setError("This email belongs to a Secretary user and cannot also be assigned to a client.");
      } else if (err instanceof ApiError && err.code === "DUPLICATE_CLIENT_POSSIBLE") {
        setError("Another active client already uses this email or the same name and phone.");
      } else if (err instanceof ApiError && err.code === "VALIDATION_FAILED") {
        setError(err.message || "Check the email address and use a valid UK or international phone number.");
      } else {
        setError(err instanceof ApiError ? err.message : "Could not update client.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="inline-form client-edit-form" onSubmit={submit}>
      <label>Display name<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} required maxLength={200} /></label>
      <label>First name<input value={firstName} onChange={(event) => setFirstName(event.target.value)} maxLength={100} /></label>
      <label>Last name<input value={lastName} onChange={(event) => setLastName(event.target.value)} maxLength={100} /></label>
      <label>Company<input value={companyName} onChange={(event) => setCompanyName(event.target.value)} maxLength={200} /></label>
      <label>Email<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} maxLength={254} /></label>
      <label>Phone<input type="tel" inputMode="tel" value={phone} onChange={(event) => setPhone(event.target.value)} maxLength={40} placeholder="07700 900123 or +44…" /></label>
      <label>Client type<input value={clientType} onChange={(event) => setClientType(event.target.value)} maxLength={100} /></label>
      <label>Billing address<input value={address} onChange={(event) => setAddress(event.target.value)} maxLength={500} /></label>
      <label>City<input value={city} onChange={(event) => setCity(event.target.value)} maxLength={200} /></label>
      <label>Postcode<input value={postcode} onChange={(event) => setPostcode(event.target.value)} maxLength={40} /></label>
      <label className="client-edit-notes">Notes<textarea value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={10000} rows={4} /></label>
      <div className="client-edit-submit"><button type="submit" disabled={submitting}>{submitting ? "Saving…" : "Save changes"}</button></div>
      {error && <div className="error-banner client-edit-error">{error}</div>}
    </form>
  );
}

function NewJobForm({ clientId, onCreated }: { clientId: string; onCreated: () => void }) {
  const [services, setServices] = useState<ServiceCatalogueItem[]>([]);
  const [serviceId, setServiceId] = useState("");
  const [jobTitle, setJobTitle] = useState("");
  const [address, setAddress] = useState("");
  const [plannedStart, setPlannedStart] = useState("");
  const [estimatedHours, setEstimatedHours] = useState("");
  const [requiredSkills, setRequiredSkills] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api.catalogue.list(true).then(setServices).catch(() => undefined);
  }, []);

  function handleServiceSelect(id: string) {
    setServiceId(id);
    const service = services.find((s) => s.id === id);
    if (!service) return;
    if (!jobTitle) setJobTitle(service.name);
    if (!estimatedHours && service.defaultDurationHours != null) {
      setEstimatedHours(String(service.defaultDurationHours));
    }
    if (!requiredSkills && service.defaultRequiredSkills.length > 0) {
      setRequiredSkills(service.defaultRequiredSkills.join(", "));
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await api.jobs.create({
        client_id: clientId,
        job_title: jobTitle,
        property_address: address || undefined,
        planned_start_at: plannedStart ? new Date(plannedStart).toISOString() : undefined,
        estimated_duration_hours: estimatedHours ? Number(estimatedHours) : undefined,
        required_skills: requiredSkills
          ? requiredSkills.split(",").map((s) => s.trim()).filter(Boolean)
          : undefined,
        service_catalogue_item_id: serviceId || undefined,
      });
      setJobTitle("");
      setAddress("");
      setPlannedStart("");
      setEstimatedHours("");
      setRequiredSkills("");
      setServiceId("");
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create job.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="inline-form" onSubmit={handleSubmit}>
      {services.length > 0 && (
        <select value={serviceId} onChange={(e) => handleServiceSelect(e.target.value)}>
          <option value="">— Based on a service (optional) —</option>
          {services.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      )}
      <input placeholder="Job title" value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} required />
      <input placeholder="Property address" value={address} onChange={(e) => setAddress(e.target.value)} />
      <input type="datetime-local" value={plannedStart} onChange={(e) => setPlannedStart(e.target.value)} />
      <input
        placeholder="Est. hours"
        type="number"
        min="0"
        step="0.5"
        style={{ width: 90 }}
        value={estimatedHours}
        onChange={(e) => setEstimatedHours(e.target.value)}
      />
      <input
        placeholder="Required skills (comma-separated)"
        value={requiredSkills}
        onChange={(e) => setRequiredSkills(e.target.value)}
      />
      <button type="submit" disabled={submitting}>
        {submitting ? "Saving…" : "Save"}
      </button>
      {error && <div className="error-banner">{error}</div>}
    </form>
  );
}
