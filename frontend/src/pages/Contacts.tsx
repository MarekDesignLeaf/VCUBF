import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  api,
  ApiError,
  CONTACT_CHANNELS,
  CONTACT_LANGUAGES,
  type Client,
  type Contact,
  type ContactChannel,
  type ContactLanguage,
} from "../api/client";

export function Contacts() {
  const [contacts, setContacts] = useState<Contact[] | null>(null);
  const [search, setSearch] = useState("");
  const [activeOnly, setActiveOnly] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Contact | null>(null);
  const [error, setError] = useState<string | null>(null);

  function load() {
    api.contacts.list({ search: search || undefined, activeOnly }).then(setContacts).catch(() => setError("Could not load contacts."));
  }
  useEffect(load, [search, activeOnly]);

  async function archive(contact: Contact) {
    try {
      await api.contacts.archive(contact.id, false);
    } catch (err) {
      if (!(err instanceof ApiError) || err.code !== "CONFIRMATION_REQUIRED") {
        setError(err instanceof ApiError ? err.message : "Could not archive contact.");
        return;
      }
      if (!window.confirm(`Archive contact ${contact.displayName}? The source and client relationship will be preserved.`)) return;
      try {
        await api.contacts.archive(contact.id, true);
      } catch (confirmError) {
        setError(confirmError instanceof ApiError ? confirmError.message : "Could not archive contact.");
        return;
      }
      load();
    }
  }

  return <div>
    <div className="page-header"><h1>Contacts</h1><button onClick={() => setShowForm((value) => !value)}>{showForm ? "Cancel" : "Add contact"}</button></div>
    <p className="hint">Independent people directory with explicit source and optional client relationship. Duplicate email or phone evidence is blocked for review.</p>
    {showForm ? <ContactForm onCreated={() => { setShowForm(false); load(); }} /> : null}
    {error ? <div className="error-banner">{error}</div> : null}
    <div className="inline-form" style={{ marginTop: 16 }}>
      <input placeholder="Search name, email or phone" value={search} onChange={(event) => setSearch(event.target.value)} />
      <label><input type="checkbox" checked={activeOnly} onChange={(event) => setActiveOnly(event.target.checked)} /> Active only</label>
    </div>
    {!contacts ? <p>Loading…</p> : contacts.length === 0 ? <p className="hint">No contacts match the current filters.</p> :
      <table className="data-table"><thead><tr><th>Name</th><th>Client</th><th>Role</th><th>Email</th><th>Phone</th><th>Preference</th><th>Source</th><th>Status</th><th></th></tr></thead>
      <tbody>{contacts.map((contact) => editing?.id === contact.id
        ? <ContactEditRow key={contact.id} contact={contact} onSaved={() => { setEditing(null); load(); }} onCancel={() => setEditing(null)} />
        : <tr key={contact.id}>
        <td><strong>{contact.displayName}</strong></td>
        <td>{contact.client ? <Link to={`/clients/${contact.client.id}`}>{contact.client.displayName}</Link> : "Independent"}</td>
        <td>{[contact.jobTitle, contact.department].filter(Boolean).join(" · ") || "—"}</td>
        <td>{contact.email ?? "—"}</td><td>{contact.phone ?? "—"}</td>
        <td>{[contact.preferredChannel, contact.preferredLanguage].filter(Boolean).join(" · ") || "—"}</td>
        <td>{contact.source}{contact.sourceReference ? ` · ${contact.sourceReference}` : ""}</td>
        <td>{contact.isActive ? "Active" : "Archived"}</td>
        <td>
          <button className="secondary" data-action="contact-edit" onClick={() => setEditing(contact)}>Edit</button>
          {contact.isActive ? <button className="secondary" data-action="contact-archive" onClick={() => archive(contact)}>Archive</button> : null}
        </td>
      </tr>)}</tbody></table>}
  </div>;
}

function ContactForm({ onCreated }: { onCreated: () => void }) {
  const [clients, setClients] = useState<Client[]>([]);
  const [displayName, setDisplayName] = useState("");
  const [clientId, setClientId] = useState("");
  const [jobTitle, setJobTitle] = useState("");
  const [department, setDepartment] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [channel, setChannel] = useState<ContactChannel | "">("");
  const [language, setLanguage] = useState<ContactLanguage | "">("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  useEffect(() => { api.clients.list().then(setClients).catch(() => setError("Could not load clients.")); }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault(); setSubmitting(true); setError(null);
    try {
      await api.contacts.create({
        display_name: displayName, client_id: clientId || undefined, job_title: jobTitle || undefined,
        department: department || undefined, email: email || undefined, phone: phone || undefined,
        preferred_channel: channel || undefined, preferred_language: language || undefined, source: "user_input",
      });
      onCreated();
    } catch (err) { setError(err instanceof ApiError ? err.message : "Could not create contact."); }
    finally { setSubmitting(false); }
  }
  return <form className="inline-form" onSubmit={submit}>
    <input placeholder="Contact name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} required />
    <select value={clientId} onChange={(event) => setClientId(event.target.value)}><option value="">Independent contact</option>{clients.map((client) => <option key={client.id} value={client.id}>{client.displayName}</option>)}</select>
    <input placeholder="Job title" value={jobTitle} onChange={(event) => setJobTitle(event.target.value)} />
    <input placeholder="Department" value={department} onChange={(event) => setDepartment(event.target.value)} />
    <input type="email" placeholder="Email" value={email} onChange={(event) => setEmail(event.target.value)} />
    <input type="tel" inputMode="tel" autoComplete="tel" maxLength={40} title="Use a UK number such as 07700 900123 or an international number beginning with +" placeholder="Phone, e.g. 07700 900123" value={phone} onChange={(event) => setPhone(event.target.value)} />
    <select value={channel} onChange={(event) => setChannel(event.target.value as ContactChannel | "")}><option value="">No channel preference</option>{CONTACT_CHANNELS.map((value) => <option key={value} value={value}>{value.replaceAll("_", " ")}</option>)}</select>
    <select value={language} onChange={(event) => setLanguage(event.target.value as ContactLanguage | "")}><option value="">No language preference</option>{CONTACT_LANGUAGES.map((value) => <option key={value} value={value}>{value}</option>)}</select>
    <button type="submit" disabled={submitting || (!email && !phone)}>{submitting ? "Saving…" : "Save contact"}</button>
    {error ? <div className="error-banner">{error}</div> : null}
  </form>;
}

/**
 * One contact, editable where it stands.
 *
 * `source` is shown but not editable. The point of recording where a contact came
 * from is that it is true; a provenance note anyone can retype says nothing. Fields
 * cleared here are sent as null rather than omitted, so emptying a phone number
 * actually removes it instead of silently leaving the old one in place.
 */
function ContactEditRow({ contact, onSaved, onCancel }: { contact: Contact; onSaved: () => void; onCancel: () => void }) {
  const [clients, setClients] = useState<Client[]>([]);
  const [displayName, setDisplayName] = useState(contact.displayName);
  const [clientId, setClientId] = useState(contact.client?.id ?? "");
  const [jobTitle, setJobTitle] = useState(contact.jobTitle ?? "");
  const [department, setDepartment] = useState(contact.department ?? "");
  const [email, setEmail] = useState(contact.email ?? "");
  const [phone, setPhone] = useState(contact.phone ?? "");
  const [channel, setChannel] = useState<ContactChannel | "">(contact.preferredChannel ?? "");
  const [language, setLanguage] = useState<ContactLanguage | "">(contact.preferredLanguage ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => { api.clients.list().then(setClients).catch(() => setError("Could not load clients.")); }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault(); setSaving(true); setError(null);
    try {
      await api.contacts.update(contact.id, {
        display_name: displayName,
        client_id: clientId || null,
        job_title: jobTitle.trim() || null,
        department: department.trim() || null,
        email: email.trim() || null,
        phone: phone.trim() || null,
        preferred_channel: channel || null,
        preferred_language: language || null,
      });
      onSaved();
    } catch (err) { setError(err instanceof ApiError ? err.message : "Could not save contact."); }
    finally { setSaving(false); }
  }

  return <tr>
    <td colSpan={9}>
      <form className="inline-form" onSubmit={submit}>
        <input placeholder="Contact name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} required />
        <select value={clientId} onChange={(event) => setClientId(event.target.value)}><option value="">Independent contact</option>{clients.map((client) => <option key={client.id} value={client.id}>{client.displayName}</option>)}</select>
        <input placeholder="Job title" value={jobTitle} onChange={(event) => setJobTitle(event.target.value)} />
        <input placeholder="Department" value={department} onChange={(event) => setDepartment(event.target.value)} />
        <input type="email" placeholder="Email" value={email} onChange={(event) => setEmail(event.target.value)} />
        <input type="tel" inputMode="tel" autoComplete="tel" maxLength={40} title="Use a UK number such as 07700 900123 or an international number beginning with +" placeholder="Phone, e.g. 07700 900123" value={phone} onChange={(event) => setPhone(event.target.value)} />
        <select value={channel} onChange={(event) => setChannel(event.target.value as ContactChannel | "")}><option value="">No channel preference</option>{CONTACT_CHANNELS.map((value) => <option key={value} value={value}>{value.replaceAll("_", " ")}</option>)}</select>
        <select value={language} onChange={(event) => setLanguage(event.target.value as ContactLanguage | "")}><option value="">No language preference</option>{CONTACT_LANGUAGES.map((value) => <option key={value} value={value}>{value}</option>)}</select>
        <span className="hint">Source: {contact.source}{contact.sourceReference ? ` \u00b7 ${contact.sourceReference}` : ""} (recorded automatically, not editable)</span>
        <button type="submit" data-action="contact-save" disabled={saving || (!email.trim() && !phone.trim())}>{saving ? "Saving\u2026" : "Save contact"}</button>
        <button type="button" className="secondary" data-action="contact-cancel" onClick={onCancel} disabled={saving}>Cancel</button>
        {error ? <div className="error-banner">{error}</div> : null}
      </form>
    </td>
  </tr>;
}
