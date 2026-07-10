import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { api, type Client } from "../api/client";

export function ClientDetail() {
  const { id } = useParams<{ id: string }>();
  const [client, setClient] = useState<Client | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    api.clients
      .get(id)
      .then(setClient)
      .catch(() => setError("Client not found."));
  }, [id]);

  if (error) return <div className="error-banner">{error}</div>;
  if (!client) return <p>Loading…</p>;

  return (
    <div>
      <Link to="/clients">← Back to clients</Link>
      <h1>{client.displayName}</h1>
      <dl className="detail-list">
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
    </div>
  );
}
