import { useCallback, useEffect, useState } from "react";
import { api, type VoiceAlias, type VoiceAliasCategory } from "../api/client";
import { useAuth } from "../context/useAuth";
import { appLanguage } from "../i18n";

/**
 * Voice aliases: what the recogniser produces, mapped onto what was meant.
 *
 * Aliases are normally learned by saying the same thing three times, so this
 * page shows that progress rather than hiding it — a phrase at 2 of 3 is not
 * broken, it is one repetition away. Aliases added here by hand are active
 * immediately, because typing one is already deliberate.
 */

interface Copy {
  title: string;
  intro: string;
  addressHeading: string;
  commandHeading: string;
  heard: string;
  means: string;
  add: string;
  remove: string;
  progress: (got: number, need: number) => string;
  active: string;
  empty: string;
  heardHint: string;
  meansHintAddress: string;
  meansHintCommand: string;
  failed: string;
  sameValue: string;
}

function copyFor(language: string): Copy {
  const base = language.slice(0, 2).toLowerCase();
  const table: Record<string, Copy> = {
    en: {
      title: "Voice aliases",
      intro: "When Emma keeps mishearing a word, say it three times and the way it is actually heard becomes permanent. You can also add an alias here directly.",
      addressHeading: "How Emma is addressed",
      commandHeading: "Commands",
      heard: "What is heard",
      means: "What it means",
      add: "Add",
      remove: "Remove",
      progress: (got, need) => `Learning ${got} of ${need}`,
      active: "Active",
      empty: "Nothing learned yet.",
      heardHint: "The word as the recogniser writes it, for example Ema.",
      meansHintAddress: "The real wake word, for example Emma.",
      meansHintCommand: "The command it should become, for example show clients.",
      failed: "Could not be saved.",
      sameValue: "Both fields are the same, so the alias would do nothing.",
    },
    cs: {
      title: "Hlasové aliasy",
      intro: "Když Emma nějaké slovo pořád špatně slyší, řekněte ho třikrát a to, jak ho skutečně slyší, se uloží natrvalo. Alias můžete přidat i ručně zde.",
      addressHeading: "Oslovení Emmy",
      commandHeading: "Příkazy",
      heard: "Co je slyšet",
      means: "Co to znamená",
      add: "Přidat",
      remove: "Smazat",
      progress: (got, need) => `Učí se ${got} ze ${need}`,
      active: "Aktivní",
      empty: "Zatím nic naučeno.",
      heardHint: "Slovo tak, jak ho přepis zapíše, například Ema.",
      meansHintAddress: "Skutečné oslovení, například Emma.",
      meansHintCommand: "Příkaz, na který se má změnit, například ukaž klienty.",
      failed: "Nepodařilo se uložit.",
      sameValue: "Obě pole jsou stejná, alias by nic nedělal.",
    },
    pl: {
      title: "Aliasy głosowe",
      intro: "Jeśli Emma stale źle słyszy jakieś słowo, powiedz je trzy razy, a sposób, w jaki je faktycznie słyszy, zostanie zapisany na stałe. Alias możesz też dodać ręcznie.",
      addressHeading: "Zwracanie się do Emmy",
      commandHeading: "Polecenia",
      heard: "Co słychać",
      means: "Co to znaczy",
      add: "Dodaj",
      remove: "Usuń",
      progress: (got, need) => `Uczy się ${got} z ${need}`,
      active: "Aktywny",
      empty: "Nic jeszcze nie nauczono.",
      heardHint: "Słowo tak, jak zapisuje je transkrypcja, na przykład Ema.",
      meansHintAddress: "Prawdziwe słowo aktywujące, na przykład Emma.",
      meansHintCommand: "Polecenie, którym ma się stać, na przykład pokaż klientów.",
      failed: "Nie udało się zapisać.",
      sameValue: "Oba pola są takie same, alias nic by nie zmienił.",
    },
    de: {
      title: "Sprachaliase",
      intro: "Wenn Emma ein Wort immer wieder falsch hört, sagen Sie es dreimal — die tatsächlich gehörte Form wird dauerhaft gespeichert. Sie können einen Alias auch hier eintragen.",
      addressHeading: "Anrede von Emma",
      commandHeading: "Befehle",
      heard: "Was gehört wird",
      means: "Was es bedeutet",
      add: "Hinzufügen",
      remove: "Entfernen",
      progress: (got, need) => `Lernt ${got} von ${need}`,
      active: "Aktiv",
      empty: "Noch nichts gelernt.",
      heardHint: "Das Wort so, wie die Transkription es schreibt, zum Beispiel Ema.",
      meansHintAddress: "Das echte Aktivierungswort, zum Beispiel Emma.",
      meansHintCommand: "Der Befehl, der daraus werden soll, zum Beispiel Kunden anzeigen.",
      failed: "Konnte nicht gespeichert werden.",
      sameValue: "Beide Felder sind gleich, der Alias hätte keine Wirkung.",
    },
    fr: {
      title: "Alias vocaux",
      intro: "Si Emma entend mal un mot de façon répétée, dites-le trois fois : la forme réellement entendue est enregistrée définitivement. Vous pouvez aussi ajouter un alias ici.",
      addressHeading: "Comment appeler Emma",
      commandHeading: "Commandes",
      heard: "Ce qui est entendu",
      means: "Ce que cela signifie",
      add: "Ajouter",
      remove: "Supprimer",
      progress: (got, need) => `Apprentissage ${got} sur ${need}`,
      active: "Actif",
      empty: "Rien appris pour l'instant.",
      heardHint: "Le mot tel que la transcription l'écrit, par exemple Ema.",
      meansHintAddress: "Le vrai mot d'activation, par exemple Emma.",
      meansHintCommand: "La commande à obtenir, par exemple afficher les clients.",
      failed: "Enregistrement impossible.",
      sameValue: "Les deux champs sont identiques, l'alias n'aurait aucun effet.",
    },
    es: {
      title: "Alias de voz",
      intro: "Si Emma sigue oyendo mal una palabra, dígala tres veces: la forma en que realmente se oye queda guardada de forma permanente. También puede añadir un alias aquí.",
      addressHeading: "Cómo se llama a Emma",
      commandHeading: "Comandos",
      heard: "Lo que se oye",
      means: "Lo que significa",
      add: "Añadir",
      remove: "Eliminar",
      progress: (got, need) => `Aprendiendo ${got} de ${need}`,
      active: "Activo",
      empty: "Todavía no se ha aprendido nada.",
      heardHint: "La palabra tal como la escribe la transcripción, por ejemplo Ema.",
      meansHintAddress: "La palabra de activación real, por ejemplo Emma.",
      meansHintCommand: "El comando en que debe convertirse, por ejemplo mostrar clientes.",
      failed: "No se ha podido guardar.",
      sameValue: "Ambos campos son iguales, el alias no haría nada.",
    },
    it: {
      title: "Alias vocali",
      intro: "Se Emma continua a sentire male una parola, ditela tre volte: il modo in cui viene realmente sentita viene salvato in modo permanente. Potete anche aggiungere un alias qui.",
      addressHeading: "Come ci si rivolge a Emma",
      commandHeading: "Comandi",
      heard: "Ciò che si sente",
      means: "Che cosa significa",
      add: "Aggiungi",
      remove: "Rimuovi",
      progress: (got, need) => `Apprendimento ${got} su ${need}`,
      active: "Attivo",
      empty: "Non è ancora stato imparato nulla.",
      heardHint: "La parola come la scrive la trascrizione, per esempio Ema.",
      meansHintAddress: "La vera parola di attivazione, per esempio Emma.",
      meansHintCommand: "Il comando che deve diventare, per esempio mostra clienti.",
      failed: "Salvataggio non riuscito.",
      sameValue: "I due campi sono uguali, l'alias non farebbe nulla.",
    },
  };
  return table[base] ?? table.en;
}

export function VoiceAliases() {
  const { user } = useAuth();
  const copy = copyFor(appLanguage(user?.voiceLanguage));

  const [aliases, setAliases] = useState<VoiceAlias[]>([]);
  const [required, setRequired] = useState(3);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await api.command.aliases.list();
      setAliases(result.aliases);
      setRequired(result.required);
      setError(null);
    } catch {
      setError(copy.failed);
    }
  }, [copy.failed]);

  useEffect(() => { void load(); }, [load]);

  const remove = async (id: string) => {
    try {
      await api.command.aliases.remove(id);
      await load();
    } catch {
      setError(copy.failed);
    }
  };

  const sections: Array<{ category: VoiceAliasCategory; heading: string; meansHint: string }> = [
    { category: "wake_word", heading: copy.addressHeading, meansHint: copy.meansHintAddress },
    { category: "voice_command", heading: copy.commandHeading, meansHint: copy.meansHintCommand },
  ];

  return (
    <section className="page voice-aliases">
      <h1>{copy.title}</h1>
      <p className="hint">{copy.intro}</p>
      {error ? <p className="error">{error}</p> : null}

      {sections.map((section) => (
        <div key={section.category} className="card">
          <h2>{section.heading}</h2>
          <AliasForm
            category={section.category}
            copy={copy}
            meansHint={section.meansHint}
            onSaved={load}
            onError={setError}
          />
          <AliasTable
            copy={copy}
            required={required}
            rows={aliases.filter((alias) => alias.category === section.category)}
            onRemove={remove}
          />
        </div>
      ))}
    </section>
  );
}

function AliasForm({ category, copy, meansHint, onSaved, onError }: {
  category: VoiceAliasCategory;
  copy: Copy;
  meansHint: string;
  onSaved: () => Promise<void>;
  onError: (message: string | null) => void;
}) {
  const [heard, setHeard] = useState("");
  const [means, setMeans] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!heard.trim() || !means.trim()) return;
    // The backend rejects this too, but saying so here avoids a pointless round
    // trip and an error message that does not explain itself.
    if (heard.trim().toLowerCase() === means.trim().toLowerCase()) {
      onError(copy.sameValue);
      return;
    }
    setSaving(true);
    try {
      await api.command.aliases.add(heard.trim(), means.trim(), category);
      setHeard("");
      setMeans("");
      onError(null);
      await onSaved();
    } catch {
      onError(copy.failed);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="alias-form" onSubmit={submit}>
      <label>
        <span>{copy.heard}</span>
        <input value={heard} onChange={(event) => setHeard(event.target.value)} placeholder={copy.heardHint} />
      </label>
      <label>
        <span>{copy.means}</span>
        <input value={means} onChange={(event) => setMeans(event.target.value)} placeholder={meansHint} />
      </label>
      <button type="submit" disabled={saving || !heard.trim() || !means.trim()}>{copy.add}</button>
    </form>
  );
}

function AliasTable({ copy, required, rows, onRemove }: {
  copy: Copy;
  required: number;
  rows: VoiceAlias[];
  onRemove: (id: string) => Promise<void>;
}) {
  if (rows.length === 0) return <p className="hint">{copy.empty}</p>;
  return (
    <table>
      <thead>
        <tr>
          <th>{copy.heard}</th>
          <th>{copy.means}</th>
          <th></th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {rows.map((alias) => (
          <tr key={alias.id}>
            <td>{alias.term}</td>
            <td>{alias.aliasFor ?? "—"}</td>
            <td>
              {alias.status === "active"
                ? <span className="badge badge-active">{copy.active}</span>
                : <span className="badge">{copy.progress(alias.confirmations, required)}</span>}
            </td>
            <td>
              <button type="button" onClick={() => void onRemove(alias.id)}>{copy.remove}</button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
