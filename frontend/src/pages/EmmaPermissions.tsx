import { useEffect, useMemo, useState } from "react";
import { Navigate } from "react-router-dom";
import { api, ApiError, type EmmaCapabilityPolicyItem } from "../api/client";
import { useAuth } from "../context/useAuth";
import { appLanguage } from "../i18n";

const CATEGORY_ORDER = ["navigation", "customers", "work", "sales", "communication", "attention", "people", "learning", "evidence", "connectors"];

const PL_CAPABILITIES: Record<string, [string, string]> = {
  "navigation.open": ["Otwieranie stron aplikacji", "Emma może otwierać ekrany i zakładki w Secretary."],
  "navigation.help": ["Czytanie menu i prowadzenie użytkownika", "Emma może czytać strukturę aplikacji i wyjaśniać, gdzie znajdują się funkcje."],
  "preferences.language": ["Zmiana języka aplikacji", "Emma może jednocześnie zmieniać swój język mówiony i język menu Secretary."],
  "customers.read": ["Odczyt klientów, kontaktów i leadów", "Emma może wyświetlać klientów, kontakty i potencjalnych klientów."],
  "customers.write": ["Tworzenie klientów i leadów", "Emma może tworzyć klientów i leady oraz przekształcać lead w klienta."],
  "work.read": ["Odczyt zleceń, zadań i kalendarza", "Emma może wyświetlać pracę, zadania, działania następcze, wydarzenia i obciążenie."],
  "work.write": ["Zmiana zleceń i zadań", "Emma może tworzyć i zmieniać zlecenia oraz zadania, a także przydzielać pracę."],
  "services.write": ["Tworzenie usług", "Emma może dodawać pozycje do katalogu usług."],
  "sales.read": ["Odczyt ofert", "Emma może wyświetlać oferty i filtrować je według klienta."],
  "communication.read": ["Odczyt komunikacji", "Emma może czytać historię komunikacji, zapytania oraz listy wiadomości e-mail i WhatsApp."],
  "communication.write": ["Zapisywanie komunikacji", "Emma może dodawać wewnętrzne wpisy historii komunikacji."],
  "communication.email_send": ["Przygotowanie i wysyłanie e-maili", "Emma może przygotować, a po wyraźnym potwierdzeniu wysłać wiadomość Gmail."],
  "communication.whatsapp_send": ["Przygotowanie i wysyłanie WhatsApp", "Emma może przygotować, a po wyraźnym potwierdzeniu wysłać wiadomość WhatsApp Business."],
  "notifications.read": ["Odczyt powiadomień", "Emma może wyświetlać listę spraw wymagających uwagi."],
  "notifications.delete": ["Usuwanie powiadomień", "Emma może przygotować i po potwierdzeniu usunąć powiadomienia."],
  "quality.read": ["Odczyt jakości danych", "Emma może informować o możliwych duplikatach i brakujących danych kontaktowych."],
  "analytics.patterns": ["Analiza wzorców działań", "Emma może analizować powtarzające się działania zapisane w audycie."],
  "recruitment.read": ["Odczyt rekrutacji", "Emma może wyświetlać aktualne oferty pracy."],
  "learning.read": ["Odczyt reguł uczenia i pamięci", "Emma może czytać jawne reguły zwrotów i zapisane informacje."],
  "learning.write": ["Uczenie Emmy i zapisywanie pamięci", "Emma może tworzyć reguły uczenia oraz jawną pamięć osobistą lub firmową."],
  "photos.read": ["Odczyt zdjęć portfolio", "Emma może wyświetlać zarejestrowane zdjęcia portfolio."],
  "photos.write": ["Rejestrowanie zdjęć portfolio", "Emma może rejestrować zdjęcia na podstawie podanego odwołania do pliku."],
  "connectors.read": ["Odczyt stanu integracji", "Emma może informować, które integracje są skonfigurowane i dostępne."],
  "connectors.manage": ["Konfiguracja i synchronizacja integracji", "Emma może uruchamiać konfigurację integracji i synchronizację."],
};

const PL_CATEGORIES: Record<string, string> = {
  navigation: "Aplikacja i nawigacja", customers: "Klienci", work: "Praca i kalendarz", sales: "Usługi, oferty i sprzedaż",
  communication: "Komunikacja zewnętrzna i wewnętrzna", attention: "Powiadomienia i analizy", people: "Pracownicy i rekrutacja",
  learning: "Uczenie i pamięć", evidence: "Zdjęcia i materiały", connectors: "Integracje",
};

export function EmmaPermissions() {
  const { user } = useAuth();
  const language = appLanguage(user?.voiceLanguage);
  const polish = language === "pl-PL";
  const isAdministrator = user?.role === "administrator" || user?.role === "admin";
  const [capabilities, setCapabilities] = useState<EmmaCapabilityPolicyItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!isAdministrator) return;
    api.company.emmaPolicy()
      .then((policy) => setCapabilities(policy.capabilities))
      .catch((reason) => setError(reason instanceof ApiError ? reason.message : (polish ? "Nie udało się wczytać uprawnień Emmy." : "Could not load Emma permissions.")))
      .finally(() => setLoading(false));
  }, [isAdministrator, polish]);

  const groups = useMemo(() => CATEGORY_ORDER.map((category) => ({
    category,
    capabilities: capabilities.filter((item) => item.category === category),
  })).filter((group) => group.capabilities.length > 0), [capabilities]);

  if (!isAdministrator) return <Navigate to="/" replace />;

  function setEnabled(id: string, enabled: boolean) {
    setCapabilities((current) => current.map((item) => item.id === id ? { ...item, enabled } : item));
    setMessage(null);
  }

  function setMode(mode: EmmaCapabilityPolicyItem["mode"], enabled: boolean) {
    setCapabilities((current) => current.map((item) => item.mode === mode ? { ...item, enabled } : item));
    setMessage(null);
  }

  async function save() {
    setSaving(true); setError(null); setMessage(null);
    try {
      const policy = await api.company.updateEmmaPolicy(capabilities.filter((item) => !item.enabled).map((item) => item.id));
      setCapabilities(policy.capabilities);
      setMessage(polish ? "Uprawnienia Emmy zostały zapisane i obowiązują od razu." : "Emma permissions were saved and apply immediately.");
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : (polish ? "Nie udało się zapisać uprawnień Emmy." : "Could not save Emma permissions."));
    } finally { setSaving(false); }
  }

  if (loading) return <p>{polish ? "Wczytywanie…" : "Loading…"}</p>;

  return <div className="emma-permissions-page">
    <div className="page-header"><div>
      <h1>{polish ? "Uprawnienia Emmy" : "Emma permissions"}</h1>
      <p className="hint">{polish ? "Ustawienia firmowe widoczne tylko dla administratora. Wyłączona funkcja jest blokowana przez serwer dla wszystkich użytkowników." : "Company-wide controls visible only to administrators. A disabled capability is blocked by the server for every user."}</p>
    </div></div>

    <section className="emma-policy-summary">
      <div><strong>{capabilities.filter((item) => item.enabled).length}</strong><span>{polish ? "włączone" : "enabled"}</span></div>
      <div><strong>{capabilities.filter((item) => !item.enabled).length}</strong><span>{polish ? "wyłączone" : "disabled"}</span></div>
      <div><strong>{capabilities.filter((item) => item.enabled && item.mode === "external").length}</strong><span>{polish ? "działania zewnętrzne" : "external actions"}</span></div>
    </section>

    <div className="emma-policy-toolbar">
      <button type="button" className="secondary-button" onClick={() => setCapabilities((current) => current.map((item) => ({ ...item, enabled: true })))}>{polish ? "Włącz wszystko" : "Enable all"}</button>
      <button type="button" className="secondary-button" onClick={() => { setMode("write", false); setMode("external", false); setMode("administration", false); }}>{polish ? "Tylko odczyt" : "Read only"}</button>
      <button type="button" className="secondary-button" onClick={() => setMode("external", false)}>{polish ? "Wyłącz działania zewnętrzne" : "Disable external actions"}</button>
    </div>

    {error && <div className="error-banner" role="alert">{error}</div>}
    {message && <div className="success-banner" role="status">{message}</div>}

    <div className="emma-policy-groups">
      {groups.map((group) => <section className="settings-card" key={group.category}>
        <h2>{polish ? PL_CATEGORIES[group.category] : group.category.replaceAll("_", " ")}</h2>
        <div className="emma-capability-list">
          {group.capabilities.map((item) => {
            const localized = polish ? PL_CAPABILITIES[item.id] : undefined;
            const mode = polish
              ? ({ read: "odczyt", write: "zmiana danych", external: "działanie zewnętrzne", administration: "administracja" } as const)[item.mode]
              : item.mode;
            return <label className={`emma-capability ${item.enabled ? "is-enabled" : "is-disabled"}`} key={item.id}>
              <input type="checkbox" checked={item.enabled} onChange={(event) => setEnabled(item.id, event.target.checked)} />
              <span><strong>{localized?.[0] ?? item.label}</strong><small>{localized?.[1] ?? item.description}</small></span>
              <em className={`emma-capability-mode mode-${item.mode}`}>{mode}</em>
            </label>;
          })}
        </div>
      </section>)}
    </div>

    <div className="emma-policy-save">
      <button type="button" onClick={save} disabled={saving}>{saving ? (polish ? "Zapisywanie…" : "Saving…") : (polish ? "Zapisz uprawnienia Emmy" : "Save Emma permissions")}</button>
    </div>
  </div>;
}
