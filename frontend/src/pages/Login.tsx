import { useEffect, useState } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../context/useAuth";
import { api, ApiError, type LocalTestUser } from "../api/client";
import { DesignLeafCredit } from "../components/DesignLeafCredit";
import { appLanguage, roleLabel, type AppLanguage } from "../i18n";

type LoginCopy = {
  eyebrow: string; headline: string; intro: string; features: string; customer: string; customerDetail: string; work: string; workDetail: string; emma: string; emmaDetail: string;
  local: string; choose: string; passwordOff: string; noUsers: string; localError: string; welcome: string; signIn: string; signInDetail: string;
  email: string; password: string; reset: string; hide: string; show: string; invalid: string; backendError: string; signing: string; enter: string; cannot: string; sendReset: string;
};

const LOGIN_COPY: Record<AppLanguage, LoginCopy> = {
  "en-GB": { eyebrow: "ONE WORKSPACE. CLEAR NEXT STEPS.", headline: "Run the day with less chasing and more clarity.", intro: "Secretary brings customers, work, finance and Emma into one focused workspace.", features: "Secretary features", customer: "Customer context", customerDetail: "Keep every contact, enquiry and conversation together.", work: "Work in motion", workDetail: "Move from lead to quote, job and invoice without losing the thread.", emma: "Emma at hand", emmaDetail: "Use voice guidance and actions where you need them.", local: "LOCAL TESTING", choose: "Choose a user", passwordOff: "The password is disabled during local testing.", noUsers: "No active user has been created yet.", localError: "Local sign-in failed.", welcome: "WELCOME BACK", signIn: "Sign in to your workspace", signInDetail: "Your access, language and assistant settings load after sign in.", email: "Email address", password: "Password", reset: "Reset password", hide: "Hide", show: "Show", invalid: "Invalid email or password.", backendError: "Could not reach the Secretary backend.", signing: "Signing in…", enter: "Enter Secretary", cannot: "Cannot sign in?", sendReset: "Send a new reset link" },
  "en-US": { eyebrow: "ONE WORKSPACE. CLEAR NEXT STEPS.", headline: "Run the day with less chasing and more clarity.", intro: "Secretary brings customers, work, finance and Emma into one focused workspace.", features: "Secretary features", customer: "Customer context", customerDetail: "Keep every contact, enquiry and conversation together.", work: "Work in motion", workDetail: "Move from lead to quote, job and invoice without losing the thread.", emma: "Emma at hand", emmaDetail: "Use voice guidance and actions where you need them.", local: "LOCAL TESTING", choose: "Choose a user", passwordOff: "The password is disabled during local testing.", noUsers: "No active user has been created yet.", localError: "Local sign-in failed.", welcome: "WELCOME BACK", signIn: "Sign in to your workspace", signInDetail: "Your access, language and assistant settings load after sign in.", email: "Email address", password: "Password", reset: "Reset password", hide: "Hide", show: "Show", invalid: "Invalid email or password.", backendError: "Could not reach the Secretary backend.", signing: "Signing in…", enter: "Enter Secretary", cannot: "Cannot sign in?", sendReset: "Send a new reset link" },
  "cs-CZ": { eyebrow: "JEDEN PRACOVNÍ PROSTOR. JASNÉ DALŠÍ KROKY.", headline: "Řiďte celý den s menším dohledáváním a větším přehledem.", intro: "Secretary spojuje klienty, práci, finance a Emmu do jednoho soustředěného pracovního prostoru.", features: "Funkce Secretary", customer: "Souvislosti klienta", customerDetail: "Mějte každý kontakt, dotaz a rozhovor pohromadě.", work: "Práce v pohybu", workDetail: "Přejděte od poptávky přes nabídku a zakázku až k faktuře bez ztráty souvislostí.", emma: "Emma po ruce", emmaDetail: "Používejte hlasové vedení a operace přesně tam, kde je potřebujete.", local: "LOKÁLNÍ TESTOVÁNÍ", choose: "Vyberte uživatele", passwordOff: "Heslo je po dobu lokálního testování vypnuté.", noUsers: "Zatím není vytvořen žádný aktivní uživatel.", localError: "Lokální přihlášení se nezdařilo.", welcome: "VÍTEJTE ZPĚT", signIn: "Přihlaste se do pracovního prostoru", signInDetail: "Po přihlášení se načtou vaše přístupy, jazyk a nastavení asistenta.", email: "E-mailová adresa", password: "Heslo", reset: "Obnovit heslo", hide: "Skrýt", show: "Zobrazit", invalid: "Neplatný e-mail nebo heslo.", backendError: "Nepodařilo se spojit se službou Secretary.", signing: "Přihlašování…", enter: "Vstoupit do Secretary", cannot: "Nemůžete se přihlásit?", sendReset: "Odeslat nový odkaz pro obnovení" },
  "pl-PL": { eyebrow: "JEDEN OBSZAR ROBOCZY. JASNE KOLEJNE KROKI.", headline: "Prowadź dzień z mniejszą liczbą poszukiwań i większą przejrzystością.", intro: "Secretary łączy klientów, pracę, finanse i Emmę w jednym skupionym obszarze roboczym.", features: "Funkcje Secretary", customer: "Kontekst klienta", customerDetail: "Przechowuj każdy kontakt, zapytanie i rozmowę razem.", work: "Praca w toku", workDetail: "Przechodź od potencjalnego klienta przez ofertę i zlecenie do faktury bez utraty kontekstu.", emma: "Emma pod ręką", emmaDetail: "Korzystaj ze wskazówek głosowych i działań tam, gdzie ich potrzebujesz.", local: "TESTY LOKALNE", choose: "Wybierz użytkownika", passwordOff: "Hasło jest wyłączone na czas testów lokalnych.", noUsers: "Nie utworzono jeszcze aktywnego użytkownika.", localError: "Logowanie lokalne nie powiodło się.", welcome: "WITAJ PONOWNIE", signIn: "Zaloguj się do obszaru roboczego", signInDetail: "Po zalogowaniu zostaną wczytane uprawnienia, język i ustawienia asystenta.", email: "Adres e-mail", password: "Hasło", reset: "Zresetuj hasło", hide: "Ukryj", show: "Pokaż", invalid: "Nieprawidłowy adres e-mail lub hasło.", backendError: "Nie udało się połączyć z usługą Secretary.", signing: "Logowanie…", enter: "Wejdź do Secretary", cannot: "Nie możesz się zalogować?", sendReset: "Wyślij nowy link resetujący" },
  "fr-FR": { eyebrow: "UN ESPACE. DES ÉTAPES CLAIRES.", headline: "Gérez la journée avec moins de recherches et plus de clarté.", intro: "Secretary réunit clients, travail, finances et Emma dans un espace de travail unique.", features: "Fonctions de Secretary", customer: "Contexte client", customerDetail: "Regroupez chaque contact, demande et conversation.", work: "Travail en cours", workDetail: "Passez du prospect au devis, à l’intervention et à la facture sans perdre le fil.", emma: "Emma à portée de voix", emmaDetail: "Utilisez les conseils et actions vocales là où vous en avez besoin.", local: "TEST LOCAL", choose: "Choisissez un utilisateur", passwordOff: "Le mot de passe est désactivé pendant le test local.", noUsers: "Aucun utilisateur actif n’a encore été créé.", localError: "La connexion locale a échoué.", welcome: "BON RETOUR", signIn: "Connectez-vous à votre espace", signInDetail: "Vos accès, votre langue et les réglages de l’assistant se chargent après la connexion.", email: "Adresse e-mail", password: "Mot de passe", reset: "Réinitialiser", hide: "Masquer", show: "Afficher", invalid: "Adresse e-mail ou mot de passe incorrect.", backendError: "Impossible de joindre le service Secretary.", signing: "Connexion…", enter: "Entrer dans Secretary", cannot: "Connexion impossible ?", sendReset: "Envoyer un nouveau lien" },
  "de-DE": { eyebrow: "EIN ARBEITSBEREICH. KLARE NÄCHSTE SCHRITTE.", headline: "Steuern Sie den Tag mit weniger Suchen und mehr Klarheit.", intro: "Secretary vereint Kunden, Arbeit, Finanzen und Emma in einem konzentrierten Arbeitsbereich.", features: "Secretary-Funktionen", customer: "Kundenkontext", customerDetail: "Halten Sie jeden Kontakt, jede Anfrage und jedes Gespräch zusammen.", work: "Arbeit in Bewegung", workDetail: "Gehen Sie vom Interessenten über Angebot und Auftrag bis zur Rechnung, ohne den Zusammenhang zu verlieren.", emma: "Emma zur Hand", emmaDetail: "Nutzen Sie Sprachführung und Aktionen dort, wo Sie sie benötigen.", local: "LOKALER TEST", choose: "Benutzer auswählen", passwordOff: "Das Passwort ist während des lokalen Tests deaktiviert.", noUsers: "Es wurde noch kein aktiver Benutzer erstellt.", localError: "Lokale Anmeldung fehlgeschlagen.", welcome: "WILLKOMMEN ZURÜCK", signIn: "Im Arbeitsbereich anmelden", signInDetail: "Zugriff, Sprache und Assistenteneinstellungen werden nach der Anmeldung geladen.", email: "E-Mail-Adresse", password: "Passwort", reset: "Passwort zurücksetzen", hide: "Ausblenden", show: "Anzeigen", invalid: "E-Mail-Adresse oder Passwort ist ungültig.", backendError: "Der Secretary-Dienst ist nicht erreichbar.", signing: "Anmeldung…", enter: "Secretary öffnen", cannot: "Anmeldung nicht möglich?", sendReset: "Neuen Rücksetzlink senden" },
  "es-ES": { eyebrow: "UN ESPACIO. PRÓXIMOS PASOS CLAROS.", headline: "Dirija el día con menos búsquedas y más claridad.", intro: "Secretary reúne clientes, trabajo, finanzas y Emma en un espacio de trabajo centrado.", features: "Funciones de Secretary", customer: "Contexto del cliente", customerDetail: "Mantenga juntos cada contacto, consulta y conversación.", work: "Trabajo en marcha", workDetail: "Pase del cliente potencial al presupuesto, trabajo y factura sin perder el hilo.", emma: "Emma a mano", emmaDetail: "Use orientación y acciones por voz donde las necesite.", local: "PRUEBA LOCAL", choose: "Elija un usuario", passwordOff: "La contraseña está desactivada durante la prueba local.", noUsers: "Todavía no se ha creado ningún usuario activo.", localError: "El inicio de sesión local ha fallado.", welcome: "BIENVENIDO DE NUEVO", signIn: "Inicie sesión en su espacio", signInDetail: "El acceso, el idioma y los ajustes del asistente se cargan después de iniciar sesión.", email: "Correo electrónico", password: "Contraseña", reset: "Restablecer contraseña", hide: "Ocultar", show: "Mostrar", invalid: "Correo electrónico o contraseña no válidos.", backendError: "No se pudo conectar con el servicio Secretary.", signing: "Iniciando sesión…", enter: "Entrar en Secretary", cannot: "¿No puede iniciar sesión?", sendReset: "Enviar un nuevo enlace" },
  "it-IT": { eyebrow: "UN’AREA DI LAVORO. PASSAGGI CHIARI.", headline: "Gestisca la giornata con meno ricerche e maggiore chiarezza.", intro: "Secretary riunisce clienti, lavoro, finanze ed Emma in un’unica area di lavoro.", features: "Funzioni di Secretary", customer: "Contesto del cliente", customerDetail: "Tenga insieme ogni contatto, richiesta e conversazione.", work: "Lavoro in corso", workDetail: "Passi dal potenziale cliente al preventivo, al lavoro e alla fattura senza perdere il filo.", emma: "Emma a portata di voce", emmaDetail: "Usi guida e azioni vocali dove servono.", local: "TEST LOCALE", choose: "Scelga un utente", passwordOff: "La password è disattivata durante il test locale.", noUsers: "Non è ancora stato creato alcun utente attivo.", localError: "Accesso locale non riuscito.", welcome: "BENTORNATO", signIn: "Acceda all’area di lavoro", signInDetail: "Accesso, lingua e impostazioni dell’assistente vengono caricati dopo l’accesso.", email: "Indirizzo e-mail", password: "Password", reset: "Reimposta password", hide: "Nascondi", show: "Mostra", invalid: "E-mail o password non validi.", backendError: "Impossibile contattare il servizio Secretary.", signing: "Accesso…", enter: "Entra in Secretary", cannot: "Non riesce ad accedere?", sendReset: "Invia un nuovo link" },
};

export function Login() {
  const { login, localTestLogin, user, loading } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [email, setEmail] = useState(() => params.get("email") ?? localStorage.getItem("vcuf_last_email") ?? "");
  const [password, setPassword] = useState("");
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [setupRequired, setSetupRequired] = useState<boolean | null>(null);
  const [localTestUsers, setLocalTestUsers] = useState<LocalTestUser[] | null>(null);
  const selectedLanguage = appLanguage(localTestUsers?.[0]?.voiceLanguage ?? localStorage.getItem("vcubf_last_language"));
  const copy = LOGIN_COPY[selectedLanguage];

  useEffect(() => {
    api.setupStatus().then((status) => setSetupRequired(status.setupRequired)).catch(() => setSetupRequired(false));
    if (params.get("localTest") === "1" && ["localhost", "127.0.0.1"].includes(window.location.hostname)) {
      api.localTestUsers().then(setLocalTestUsers).catch(() => setLocalTestUsers(null));
    }
  }, []);

  async function selectLocalTestUser(userId: string) {
    setError(null);
    setSubmitting(true);
    try {
      const selected = await localTestLogin(userId);
      localStorage.setItem("vcubf_last_language", selected.voiceLanguage);
      navigate(selected.mustChangePassword ? "/account" : "/");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : copy.localError);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const user = await login(email, password);
      localStorage.setItem("vcuf_last_email", email.trim());
      localStorage.setItem("vcubf_last_language", user.voiceLanguage);
      const requested=params.get("returnTo");
      navigate(user.mustChangePassword ? "/account" : requested?.startsWith("/") ? requested : "/");
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.code === "INVALID_CREDENTIALS" ? copy.invalid : err.message);
      } else {
        setError(copy.backendError);
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (!loading && user) return <Navigate to="/" replace />;
  if (setupRequired) return <Navigate to="/setup" replace />;

  return (
    <div className="login-page">
      <section className="login-introduction" aria-label="VCUF Secretary">
        <div className="login-brand">
          <span className="login-brand-mark" aria-hidden="true">S</span>
          <span><strong>VCUF</strong><small>Secretary</small></span>
        </div>
        <div className="login-introduction-copy">
          <p className="login-eyebrow">{copy.eyebrow}</p>
          <h1>{copy.headline}</h1>
          <p>{copy.intro}</p>
        </div>
        <div className="login-feature-list" aria-label={copy.features}>
          <div><span>01</span><p><strong>{copy.customer}</strong>{copy.customerDetail}</p></div>
          <div><span>02</span><p><strong>{copy.work}</strong>{copy.workDetail}</p></div>
          <div><span>03</span><p><strong>{copy.emma}</strong>{copy.emmaDetail}</p></div>
        </div>
        <div className="login-meta">
          <p className="login-version">VCUF Secretary · build {__VCUBF_BUILD__}</p>
          <DesignLeafCredit />
        </div>
      </section>

      <main className="login-panel">
        {localTestUsers ? <section className="login-card local-test-login-card">
          <div className="login-card-heading">
            <p className="login-eyebrow">{copy.local}</p>
            <h2>{copy.choose}</h2>
            <p className="subtitle">{copy.passwordOff}</p>
          </div>
          <div className="local-test-user-grid">
            {localTestUsers.map((testUser) => <button
              className="local-test-user-tile"
              type="button"
              key={testUser.id}
              disabled={submitting}
              onClick={() => void selectLocalTestUser(testUser.id)}
            >
              <span className="local-test-user-avatar" aria-hidden="true">{testUser.displayName.slice(0, 1).toUpperCase()}</span>
              <span><strong>{testUser.displayName}</strong><small>{roleLabel(testUser.role, selectedLanguage)}</small></span>
            </button>)}
          </div>
          {localTestUsers.length === 0 && <p className="subtitle">{copy.noUsers}</p>}
          {error && <div className="error-banner" role="alert">{error}</div>}
        </section> : <form className="login-card" onSubmit={handleSubmit}>
          <div className="login-card-heading">
            <p className="login-eyebrow">{copy.welcome}</p>
            <h2>{copy.signIn}</h2>
            <p className="subtitle">{copy.signInDetail}</p>
          </div>
          <label>
            {copy.email}
            <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
          </label>
          <label>
            <span className="login-field-heading">
              {copy.password}
              <Link className="login-inline-reset" to="/forgot-password">{copy.reset}</Link>
            </span>
            <span className="password-input-wrap">
              <input type={passwordVisible ? "text" : "password"} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
              <button
                className="password-visibility-button"
                type="button"
                aria-label={passwordVisible ? copy.hide : copy.show}
                aria-pressed={passwordVisible}
                onClick={() => setPasswordVisible((visible) => !visible)}
              >
                {passwordVisible ? copy.hide : copy.show}
              </button>
            </span>
          </label>
          {error && <div className="error-banner" role="alert">{error}</div>}
          <button className="login-submit" type="submit" disabled={submitting}>
            {submitting ? copy.signing : copy.enter}
          </button>
          <p className="login-reset-hint">{copy.cannot} <Link to="/forgot-password">{copy.sendReset}</Link></p>
        </form>}
      </main>
    </div>
  );
}
