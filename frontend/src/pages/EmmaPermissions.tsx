import { useEffect, useMemo, useState } from "react";
import { Navigate } from "react-router-dom";
import { api, ApiError, type EmmaCapabilityPolicyItem } from "../api/client";
import { useAuth } from "../context/useAuth";
import { appLanguage } from "../i18n";

const CATEGORY_ORDER = ["navigation", "customers", "work", "sales", "communication", "attention", "people", "learning", "evidence", "connectors", "administration"];

const PL_CAPABILITIES: Record<string, [string, string]> = {
  "navigation.open": ["Otwieranie stron aplikacji", "{assistant} może otwierać ekrany i zakładki w Secretary."],
  "navigation.help": ["Czytanie menu i prowadzenie użytkownika", "{assistant} może czytać strukturę aplikacji i wyjaśniać, gdzie znajdują się funkcje."],
  "preferences.language": ["Zmiana języka aplikacji", "{assistant} może jednocześnie zmieniać swój język mówiony i język menu Secretary."],
  "customers.read": ["Odczyt klientów, kontaktów i leadów", "{assistant} może wyświetlać klientów, kontakty i potencjalnych klientów."],
  "customers.clients.create": ["Tworzenie klientów", "{assistant} może tworzyć klienta po sprawdzeniu nazwy, adresu e-mail i numeru telefonu."],
  "customers.clients.update": ["Edycja klientów", "{assistant} może zmieniać zweryfikowane dane istniejącego klienta."],
  "customers.clients.archive": ["Archiwizowanie klientów", "{assistant} może po wyraźnym potwierdzeniu zarchiwizować klienta bez usuwania powiązanych danych."],
  "customers.contacts.create": ["Tworzenie kontaktów", "{assistant} może dodawać zweryfikowane osoby do katalogu kontaktów."],
  "customers.contacts.update": ["Edycja kontaktów", "{assistant} może zmieniać zweryfikowane dane istniejącego kontaktu."],
  "customers.contacts.archive": ["Archiwizowanie kontaktów", "{assistant} może po wyraźnym potwierdzeniu zarchiwizować kontakt."],
  "customers.leads.write": ["Tworzenie i konwersja leadów", "{assistant} może tworzyć leady i przekształcać sprawdzony lead w klienta."],
  "work.read": ["Odczyt zleceń, zadań i kalendarza", "{assistant} może wyświetlać pracę, zadania, działania następcze, wydarzenia i obciążenie."],
  "work.write": ["Zmiana zleceń i zadań", "{assistant} może tworzyć i zmieniać zlecenia oraz zadania, a także przydzielać pracę."],
  "services.write": ["Tworzenie usług", "{assistant} może dodawać pozycje do katalogu usług."],
  "sales.read": ["Odczyt ofert", "{assistant} może wyświetlać oferty i filtrować je według klienta."],
  "communication.read": ["Odczyt komunikacji", "{assistant} może czytać historię komunikacji, zapytania oraz listy wiadomości e-mail i WhatsApp."],
  "communication.write": ["Zapisywanie komunikacji", "{assistant} może dodawać wewnętrzne wpisy historii komunikacji."],
  "communication.email_send": ["Przygotowanie i wysyłanie e-maili", "{assistant} może przygotować, a po wyraźnym potwierdzeniu wysłać wiadomość Gmail."],
  "communication.whatsapp_send": ["Przygotowanie i wysyłanie WhatsApp", "{assistant} może przygotować, a po wyraźnym potwierdzeniu wysłać wiadomość WhatsApp Business."],
  "notifications.read": ["Odczyt powiadomień", "{assistant} może wyświetlać listę spraw wymagających uwagi."],
  "notifications.delete": ["Usuwanie powiadomień", "{assistant} może przygotować i po potwierdzeniu usunąć powiadomienia."],
  "quality.read": ["Odczyt jakości danych", "{assistant} może informować o możliwych duplikatach i brakujących danych kontaktowych."],
  "analytics.patterns": ["Analiza wzorców działań", "{assistant} może analizować powtarzające się działania zapisane w audycie."],
  "recruitment.read": ["Odczyt rekrutacji", "{assistant} może wyświetlać aktualne oferty pracy."],
  "learning.read": ["Odczyt reguł uczenia i pamięci", "{assistant} może czytać jawne reguły zwrotów i zapisane informacje."],
  "learning.write": ["Uczenie asystenta i zapisywanie pamięci", "{assistant} może tworzyć reguły uczenia oraz jawną pamięć osobistą lub firmową."],
  "photos.read": ["Odczyt zdjęć portfolio", "{assistant} może wyświetlać zarejestrowane zdjęcia portfolio."],
  "photos.write": ["Rejestrowanie zdjęć portfolio", "{assistant} może rejestrować zdjęcia na podstawie podanego odwołania do pliku."],
  "connectors.read": ["Odczyt stanu integracji", "{assistant} może informować, które integracje są skonfigurowane i dostępne."],
  "connectors.manage": ["Konfiguracja i synchronizacja integracji", "{assistant} może uruchamiać konfigurację integracji i synchronizację."],
};

const PL_CATEGORIES: Record<string, string> = {
  navigation: "Aplikacja i nawigacja", customers: "Klienci", work: "Praca i kalendarz", sales: "Usługi, oferty i sprzedaż",
  communication: "Komunikacja zewnętrzna i wewnętrzna", attention: "Powiadomienia i analizy", people: "Pracownicy i rekrutacja",
  learning: "Uczenie i pamięć", evidence: "Zdjęcia i materiały", connectors: "Integracje",
  administration: "Administracja i bezpieczeństwo",
};

const CS_CAPABILITIES: Record<string, [string, string]> = {
  "navigation.open": ["Otevírání stránek aplikace", "{assistant} může otevírat obrazovky a záložky v Secretary."],
  "navigation.help": ["Čtení menu a vedení uživatele", "{assistant} může číst strukturu aplikace a vysvětlit, kde se jednotlivé funkce nacházejí."],
  "preferences.language": ["Změna jazyka aplikace", "{assistant} může současně změnit svůj mluvený jazyk i jazyk menu Secretary."],
  "customers.read": ["Čtení klientů, kontaktů a poptávek", "{assistant} může zobrazovat klienty, kontakty a potenciální klienty."],
  "customers.clients.create": ["Vytváření klientů", "{assistant} může vytvořit klienta po ověření názvu, e-mailu a telefonního čísla."],
  "customers.clients.update": ["Úprava klientů", "{assistant} může měnit ověřené údaje existujícího klienta."],
  "customers.clients.archive": ["Archivace klientů", "{assistant} může po výslovném potvrzení archivovat klienta bez odstranění souvisejících dat."],
  "customers.contacts.create": ["Vytváření kontaktů", "{assistant} může přidávat ověřené osoby do seznamu kontaktů."],
  "customers.contacts.update": ["Úprava kontaktů", "{assistant} může měnit ověřené údaje existujícího kontaktu."],
  "customers.contacts.archive": ["Archivace kontaktů", "{assistant} může po výslovném potvrzení archivovat kontakt."],
  "customers.leads.write": ["Vytváření a převod poptávek", "{assistant} může vytvářet poptávky a převádět ověřenou poptávku na klienta."],
  "work.read": ["Čtení zakázek, úkolů a kalendáře", "{assistant} může zobrazovat práci, úkoly, následné kroky, události a vytížení."],
  "work.write": ["Změny zakázek a úkolů", "{assistant} může vytvářet a měnit zakázky a úkoly a přidělovat práci."],
  "services.write": ["Vytváření služeb", "{assistant} může přidávat položky do katalogu služeb."],
  "sales.read": ["Čtení nabídek", "{assistant} může zobrazovat nabídky a filtrovat je podle klienta."],
  "communication.read": ["Čtení komunikace", "{assistant} může číst historii komunikace, dotazy a seznamy e-mailů a zpráv WhatsApp."],
  "communication.write": ["Zapisování komunikace", "{assistant} může přidávat interní záznamy do historie komunikace."],
  "communication.email_send": ["Příprava a odesílání e-mailů", "{assistant} může připravit a po výslovném potvrzení odeslat zprávu Gmail."],
  "communication.whatsapp_send": ["Příprava a odesílání přes WhatsApp", "{assistant} může připravit a po výslovném potvrzení odeslat zprávu WhatsApp Business."],
  "notifications.read": ["Čtení oznámení", "{assistant} může zobrazovat seznam záležitostí vyžadujících pozornost."],
  "notifications.delete": ["Mazání oznámení", "{assistant} může připravit a po potvrzení odstranit oznámení."],
  "quality.read": ["Čtení kvality dat", "{assistant} může upozornit na možné duplicity a chybějící kontaktní údaje."],
  "analytics.patterns": ["Analýza vzorců činností", "{assistant} může analyzovat opakující se činnosti uložené v auditu."],
  "recruitment.read": ["Čtení náboru", "{assistant} může zobrazovat aktuální pracovní pozice."],
  "learning.read": ["Čtení pravidel učení a paměti", "{assistant} může číst výslovná pravidla frází a uložené informace."],
  "learning.write": ["Učení asistenta a ukládání paměti", "{assistant} může vytvářet pravidla učení a výslovnou osobní nebo firemní paměť."],
  "photos.read": ["Čtení fotografií portfolia", "{assistant} může zobrazovat evidované fotografie portfolia."],
  "photos.write": ["Evidence fotografií portfolia", "{assistant} může evidovat fotografie podle zadaného odkazu na soubor."],
  "connectors.read": ["Čtení stavu konektorů", "{assistant} může sdělit, které konektory jsou nastavené a dostupné."],
  "connectors.manage": ["Nastavení a synchronizace konektorů", "{assistant} může spouštět nastavení a synchronizaci konektorů."],
};

const CS_CATEGORIES: Record<string, string> = {
  navigation: "Aplikace a navigace", customers: "Klienti", work: "Práce a kalendář", sales: "Služby, nabídky a prodej",
  communication: "Vnější a vnitřní komunikace", attention: "Oznámení a analýzy", people: "Uživatelé a nábor",
  learning: "Učení a paměť", evidence: "Fotografie a materiály", connectors: "Konektory",
  administration: "Administrace a bezpečnost",
};

export function EmmaPermissions() {
  const { user } = useAuth();
  const language = appLanguage(user?.voiceLanguage);
  const polish = language === "pl-PL";
  const czech = language === "cs-CZ";
  const isAdministrator = user?.role === "administrator" || user?.role === "admin";
  const [capabilities, setCapabilities] = useState<EmmaCapabilityPolicyItem[]>([]);
  const [summary, setSummary] = useState({ pages: 0, actions: 0, commands: 0, available: 0, unavailable: 0 });
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!isAdministrator) return;
    api.company.emmaPolicy()
      .then((policy) => { setCapabilities(policy.capabilities); setSummary(policy.summary); })
      .catch((reason) => setError(reason instanceof ApiError ? reason.message : (czech ? "Nepodařilo se načíst oprávnění asistenta." : polish ? "Nie udało się wczytać uprawnień asystenta." : "Could not load {assistant} permissions.")))
      .finally(() => setLoading(false));
  }, [czech, isAdministrator, polish]);

  const visibleCapabilities = useMemo(() => {
    const query = filter.trim().toLocaleLowerCase();
    if (!query) return capabilities;
    return capabilities.filter((item) => [item.label, item.description, item.id, item.route, item.actionName]
      .some((value) => value?.toLocaleLowerCase().includes(query)));
  }, [capabilities, filter]);

  const groups = useMemo(() => CATEGORY_ORDER.map((category) => ({
    category,
    capabilities: visibleCapabilities.filter((item) => item.category === category),
  })).filter((group) => group.capabilities.length > 0), [visibleCapabilities]);

  if (!isAdministrator) return <Navigate to="/" replace />;

  function setEnabled(id: string, enabled: boolean) {
    setCapabilities((current) => current.map((item) => item.id === id && item.availableToEmma !== false ? { ...item, enabled } : item));
    setMessage(null);
  }

  function setMode(mode: EmmaCapabilityPolicyItem["mode"], enabled: boolean) {
    setCapabilities((current) => current.map((item) => item.mode === mode && item.availableToEmma !== false ? { ...item, enabled } : item));
    setMessage(null);
  }

  async function save() {
    setSaving(true); setError(null); setMessage(null);
    try {
      const policy = await api.company.updateEmmaPolicy(capabilities.filter((item) => !item.enabled).map((item) => item.id));
      setCapabilities(policy.capabilities);
      setSummary(policy.summary);
      setMessage(czech ? "Oprávnění asistenta byla uložena a platí okamžitě." : polish ? "Uprawnienia asystenta zostały zapisane i obowiązują od razu." : "{assistant} permissions were saved and apply immediately.");
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : (czech ? "Nepodařilo se uložit oprávnění asistenta." : polish ? "Nie udało się zapisać uprawnień asystenta." : "Could not save {assistant} permissions."));
    } finally { setSaving(false); }
  }

  if (loading) return <p>{czech ? "Načítání…" : polish ? "Wczytywanie…" : "Loading…"}</p>;

  return <div className="emma-permissions-page">
    <div className="page-header"><div>
      <h1>{czech ? "Oprávnění asistenta" : polish ? "Uprawnienia asystenta" : "{assistant} permissions"}</h1>
      <p className="hint">{czech ? "Úplná, automaticky zrcadlená oprávnění pro každou stránku, operaci backendu a příkaz asistenta. Vypnutou funkci server zablokuje všem uživatelům." : polish ? "Pełne, automatycznie odzwierciedlane uprawnienia do każdej strony, operacji i polecenia asystenta. Wyłączona funkcja jest blokowana przez serwer dla wszystkich użytkowników." : "Complete automatically mirrored permissions for every page, backend action and {assistant} command. A disabled capability is blocked by the server for every user."}</p>
    </div></div>

    <section className="emma-policy-summary">
      <div><strong>{capabilities.filter((item) => item.enabled).length}</strong><span>{czech ? "zapnuto" : polish ? "włączone" : "enabled"}</span></div>
      <div><strong>{capabilities.filter((item) => !item.enabled).length}</strong><span>{czech ? "vypnuto" : polish ? "wyłączone" : "disabled"}</span></div>
      <div><strong>{capabilities.filter((item) => item.enabled && item.mode === "external").length}</strong><span>{czech ? "vnější akce" : polish ? "działania zewnętrzne" : "external actions"}</span></div>
      <div><strong>{summary.pages} / {summary.actions} / {summary.commands}</strong><span>{czech ? "stránky / operace / příkazy" : polish ? "strony / operacje / polecenia" : "pages / actions / commands"}</span></div>
      <div><strong>{summary.available} / {summary.unavailable}</strong><span>{czech ? "ovladatelné / pouze informační" : polish ? "sterowalne / tylko informacyjne" : "controllable / informational only"}</span></div>
    </section>

    <div className="emma-policy-toolbar">
      <button type="button" className="secondary-button" onClick={() => setCapabilities((current) => current.map((item) => item.availableToEmma === false ? item : { ...item, enabled: true }))}>{czech ? "Zapnout vše" : polish ? "Włącz wszystko" : "Enable all"}</button>
      <button type="button" className="secondary-button" onClick={() => { setMode("write", false); setMode("external", false); setMode("administration", false); }}>{czech ? "Pouze čtení" : polish ? "Tylko odczyt" : "Read only"}</button>
      <button type="button" className="secondary-button" onClick={() => setMode("external", false)}>{czech ? "Vypnout vnější akce" : polish ? "Wyłącz działania zewnętrzne" : "Disable external actions"}</button>
      <input className="emma-policy-filter" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder={czech ? "Hledat stránku nebo operaci…" : polish ? "Szukaj strony lub operacji…" : "Search pages or operations…"} />
    </div>

    {error && <div className="error-banner" role="alert">{error}</div>}
    {message && <div className="success-banner" role="status">{message}</div>}

    <div className="emma-policy-groups">
      {groups.map((group) => <section className="settings-card" key={group.category}>
        <h2>{czech ? CS_CATEGORIES[group.category] : polish ? PL_CATEGORIES[group.category] : group.category.replaceAll("_", " ")}</h2>
        <div className="emma-capability-list">
          {group.capabilities.map((item) => {
            const localized = czech ? CS_CAPABILITIES[item.id] : polish ? PL_CAPABILITIES[item.id] : undefined;
            const mode = czech
              ? ({ read: "čtení", write: "změna dat", external: "vnější akce", administration: "administrace" } as const)[item.mode]
              : polish
                ? ({ read: "odczyt", write: "zmiana danych", external: "działanie zewnętrzne", administration: "administracja" } as const)[item.mode]
                : item.mode;
            const unavailable = item.availableToEmma === false;
            return <label className={`emma-capability ${item.enabled ? "is-enabled" : "is-disabled"} ${unavailable ? "is-unavailable" : ""}`} key={item.id}>
              <input type="checkbox" checked={item.enabled} disabled={unavailable} onChange={(event) => setEnabled(item.id, event.target.checked)} />
              <span>
                <strong>{localized?.[0] ?? item.label}</strong>
                <small>{localized?.[1] ?? item.description}</small>
                {item.executionNote && <small>{item.executionClass}: {item.executionNote}</small>}
                {unavailable && <small>{czech ? "Tuto operaci {assistant} přímo neprovádí; je zobrazena pouze kvůli úplnosti systémového katalogu." : polish ? "{assistant} nie wykonuje tej operacji bezpośrednio; jest pokazana wyłącznie dla kompletności katalogu systemowego." : "{assistant} does not execute this operation directly; it is shown only for completeness of the system catalogue."}</small>}
                <small className="emma-capability-technical">{item.route ?? item.actionName ?? item.id}{item.requiredPermission ? ` · ${item.requiredPermission}` : ""}{item.voiceActions?.length ? ` · {assistant}: ${item.voiceActions.join(", ")}` : ""}{item.confirmationRequired ? (czech ? " · vyžaduje potvrzení" : polish ? " · wymaga potwierdzenia" : " · confirmation required") : ""}</small>
              </span>
              <em className={`emma-capability-mode mode-${item.mode}`}>{item.kind} · {mode}</em>
            </label>;
          })}
        </div>
      </section>)}
    </div>

    <div className="emma-policy-save">
      <button type="button" onClick={save} disabled={saving}>{saving ? (czech ? "Ukládání…" : polish ? "Zapisywanie…" : "Saving…") : (czech ? "Uložit oprávnění asistenta" : polish ? "Zapisz uprawnienia asystenta" : "Save {assistant} permissions")}</button>
    </div>
  </div>;
}
