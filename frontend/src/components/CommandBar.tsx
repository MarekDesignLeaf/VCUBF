import { useState } from "react";
import { api } from "../api/client";
import { useAuth } from "../context/useAuth";
import { appLanguage, type AppLanguage } from "../i18n";

interface HistoryEntry {
  id: string;
  text: string;
  ok: boolean;
  intent: string;
  message?: string;
}

const COMMAND_COPY: Record<AppLanguage, { summary: string; help: string; label: string; placeholder: string; sending: string; send: string; failed: string; done: string }> = {
  "en-GB": { summary: "Type to Emma (optional)", help: "Windows Emma handles all voice interaction. Open this only when you prefer to type a command.", label: "Type a command for Emma", placeholder: "For example: list jobs", sending: "Sending…", send: "Send to Emma", failed: "Request failed.", done: "done" },
  "en-US": { summary: "Type to Emma (optional)", help: "Windows Emma handles all voice interaction. Open this only when you prefer to type a command.", label: "Type a command for Emma", placeholder: "For example: list jobs", sending: "Sending…", send: "Send to Emma", failed: "Request failed.", done: "done" },
  "cs-CZ": { summary: "Napsat Emmě (volitelné)", help: "Veškerou hlasovou komunikaci zajišťuje Windows Emma. Tuto část otevřete jen tehdy, když chcete příkaz napsat.", label: "Napsat příkaz pro Emmu", placeholder: "Napište Emmě, co má udělat", sending: "Odesílání…", send: "Odeslat Emmě", failed: "Požadavek se nezdařil.", done: "hotovo" },
  "pl-PL": { summary: "Napisz do Emmy (opcjonalnie)", help: "Windows Emma obsługuje całą komunikację głosową. Otwórz tę część tylko wtedy, gdy wolisz wpisać polecenie.", label: "Wpisz polecenie dla Emmy", placeholder: "Napisz Emmie, co ma zrobić", sending: "Wysyłanie…", send: "Wyślij do Emmy", failed: "Żądanie nie powiodło się.", done: "gotowe" },
  "fr-FR": { summary: "Écrire à Emma (facultatif)", help: "Windows Emma gère toutes les interactions vocales. Ouvrez cette partie uniquement si vous préférez saisir une commande.", label: "Saisir une commande pour Emma", placeholder: "Indiquez à Emma quoi faire", sending: "Envoi…", send: "Envoyer à Emma", failed: "La demande a échoué.", done: "terminé" },
  "de-DE": { summary: "An Emma schreiben (optional)", help: "Windows Emma übernimmt die gesamte Sprachinteraktion. Öffnen Sie diesen Bereich nur, wenn Sie lieber einen Befehl eingeben.", label: "Befehl für Emma eingeben", placeholder: "Sagen Sie Emma schriftlich, was sie tun soll", sending: "Wird gesendet…", send: "An Emma senden", failed: "Anfrage fehlgeschlagen.", done: "erledigt" },
  "es-ES": { summary: "Escribir a Emma (opcional)", help: "Windows Emma gestiona toda la interacción por voz. Abra esta sección solo si prefiere escribir una orden.", label: "Escribir una orden para Emma", placeholder: "Indique a Emma qué debe hacer", sending: "Enviando…", send: "Enviar a Emma", failed: "La solicitud ha fallado.", done: "hecho" },
  "it-IT": { summary: "Scrivi a Emma (facoltativo)", help: "Windows Emma gestisce tutte le interazioni vocali. Apra questa sezione solo se preferisce digitare un comando.", label: "Digita un comando per Emma", placeholder: "Comunichi a Emma cosa fare", sending: "Invio…", send: "Invia a Emma", failed: "La richiesta non è riuscita.", done: "fatto" },
};

export function CommandBar() {
  const { user } = useAuth();
  const copy = COMMAND_COPY[appLanguage(user?.voiceLanguage)];
  const [text, setText] = useState("");
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const command = text.trim();
    if (!command) return;
    setSubmitting(true);
    try {
      const response = await api.command.text(command, "text");
      setHistory((current) => [
        { id: crypto.randomUUID(), text: command, ok: response.ok, intent: response.intent, message: response.message },
        ...current,
      ].slice(0, 8));
      setText("");
    } catch {
      setHistory((current) => [
        { id: crypto.randomUUID(), text: command, ok: false, intent: "unrecognized", message: copy.failed },
        ...current,
      ].slice(0, 8));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <details className="text-command-fallback">
      <summary>{copy.summary}</summary>
      <div className="command-bar">
        <p id="text-command-help" className="hint">
          {copy.help}
        </p>
        <form onSubmit={handleSubmit} className="inline-form">
          <input
            aria-label={copy.label}
            aria-describedby="text-command-help"
            placeholder={copy.placeholder}
            value={text}
            onChange={(event) => setText(event.target.value)}
            className="command-input"
          />
          <button type="submit" disabled={submitting || !text.trim()}>
            {submitting ? copy.sending : copy.send}
          </button>
        </form>
        {history.length > 0 ? (
          <ul className="command-history">
            {history.map((entry) => (
              <li key={entry.id} className={entry.ok ? "command-ok" : "command-error"}>
                <code>{entry.text}</code>
                {entry.message ? ` — ${entry.message}` : entry.ok ? ` — ${copy.done}` : ""}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </details>
  );
}
