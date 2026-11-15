import { useEffect, useState } from "react";
import {
  api,
  ApiError,
  WHATSAPP_CLASSIFICATION_LABELS,
  WHATSAPP_NOT_CUSTOMER_CLASSIFICATIONS,
  WHATSAPP_SENDER_STATUS_LABELS,
  WORK_SIGNAL_LABELS,
  type Client,
  type ConnectorSource,
  type WhatsAppApprovalPreview,
  type WhatsAppNotCustomerClassification,
  type WhatsAppSender,
  type WhatsAppSenderList,
  type WhatsAppSenderStatus,
} from "../api/client";

type Filter = WhatsAppSenderStatus | "open" | "all";
type ImportChoice = "contact" | "contact_and_client" | "existing";

const isUndecided = (sender: WhatsAppSender) => sender.reviewStatus === "pending" || sender.reviewStatus === "review_needed";
const isNeverReviewed = (sender: WhatsAppSender) => sender.reviewStatus === "pending";
const isSuppressed = (sender: WhatsAppSender) => sender.reviewStatus === "rejected" || sender.reviewStatus === "deleted_from_crm";
const notCustomerReason = (sender: WhatsAppSender) =>
  sender.reviewClassification && sender.reviewClassification !== "customer"
    ? WHATSAPP_CLASSIFICATION_LABELS[sender.reviewClassification] ?? sender.reviewClassification
    : null;

/**
 * Which WhatsApp senders are customers. Messages are always kept; a sender
 * reaches CRM only when a person approves them here (preview, then confirm).
 * The work-related hint is the backend's inference from message text and is
 * shown as such; it never decides.
 */
export function WhatsAppSenderReview({ source, canDecide, onClose, onNotice }: {
  source: ConnectorSource;
  canDecide: boolean;
  onClose: () => void;
  onNotice: (message: string) => void;
}) {
  const [filter, setFilter] = useState<Filter>("open");
  const [list, setList] = useState<WhatsAppSenderList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [approving, setApproving] = useState<WhatsAppSender | null>(null);

  function load() {
    setError(null);
    api.connectors.whatsappSenders(source.id, filter)
      .then(setList)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load WhatsApp senders."));
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [filter, source.id]);

  const later = (sender: WhatsAppSender) => () => void decide(sender, "mark_review_needed");
  const reopen = (sender: WhatsAppSender) => () => void decide(sender, "reopen");
  const reject = (sender: WhatsAppSender) => (event: React.ChangeEvent<HTMLSelectElement>) => {
    if (event.target.value) void decide(sender, event.target.value as WhatsAppNotCustomerClassification);
  };

  async function decide(sender: WhatsAppSender, decision: "mark_review_needed" | "reopen" | WhatsAppNotCustomerClassification) {
    setBusyId(sender.id);
    setError(null);
    try {
      const result = await api.connectors.reviewWhatsAppSender(source.id, sender.id,
        decision === "mark_review_needed" || decision === "reopen" ? { decision } : { decision: "reject", classification: decision });
      onNotice(result.message);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save the decision.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="card" style={{ marginTop: 20 }} data-panel="whatsapp-sender-review">
      <div className="page-header">
        <h2>Review WhatsApp senders</h2>
        <button className="secondary" onClick={onClose}>Close</button>
      </div>
      <p className="hint">
        Every received WhatsApp message is kept. A sender is added to CRM only when you mark them as a customer and confirm. Personal contacts, employees and subcontractors are not customers. The work-related hint only shows which landscaping, gardening or quote words appear in the messages; it is a guess from the text, not a decision.
      </p>
      <div className="inline-form">
        <label>
          Show{" "}
          <select value={filter} onChange={(event) => setFilter(event.target.value as Filter)}>
            <option value="open">Waiting for review</option>
            <option value="approved">{WHATSAPP_SENDER_STATUS_LABELS.approved}</option>
            <option value="rejected">{WHATSAPP_SENDER_STATUS_LABELS.rejected}</option>
            <option value="deleted_from_crm">{WHATSAPP_SENDER_STATUS_LABELS.deleted_from_crm}</option>
            <option value="all">All senders</option>
          </select>
        </label>
        {list ? <span className="hint">{`${list.counts.pending + list.counts.review_needed} waiting · ${list.counts.approved} customers · ${list.counts.rejected} not customers`}</span> : null}
      </div>
      {error ? <div className="error-banner">{error}</div> : null}
      {approving ? (
        <ApproveSender
          sourceId={source.id}
          sender={approving}
          onDone={(message) => { setApproving(null); onNotice(message); load(); }}
          onCancel={() => setApproving(null)}
        />
      ) : null}
      {!list ? <p>Loading…</p> : list.items.length === 0 ? <p className="hint">No WhatsApp senders in this view.</p> : (
        <table className="data-table">
          <thead><tr><th>Sender</th><th>Messages</th><th>Work-related hint</th><th>Review</th><th></th></tr></thead>
          <tbody>{list.items.map((sender) => (
            <tr key={sender.id}>
              <td>
                <strong>{sender.displayName ?? "No WhatsApp name"}</strong>
                <div className="hint">{sender.phone ?? "—"}{sender.phoneValid ? "" : " · invalid number"}</div>
                {sender.linkedContact ? <div className="hint">{`CRM contact: ${sender.linkedContact.displayName}${sender.linkedContact.isActive ? "" : " (archived)"}`}</div> : null}
              </td>
              <td>
                <div className="hint">{`${sender.messageCount} message(s)`}</div>
                {sender.recentMessages.map((message, index) => (
                  <div key={index}><small>{new Date(message.receivedAt).toLocaleString()}</small> {message.text}</div>
                ))}
              </td>
              <td>
                {WORK_SIGNAL_LABELS[sender.signal.level] ?? sender.signal.level}
                {sender.signal.matchedTerms.length ? <div className="hint">{sender.signal.matchedTerms.join(", ")}</div> : null}
                <div className="hint">Inference from message text</div>
              </td>
              <td>
                {WHATSAPP_SENDER_STATUS_LABELS[sender.reviewStatus]}
                {notCustomerReason(sender) ? <div className="hint">{notCustomerReason(sender)}</div> : null}
              </td>
              <td>
                {!canDecide ? "—" : isUndecided(sender) ? (
                  <div className="client-actions">
                    <button type="button" data-action="whatsapp-sender-customer" disabled={busyId === sender.id || !sender.phoneValid} onClick={() => setApproving(sender)}>Customer…</button>
                    <select
                      aria-label="Not a customer"
                      value=""
                      disabled={busyId === sender.id}
                      onChange={reject(sender)}
                    >
                      <option value="">Not a customer…</option>
                      {WHATSAPP_NOT_CUSTOMER_CLASSIFICATIONS.map((value) => <option key={value} value={value}>{WHATSAPP_CLASSIFICATION_LABELS[value]}</option>)}
                    </select>
                    {isNeverReviewed(sender) ? (
                      <button type="button" className="secondary" disabled={busyId === sender.id} onClick={later(sender)}>Review later</button>
                    ) : null}
                  </div>
                ) : isSuppressed(sender) ? (
                  <button type="button" className="secondary" disabled={busyId === sender.id} onClick={reopen(sender)}>Reopen for review</button>
                ) : "—"}
              </td>
            </tr>
          ))}</tbody>
        </table>
      )}
    </section>
  );
}

function ApproveSender({ sourceId, sender, onDone, onCancel }: {
  sourceId: string;
  sender: WhatsAppSender;
  onDone: (message: string) => void;
  onCancel: () => void;
}) {
  const [importAs, setImportAs] = useState<"contact" | "contact_and_client">("contact");
  const senderLabel = sender.displayName ?? sender.phone ?? "";
  const [clientId, setClientId] = useState("");
  const [displayName, setDisplayName] = useState(sender.displayName ?? "");
  const [clients, setClients] = useState<Client[]>([]);
  const [preview, setPreview] = useState<WhatsAppApprovalPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.clients.list().then(setClients).catch(() => setClients([])); }, []);

  const choice: ImportChoice = clientId ? "existing" : importAs;
  function chooseImport(event: React.ChangeEvent<HTMLSelectElement>) {
    const value = event.target.value as ImportChoice;
    setPreview(null);
    if (value === "existing") {
      setClientId(clients[0]?.id ?? "");
      return;
    }
    setClientId("");
    setImportAs(value);
  }

  const request = () => ({
    decision: "approve_customer" as const,
    import_as: clientId ? "contact" as const : importAs,
    ...(clientId ? { client_id: clientId } : {}),
    ...(displayName.trim() ? { display_name: displayName.trim() } : {}),
  });

  async function review() {
    setBusy(true);
    setError(null);
    setPreview(null);
    try {
      const result = await api.connectors.reviewWhatsAppSender(sourceId, sender.id, request());
      onDone(result.message);
    } catch (err) {
      if (err instanceof ApiError && err.code === "CONFIRMATION_REQUIRED") setPreview(err.details?.preview as WhatsAppApprovalPreview);
      else setError(err instanceof ApiError ? err.message : "Could not prepare the import.");
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.connectors.reviewWhatsAppSender(sourceId, sender.id, { ...request(), confirmed: true, expected_revision: preview.revision });
      onDone(result.message);
    } catch (err) {
      setPreview(null);
      setError(err instanceof ApiError ? err.message : "Could not add the sender to CRM.");
    } finally {
      setBusy(false);
    }
  }

  const contactLine = !preview ? null : preview.contact.action === "create"
    ? `A new CRM contact “${preview.contact.displayName}” will be created with ${preview.sender.phone}.`
    : `The existing CRM contact “${preview.contact.contact.displayName}” will be used; it is not changed.`;
  const clientLine = !preview ? null : preview.client.action === "create"
    ? `A new client “${preview.client.displayName}” will be created and linked.`
    : preview.client.action === "none"
      ? "No client will be created."
      : `The contact will be linked to the client “${preview.client.client.displayName}”.`;

  return (
    <div className="settings-card" data-panel="whatsapp-sender-approve">
      <h3>{`Add ${senderLabel} to CRM as a customer`}</h3>
      <div className="inline-form">
        <input placeholder="Name in CRM" value={displayName} onChange={(event) => { setDisplayName(event.target.value); setPreview(null); }} />
        <select value={choice} onChange={chooseImport}>
          <option value="contact">Contact only</option>
          <option value="contact_and_client">Contact and a new client</option>
          {clients.length ? <option value="existing">Contact of an existing client</option> : null}
        </select>
        {clientId ? (
          <select value={clientId} onChange={(event) => { setClientId(event.target.value); setPreview(null); }}>
            {clients.map((client) => <option key={client.id} value={client.id}>{client.displayName}</option>)}
          </select>
        ) : null}
        <button type="button" disabled={busy} onClick={() => void review()}>Review import</button>
        <button type="button" className="secondary" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
      {error ? <div className="error-banner">{error}</div> : null}
      {preview ? (
        <div className="info-banner">
          <p>{contactLine}</p>
          <p>{clientLine}</p>
          <button type="button" data-action="whatsapp-sender-confirm" disabled={busy} onClick={() => void confirm()}>Confirm and add to CRM</button>
        </div>
      ) : null}
    </div>
  );
}
