import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import {
  api,
  ApiError,
  COMMUNICATION_CHANNELS,
  COMMUNICATION_CHANNEL_LABELS,
  type CommunicationChannel,
  type CommunicationConversionPreview,
  type CommunicationIntake,
} from "../api/client";
import { useAuth } from "../context/useAuth";

const CONFIDENCE_LABELS = {
  exact_contact_match: "One exact email/phone match",
  new_contact: "No CRM match found",
  uncertain: "Human identity check required",
} as const;

const MISSING_FIELD_LABELS: Record<string, string> = {
  name: "name",
  email_or_phone: "email or phone",
  address: "address",
  service: "catalogue service",
};

export function CommunicationIntakePage() {
  const { user } = useAuth();
  const canDeleteSourceEmail = Boolean(user?.permissions.includes("crm.manage") && user.permissions.includes("connectors.manage"));
  const [intakes, setIntakes] = useState<CommunicationIntake[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [preview, setPreview] = useState<CommunicationConversionPreview | null>(null);
  const [selectedClientId, setSelectedClientId] = useState("");

  const load = useCallback(async () => {
    try {
      setIntakes(await api.communications.intakes.list());
      setError(null);
    } catch {
      setError("Could not load communication intake.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(id: string, action: () => Promise<unknown>) {
    setBusyId(id);
    setError(null);
    try {
      await action();
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "The action could not be completed.");
    } finally {
      setBusyId(null);
    }
  }

  async function requestConversionPreview(id: string) {
    setBusyId(id);
    setError(null);
    try {
      await api.communications.intakes.convert(id, false);
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === "CONFIRMATION_REQUIRED") {
        const nextPreview = caught.details?.preview as CommunicationConversionPreview | undefined;
        if (nextPreview) {
          setPreview(nextPreview);
          setSelectedClientId(nextPreview.selectedClient?.id ?? "");
          return;
        }
      }
      setError(caught instanceof ApiError ? caught.message : "Could not prepare the conversion preview.");
    } finally {
      setBusyId(null);
    }
  }

  async function deleteGmailEmail(intake: CommunicationIntake) {
    setBusyId(intake.id);
    setError(null);
    setNotice(null);
    try {
      await api.communications.intakes.deleteGmail(intake.id, false);
    } catch (caught) {
      if (!(caught instanceof ApiError) || caught.code !== "CONFIRMATION_REQUIRED") {
        setError(caught instanceof ApiError ? caught.message : "Could not prepare email deletion.");
        setBusyId(null);
        return;
      }
      const preview = caught.details?.preview as { sender?: string; subject?: string | null; receivedAt?: string } | undefined;
      const details = [preview?.sender, preview?.subject, preview?.receivedAt ? new Date(preview.receivedAt).toLocaleString() : null].filter(Boolean).join(" · ");
      if (!window.confirm(`Move this email to Gmail Trash and delete its local Secretary copy?${details ? `\n\n${details}` : ""}\n\nAny linked CRM communication record will be preserved.`)) {
        setBusyId(null);
        return;
      }
    }
    try {
      const result = await api.communications.intakes.deleteGmail(intake.id, true);
      setNotice(result.message);
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "The email could not be deleted.");
    } finally {
      setBusyId(null);
    }
  }

  async function confirmConversion() {
    if (!preview) return;
    setBusyId(preview.intakeId);
    setError(null);
    try {
      await api.communications.intakes.convert(preview.intakeId, true, selectedClientId || undefined);
      setPreview(null);
      setSelectedClientId("");
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not convert this intake.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1>Communication Intake</h1>
      </div>
      <p className="hint">
        Paste an authorised inbound message here. Secretary preserves the original, extracts only evidenced data,
        compares it with CRM and prepares a reply draft. Nothing is sent from this page.
      </p>
      <IntakeForm onCreated={load} />
      {error ? <div className="error-banner" style={{ marginTop: 16 }}>{error}</div> : null}
      {notice ? <div className="success-banner" style={{ marginTop: 16 }}>{notice}</div> : null}

      {preview ? (
        <ConversionPreview
          preview={preview}
          selectedClientId={selectedClientId}
          onSelectClient={setSelectedClientId}
          onCancel={() => setPreview(null)}
          onConfirm={() => void confirmConversion()}
          busy={busyId === preview.intakeId}
        />
      ) : null}

      {!intakes ? (
        <p>Loading…</p>
      ) : intakes.length === 0 ? (
        <p className="hint">No inbound communications waiting for review.</p>
      ) : (
        <div style={{ display: "grid", gap: 16, marginTop: 20 }}>
          {intakes.map((intake) => (
            <article className="inline-form" key={intake.id} style={{ display: "block" }}>
              <div className="page-header">
                <div>
                  <strong>{intake.senderName || intake.senderEmail || intake.senderPhone || "Unknown sender"}</strong>
                  <div className="hint">
                    {COMMUNICATION_CHANNEL_LABELS[intake.channel]} · {new Date(intake.receivedAt).toLocaleString()} · {intake.intakeStatus}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {intake.intakeStatus !== "converted" ? (
                    <button
                      onClick={() => void run(intake.id, () => api.communications.intakes.extract(intake.id))}
                      disabled={busyId === intake.id}
                    >
                      {intake.extractedData ? "Extract again" : "Extract facts"}
                    </button>
                  ) : null}
                  {intake.extractedData ? (
                    <button
                      onClick={() => void run(intake.id, () => api.communications.intakes.draftReply(intake.id))}
                      disabled={busyId === intake.id}
                    >
                      Prepare reply draft
                    </button>
                  ) : null}
                  {intake.extractedData && intake.intakeStatus !== "converted" ? (
                    <button onClick={() => void requestConversionPreview(intake.id)} disabled={busyId === intake.id}>
                      Review CRM conversion
                    </button>
                  ) : null}
                  {canDeleteSourceEmail && intake.channel === "email" && intake.connectorSourceId && intake.externalMessageId ? (
                    <button type="button" className="secondary" onClick={() => void deleteGmailEmail(intake)} disabled={busyId === intake.id}>
                      {busyId === intake.id ? "Deleting…" : "Delete from Secretary and Gmail"}
                    </button>
                  ) : null}
                </div>
              </div>

              <h3>Original message</h3>
              <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>{intake.messageText}</pre>
              {intake.sourceReference ? (
                <p><strong>Original reference:</strong> {intake.sourceReference}</p>
              ) : null}
              {intake.extractedData ? <ExtractionSummary intake={intake} /> : null}
              {intake.replyDraft ? (
                <div>
                  <h3>Internal reply draft — not sent</h3>
                  <pre style={{ whiteSpace: "pre-wrap" }}>{intake.replyDraft}</pre>
                </div>
              ) : null}
              {intake.client ? (
                <p>
                  Linked CRM client: <Link to={`/clients/${intake.client.id}`}>{intake.client.displayName}</Link>
                  {intake.communicationRecord ? ` · Communication logged: ${intake.communicationRecord.summary}` : ""}
                </p>
              ) : null}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

function ExtractionSummary({ intake }: { intake: CommunicationIntake }) {
  const extraction = intake.extractedData!;
  return (
    <div>
      <h3>Extracted evidence</h3>
      <ul>
        <li>Name: {extraction.name || "Missing"}</li>
        <li>Email: {extraction.email || "Missing"}</li>
        <li>Phone: {extraction.phone || "Missing"}</li>
        <li>Address: {extraction.address || "Missing"}</li>
        <li>Services: {extraction.serviceMatches.map((item) => item.name).join(", ") || "No catalogue match"}</li>
        <li>Identity: {CONFIDENCE_LABELS[extraction.identityConfidence]}</li>
      </ul>
      {extraction.missingFields.length > 0 ? (
        <p className="hint">
          Missing: {extraction.missingFields.map((field) => MISSING_FIELD_LABELS[field] ?? field).join(", ")}.
        </p>
      ) : null}
      {extraction.existingClientMatches.length > 0 ? (
        <p>
          Possible CRM matches: {extraction.existingClientMatches.map((match) => `${match.displayName} (${match.reasons.join(", ")})`).join("; ")}
        </p>
      ) : null}
    </div>
  );
}

function ConversionPreview({
  preview,
  selectedClientId,
  onSelectClient,
  onCancel,
  onConfirm,
  busy,
}: {
  preview: CommunicationConversionPreview;
  selectedClientId: string;
  onSelectClient: (id: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
  busy: boolean;
}) {
  const needsSelection = preview.operation === "selection_required";
  return (
    <section className="inline-form" style={{ display: "block", marginTop: 20 }} aria-label="CRM conversion preview">
      <h2>Confirm CRM conversion</h2>
      {preview.operation === "create_new" && preview.newClient ? (
        <p>Create client <strong>{preview.newClient.displayName}</strong> and link the original message.</p>
      ) : null}
      {preview.operation === "link_existing" && preview.selectedClient ? (
        <p>Link to existing client <strong>{preview.selectedClient.displayName}</strong>; no duplicate client will be created.</p>
      ) : null}
      {needsSelection ? (
        <label>
          Matching client
          <select value={selectedClientId} onChange={(event) => onSelectClient(event.target.value)}>
            <option value="">— Select after checking identity —</option>
            {preview.possibleClients.map((client) => (
              <option key={client.id} value={client.id}>
                {client.displayName} ({client.reasons.join(", ")})
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <p>
        A new inbound communication log entry will be created with follow-up required. Original source: {preview.communication.originalSourceReference || "intake record only"}.
      </p>
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={onConfirm} disabled={busy || (needsSelection && !selectedClientId)}>
          {busy ? "Converting…" : "Confirm conversion"}
        </button>
        <button onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </section>
  );
}

function IntakeForm({ onCreated }: { onCreated: () => Promise<void> }) {
  const [channel, setChannel] = useState<CommunicationChannel>("email");
  const [senderName, setSenderName] = useState("");
  const [senderEmail, setSenderEmail] = useState("");
  const [senderPhone, setSenderPhone] = useState("");
  const [messageText, setMessageText] = useState("");
  const [sourceReference, setSourceReference] = useState("");
  const [receivedAt, setReceivedAt] = useState(() => new Date().toISOString().slice(0, 16));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api.communications.intakes.create({
        channel,
        sender_name: senderName || undefined,
        sender_email: senderEmail || undefined,
        sender_phone: senderPhone || undefined,
        message_text: messageText,
        source_reference: sourceReference || undefined,
        received_at: new Date(receivedAt).toISOString(),
      });
      setSenderName("");
      setSenderEmail("");
      setSenderPhone("");
      setMessageText("");
      setSourceReference("");
      await onCreated();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not preserve the communication.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="inline-form" onSubmit={submit}>
      <select aria-label="Communication channel" value={channel} onChange={(event) => setChannel(event.target.value as CommunicationChannel)}>
        {COMMUNICATION_CHANNELS.map((item) => <option key={item} value={item}>{COMMUNICATION_CHANNEL_LABELS[item]}</option>)}
      </select>
      <input aria-label="Sender name" placeholder="Sender name (if known)" value={senderName} onChange={(event) => setSenderName(event.target.value)} />
      <input aria-label="Sender email" type="email" placeholder="Sender email" value={senderEmail} onChange={(event) => setSenderEmail(event.target.value)} />
      <input aria-label="Sender phone" type="tel" inputMode="tel" autoComplete="tel" maxLength={40} title="Use a UK number such as 07700 900123 or an international number beginning with +" placeholder="Sender phone, e.g. 07700 900123" value={senderPhone} onChange={(event) => setSenderPhone(event.target.value)} />
      <input aria-label="Received at" type="datetime-local" value={receivedAt} onChange={(event) => setReceivedAt(event.target.value)} required />
      <input aria-label="Original message reference" placeholder="Original message URL/reference" value={sourceReference} onChange={(event) => setSourceReference(event.target.value)} />
      <textarea
        aria-label="Original inbound message"
        placeholder="Paste the original inbound message"
        value={messageText}
        onChange={(event) => setMessageText(event.target.value)}
        rows={5}
        required
        style={{ minWidth: 320 }}
      />
      <button type="submit" disabled={submitting}>{submitting ? "Saving…" : "Preserve message"}</button>
      {error ? <div className="error-banner">{error}</div> : null}
    </form>
  );
}
