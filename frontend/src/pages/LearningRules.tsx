import { useEffect, useState } from "react";
import { api, ApiError, type EmmaBehaviorScenario, type LearningRule } from "../api/client";
import { useAuth } from "../context/useAuth";
import { appLanguage, type AppLanguage } from "../i18n";

const BEHAVIOR_COPY: Record<AppLanguage, {
  title: string; adminOnly: string; enabled: string; description: string; label: string;
  placeholder: string; example: string; safety: string; save: string; saving: string;
  saved: string; loadError: string; saveError: string; active: string; inactive: string;
}> = {
  "en-GB": { title: "Emma behavior scenario", adminOnly: "Administrator only", enabled: "Use this scenario in every new Emma conversation", description: "Define Emma's tone, persona and communication style for the whole company.", label: "Behavior scenario", placeholder: "Describe how Emma should communicate and present herself…", example: "Example: Speak as a warm, confident woman with a natural conversational style. Use embodied expressions as a persona, without claiming a real physical body.", safety: "This changes style, not permissions. The scenario cannot bypass confirmations, privacy, truthfulness or disabled functions.", save: "Save behavior scenario", saving: "Saving…", saved: "Behavior scenario saved. It will be loaded when each new Emma conversation starts.", loadError: "Could not load Emma's behavior scenario.", saveError: "Could not save Emma's behavior scenario.", active: "Active", inactive: "Inactive" },
  "en-US": { title: "Emma behavior scenario", adminOnly: "Administrator only", enabled: "Use this scenario in every new Emma conversation", description: "Define Emma's tone, persona and communication style for the whole company.", label: "Behavior scenario", placeholder: "Describe how Emma should communicate and present herself…", example: "Example: Speak as a warm, confident woman with a natural conversational style. Use embodied expressions as a persona, without claiming a real physical body.", safety: "This changes style, not permissions. The scenario cannot bypass confirmations, privacy, truthfulness or disabled functions.", save: "Save behavior scenario", saving: "Saving…", saved: "Behavior scenario saved. It will be loaded when each new Emma conversation starts.", loadError: "Could not load Emma's behavior scenario.", saveError: "Could not save Emma's behavior scenario.", active: "Active", inactive: "Inactive" },
  "cs-CZ": { title: "Scénář chování Emmy", adminOnly: "Pouze pro administrátora", enabled: "Používat tento scénář v každém novém rozhovoru s Emmou", description: "Nastavte tón, personu a způsob komunikace Emmy pro celou firmu.", label: "Scénář chování", placeholder: "Popište, jak má Emma komunikovat a vystupovat…", example: "Příklad: Mluv jako příjemná, sebevědomá žena přirozeným konverzačním stylem. Tělesné obraty používej jako součást persony, ale netvrď, že máš skutečné fyzické tělo.", safety: "Mění se styl, nikoli oprávnění. Scénář nemůže obejít potvrzování, soukromí, pravdivost ani vypnuté funkce.", save: "Uložit scénář chování", saving: "Ukládání…", saved: "Scénář chování byl uložen. Emma ho načte při zahájení každého nového rozhovoru.", loadError: "Scénář chování Emmy se nepodařilo načíst.", saveError: "Scénář chování Emmy se nepodařilo uložit.", active: "Aktivní", inactive: "Neaktivní" },
  "pl-PL": { title: "Scenariusz zachowania Emmy", adminOnly: "Tylko dla administratora", enabled: "Używaj tego scenariusza w każdej nowej rozmowie z Emmą", description: "Określ ton, osobowość i sposób komunikacji Emmy dla całej firmy.", label: "Scenariusz zachowania", placeholder: "Opisz, jak Emma ma się komunikować i prezentować…", example: "Przykład: Mów jak ciepła, pewna siebie kobieta w naturalnym stylu rozmowy. Używaj ucieleśnionych zwrotów jako elementu persony, ale nie twierdź, że masz prawdziwe ciało fizyczne.", safety: "To zmienia styl, a nie uprawnienia. Scenariusz nie może omijać potwierdzeń, prywatności, prawdomówności ani wyłączonych funkcji.", save: "Zapisz scenariusz zachowania", saving: "Zapisywanie…", saved: "Scenariusz zachowania został zapisany. Emma wczyta go przy rozpoczęciu każdej nowej rozmowy.", loadError: "Nie udało się wczytać scenariusza zachowania Emmy.", saveError: "Nie udało się zapisać scenariusza zachowania Emmy.", active: "Aktywny", inactive: "Nieaktywny" },
  "fr-FR": { title: "Scénario de comportement d’Emma", adminOnly: "Administrateur uniquement", enabled: "Utiliser ce scénario dans chaque nouvelle conversation avec Emma", description: "Définissez le ton, la personnalité et le style de communication d’Emma pour toute l’entreprise.", label: "Scénario de comportement", placeholder: "Décrivez comment Emma doit communiquer et se présenter…", example: "Exemple : Parle comme une femme chaleureuse et sûre d’elle, avec un style naturel. Utilise des expressions incarnées comme persona sans prétendre avoir un corps réel.", safety: "Cela modifie le style, pas les autorisations. Le scénario ne peut contourner les confirmations, la confidentialité, la véracité ni les fonctions désactivées.", save: "Enregistrer le scénario", saving: "Enregistrement…", saved: "Scénario enregistré. Emma le chargera au début de chaque nouvelle conversation.", loadError: "Impossible de charger le scénario de comportement d’Emma.", saveError: "Impossible d’enregistrer le scénario de comportement d’Emma.", active: "Actif", inactive: "Inactif" },
  "de-DE": { title: "Emmas Verhaltensszenario", adminOnly: "Nur für Administratoren", enabled: "Dieses Szenario in jeder neuen Unterhaltung mit Emma verwenden", description: "Legen Sie Ton, Persona und Kommunikationsstil von Emma für das gesamte Unternehmen fest.", label: "Verhaltensszenario", placeholder: "Beschreiben Sie, wie Emma kommunizieren und auftreten soll…", example: "Beispiel: Sprich als warmherzige, selbstbewusste Frau in einem natürlichen Gesprächsstil. Verwende körperbezogene Ausdrücke als Persona, ohne einen echten Körper zu behaupten.", safety: "Dies ändert den Stil, nicht die Berechtigungen. Das Szenario kann Bestätigungen, Datenschutz, Wahrhaftigkeit oder deaktivierte Funktionen nicht umgehen.", save: "Verhaltensszenario speichern", saving: "Speichern…", saved: "Verhaltensszenario gespeichert. Emma lädt es zu Beginn jeder neuen Unterhaltung.", loadError: "Emmas Verhaltensszenario konnte nicht geladen werden.", saveError: "Emmas Verhaltensszenario konnte nicht gespeichert werden.", active: "Aktiv", inactive: "Inaktiv" },
  "es-ES": { title: "Escenario de comportamiento de Emma", adminOnly: "Solo para administradores", enabled: "Usar este escenario en cada nueva conversación con Emma", description: "Define el tono, la personalidad y el estilo de comunicación de Emma para toda la empresa.", label: "Escenario de comportamiento", placeholder: "Describe cómo debe comunicarse y presentarse Emma…", example: "Ejemplo: Habla como una mujer cálida y segura, con un estilo natural. Usa expresiones corporales como parte del personaje sin afirmar que tienes un cuerpo real.", safety: "Esto cambia el estilo, no los permisos. El escenario no puede eludir confirmaciones, privacidad, veracidad ni funciones desactivadas.", save: "Guardar escenario", saving: "Guardando…", saved: "Escenario guardado. Emma lo cargará al iniciar cada nueva conversación.", loadError: "No se pudo cargar el escenario de comportamiento de Emma.", saveError: "No se pudo guardar el escenario de comportamiento de Emma.", active: "Activo", inactive: "Inactivo" },
  "it-IT": { title: "Scenario di comportamento di Emma", adminOnly: "Solo per amministratori", enabled: "Usa questo scenario in ogni nuova conversazione con Emma", description: "Definisci tono, personalità e stile di comunicazione di Emma per tutta l’azienda.", label: "Scenario di comportamento", placeholder: "Descrivi come Emma deve comunicare e presentarsi…", example: "Esempio: Parla come una donna cordiale e sicura, con uno stile naturale. Usa espressioni corporee come parte della persona senza affermare di avere un corpo reale.", safety: "Questo cambia lo stile, non i permessi. Lo scenario non può aggirare conferme, privacy, veridicità o funzioni disattivate.", save: "Salva scenario", saving: "Salvataggio…", saved: "Scenario salvato. Emma lo caricherà all’inizio di ogni nuova conversazione.", loadError: "Impossibile caricare lo scenario di comportamento di Emma.", saveError: "Impossibile salvare lo scenario di comportamento di Emma.", active: "Attivo", inactive: "Inattivo" },
};

// Learning Engine — every rule here was explicitly stated by a user, never
// inferred from a single weak signal, and stays visible, editable and
// reversible (archive, not delete). A rule with "Use as text substitution"
// filled in is also applied as a real alias before a command is parsed —
// e.g. "RAL" always resolves to "Riverside Apartments Ltd" before the
// system tries to match a client name.
export function LearningRules() {
  const { user } = useAuth();
  const language = appLanguage(user?.voiceLanguage);
  const isAdministrator = user?.role === "administrator" || user?.role === "admin";
  const [rules, setRules] = useState<LearningRule[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  function load() {
    api.learningRules
      .list()
      .then(setRules)
      .catch(() => setError("Could not load learning rules."));
  }

  useEffect(load, []);

  async function toggleArchived(rule: LearningRule) {
    try {
      await api.learningRules.update(rule.id, { status: rule.status === "active" ? "archived" : "active" });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not update rule.");
    }
  }

  if (error) return <div className="error-banner">{error}</div>;
  if (!rules) return <p>Loading…</p>;

  const visible = showArchived ? rules : rules.filter((r) => r.status === "active");

  return (
    <div>
      <div className="page-header">
        <h1>Learning</h1>
        <button onClick={() => setShowForm((v) => !v)}>{showForm ? "Cancel" : "Teach a rule"}</button>
      </div>
      <p className="hint">
        The strongest learning signal is an explicit correction, e.g. "when I say old client I
        mean a client from the last two years". A rule only changes how commands are
        interpreted if you set "Use as text substitution" — otherwise it's just a stored
        definition.
      </p>
      {isAdministrator && <EmmaBehaviorScenarioEditor language={language} />}
      {showForm && (
        <NewRuleForm
          onCreated={() => {
            setShowForm(false);
            load();
          }}
        />
      )}
      <label style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
        Show archived rules
      </label>
      {visible.length === 0 ? (
        <p className="hint">No learning rules yet.</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Term</th>
              <th>Meaning</th>
              <th>Substitutes to</th>
              <th>Category</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <tr key={r.id}>
                <td>
                  {r.term}
                  {r.status === "archived" && <span className="hint"> (archived)</span>}
                </td>
                <td>{r.meaning}</td>
                <td>{r.aliasFor ?? <span className="hint">—</span>}</td>
                <td>{r.category ?? "—"}</td>
                <td>
                  <button onClick={() => toggleArchived(r)}>{r.status === "active" ? "Archive" : "Reactivate"}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function EmmaBehaviorScenarioEditor({ language }: { language: AppLanguage }) {
  const copy = BEHAVIOR_COPY[language];
  const [config, setConfig] = useState<EmmaBehaviorScenario | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    api.learningRules.behaviorScenario()
      .then(setConfig)
      .catch((reason) => setError(reason instanceof ApiError ? reason.message : copy.loadError));
  }, [copy.loadError]);

  async function save() {
    if (!config) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      setConfig(await api.learningRules.updateBehaviorScenario({ enabled: config.enabled, scenario: config.scenario }));
      setMessage(copy.saved);
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : copy.saveError);
    } finally {
      setSaving(false);
    }
  }

  return <section className="settings-card" style={{ marginBottom: 24, borderLeft: "4px solid var(--accent, #267a52)" }}>
    <div className="page-header" style={{ marginBottom: 12 }}>
      <div><h2>{copy.title}</h2><p className="hint">{copy.description}</p></div>
      <span className="status-badge">{copy.adminOnly}</span>
    </div>
    {error && <div className="error-banner" role="alert">{error}</div>}
    {!config ? (!error && <p className="hint">…</p>) : <>
      <label style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <input type="checkbox" checked={config.enabled} onChange={(event) => { setConfig({ ...config, enabled: event.target.checked }); setMessage(null); }} />
        <strong>{copy.enabled}</strong>
        <span className="status-badge">{config.enabled ? copy.active : copy.inactive}</span>
      </label>
      <label>{copy.label}
        <textarea rows={9} maxLength={6000} value={config.scenario} placeholder={copy.placeholder} onChange={(event) => { setConfig({ ...config, scenario: event.target.value }); setMessage(null); }} />
      </label>
      <p className="hint">{copy.example}</p>
      <p className="hint"><strong>{copy.safety}</strong></p>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <button type="button" onClick={save} disabled={saving || (config.enabled && !config.scenario.trim())}>{saving ? copy.saving : copy.save}</button>
        <span className="hint">{config.scenario.length} / 6000</span>
      </div>
      {message && <div className="success-banner" role="status">{message}</div>}
    </>}
  </section>;
}

function NewRuleForm({ onCreated }: { onCreated: () => void }) {
  const [term, setTerm] = useState("");
  const [meaning, setMeaning] = useState("");
  const [aliasFor, setAliasFor] = useState("");
  const [category, setCategory] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await api.learningRules.create({
        term,
        meaning,
        alias_for: aliasFor || undefined,
        category: category || undefined,
      });
      setTerm("");
      setMeaning("");
      setAliasFor("");
      setCategory("");
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create rule.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} style={{ marginBottom: 16 }}>
      <label>
        When I say
        <input placeholder='e.g. "old client" or "RAL"' value={term} onChange={(e) => setTerm(e.target.value)} required />
      </label>
      <label>
        I mean
        <input
          placeholder="the explanation, in your own words"
          value={meaning}
          onChange={(e) => setMeaning(e.target.value)}
          required
        />
      </label>
      <label>
        Use as text substitution (optional)
        <input
          placeholder='e.g. "Riverside Apartments Ltd" — leave blank to just store the meaning'
          value={aliasFor}
          onChange={(e) => setAliasFor(e.target.value)}
        />
      </label>
      <label>
        Category (optional)
        <input value={category} onChange={(e) => setCategory(e.target.value)} />
      </label>
      <button type="submit" disabled={submitting}>
        {submitting ? "Saving…" : "Save"}
      </button>
      {error && <div className="error-banner">{error}</div>}
    </form>
  );
}
