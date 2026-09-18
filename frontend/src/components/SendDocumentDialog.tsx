import { useEffect, useState } from "react";
import { api, ApiError, type SendDocumentInput, type SendDocumentPreview, type SendDocumentResult } from "../api/client";

// Two-step confirmed email delivery of a quote or invoice PDF, mirroring the
// merge/un-merge pattern: opening the dialog requests a backend preview that
// changes nothing, and only "Confirm and send" performs the real send. Every
// field shown comes from the backend preview — the recipient defaults to the
// client's stored email and is never guessed here.
export function SendDocumentDialog({ kind, id, onClose, onSent }: {
  kind: "quote" | "invoice";
  id: string;
  onClose: () => void;
  onSent: (result: SendDocumentResult) => void;
}) {
  const [preview, setPreview] = useState<SendDocumentPreview | null>(null);
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [followUp, setFollowUp] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const send = (input: SendDocumentInput) =>
    kind === "quote" ? api.quotes.sendEmail(id, input) : api.invoices.sendEmail(id, input);

  // The preview is requested once per document: the backend always answers a
  // request without confirmed:true with CONFIRMATION_REQUIRED and changes
  // nothing, so this load is safe and never sends.
  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    setError(null);
    const request = kind === "quote" ? api.quotes.sendEmail(id, {}) : api.invoices.sendEmail(id, {});
    request
      .then(() => { if (!cancelled) setError("Unexpected response — nothing was previewed."); })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.code === "CONFIRMATION_REQUIRED") {
          const next = err.details?.preview as SendDocumentPreview;
          setPreview(next);
          setTo(next.to.join(", "));
          setSubject(next.subject);
          setBody(next.body);
        } else {
          setError(err instanceof ApiError ? err.message : "Could not prepare the email.");
        }
      })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [kind, id]);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      const recipients = to.split(",").map((value) => value.trim()).filter(Boolean);
      const result = await send({
        confirmed: true,
        to: recipients,
        subject,
        body,
        ...(followUp ? { follow_up_due_at: new Date(followUp).toISOString() } : {}),
      });
      onSent(result);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not send the email.");
    } finally {
      setBusy(false);
    }
  }

  return <section className="card" style={{ marginTop: 12 }}>
    <h3>{kind === "quote" ? "Send quote by email" : "Send invoice by email"}</h3>
    {error && <div className="error-banner">{error}</div>}
    {!preview ? <p className="hint">{busy ? "Preparing…" : "No preview available."}</p> : <>
      <p className="hint">{`Sending from ${preview.source.displayName} to ${preview.document.client.label}. Attachment: ${preview.attachment.filename} (${Math.round(preview.attachment.bytes / 1024)} kB). Nothing has been sent yet.`}</p>
      {preview.statusChange && <p className="hint">{`On a successful send the status changes from ${preview.statusChange.from} to ${preview.statusChange.to}.`}</p>}
      <label>To (comma separated)<input value={to} onChange={(event) => setTo(event.target.value)} required /></label>
      <label>Subject<input value={subject} onChange={(event) => setSubject(event.target.value)} required /></label>
      <label>Message<textarea rows={8} value={body} onChange={(event) => setBody(event.target.value)} required /></label>
      <label>Follow-up due (optional)<input type="date" value={followUp} onChange={(event) => setFollowUp(event.target.value)} /></label>
      <p className="hint">The delivery is recorded as an outbound communication on the client record.</p>
      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" onClick={() => void confirm()} disabled={busy}>{busy ? "Sending…" : "Confirm and send"}</button>
        <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
      </div>
    </>}
  </section>;
}
