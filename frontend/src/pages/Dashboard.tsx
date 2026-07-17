import { useAuth } from "../context/useAuth";
import { Link } from "react-router-dom";
import { appLanguage, roleLabel } from "../i18n";

const DASHBOARD_COPY = {
  en: {
    workspace: "YOUR WORKSPACE", greeting: "Good to see you", fallbackName: "there",
    intro: "Start with the work in front of you, then let Secretary keep the detail connected.", status: "Workspace status",
    workspaceLabel: "WORKSPACE", ready: "Ready to work", readyDetail: "Your customer and operational tools are in one place.",
    emma: "EMMA", available: "Available", managed: "Access managed",
    voiceAvailable: "Voice controls are available at the top of every workspace page.", voiceManaged: "Ask an administrator if you need voice-control access.",
    profile: "YOUR PROFILE", member: "Member", profileDetail: "Language, password and personal preferences are kept in your account.",
    start: "START HERE", next: "Common next steps", choose: "Choose what you want to do; the grouped menu stays available for everything else.",
    place: "Everything has a place.", placeDetail: "Use the left menu to move between customers, work and finance, growth, and system management without searching through one long list.",
    actions: [
      ["/leads", "CUSTOMERS", "Follow up leads", "Review interest, next contact and customer context."],
      ["/tasks", "WORK", "Plan today’s work", "Keep active tasks and their next action visible."],
      ["/calendar", "SCHEDULE", "Open the calendar", "See appointments and make room for what matters."],
      ["/quotes", "FINANCE", "Prepare a quote", "Move a conversation into a clear commercial next step."],
    ],
  },
  pl: {
    workspace: "TWÓJ OBSZAR ROBOCZY", greeting: "Dobrze Cię widzieć", fallbackName: "Użytkowniku",
    intro: "Zacznij od bieżącej pracy, a Secretary zadba o powiązanie wszystkich szczegółów.", status: "Stan obszaru roboczego",
    workspaceLabel: "OBSZAR ROBOCZY", ready: "Gotowy do pracy", readyDetail: "Narzędzia do obsługi klientów i działalności są w jednym miejscu.",
    emma: "EMMA", available: "Dostępna", managed: "Dostęp zarządzany",
    voiceAvailable: "Sterowanie głosowe jest dostępne u góry każdej strony obszaru roboczego.", voiceManaged: "Poproś administratora o dostęp do sterowania głosowego.",
    profile: "TWÓJ PROFIL", member: "Użytkownik", profileDetail: "Język, hasło i ustawienia osobiste są przechowywane na Twoim koncie.",
    start: "ZACZNIJ TUTAJ", next: "Najczęstsze następne kroki", choose: "Wybierz, co chcesz zrobić; pogrupowane menu pozostaje dostępne dla pozostałych funkcji.",
    place: "Wszystko ma swoje miejsce.", placeDetail: "Użyj menu po lewej stronie, aby przechodzić między klientami, pracą i finansami, rozwojem oraz zarządzaniem systemem.",
    actions: [
      ["/leads", "KLIENCI", "Obsłuż potencjalnych klientów", "Sprawdź zainteresowanie, następny kontakt i kontekst klienta."],
      ["/tasks", "PRACA", "Zaplanuj dzisiejszą pracę", "Miej aktywne zadania i ich następne działania zawsze pod ręką."],
      ["/calendar", "HARMONOGRAM", "Otwórz kalendarz", "Sprawdź spotkania i zaplanuj czas na to, co ważne."],
      ["/quotes", "FINANSE", "Przygotuj ofertę", "Przekształć rozmowę w konkretny następny krok handlowy."],
    ],
  },
  cs: {
    workspace: "VÁŠ PRACOVNÍ PROSTOR", greeting: "Rád vás vidím", fallbackName: "uživateli",
    intro: "Začněte prací, kterou máte před sebou; Secretary udrží všechny související podrobnosti pohromadě.", status: "Stav pracovního prostoru",
    workspaceLabel: "PRACOVNÍ PROSTOR", ready: "Připraveno k práci", readyDetail: "Nástroje pro zákazníky i provoz jsou na jednom místě.",
    emma: "EMMA", available: "Dostupná", managed: "Řízený přístup",
    voiceAvailable: "Hlasové ovládání je dostupné v horní části každé stránky pracovního prostoru.", voiceManaged: "Pokud potřebujete hlasové ovládání, požádejte správce.",
    profile: "VÁŠ PROFIL", member: "Uživatel", profileDetail: "Jazyk, heslo a osobní nastavení jsou uloženy ve vašem účtu.",
    start: "ZAČNĚTE ZDE", next: "Obvyklé další kroky", choose: "Vyberte, co chcete udělat; seskupené menu zůstává dostupné pro všechny ostatní funkce.",
    place: "Všechno má své místo.", placeDetail: "Pomocí levého menu přecházejte mezi klienty, prací a financemi, růstem a správou systému bez hledání v jednom dlouhém seznamu.",
    actions: [
      ["/leads", "KLIENTI", "Navázat na poptávky", "Zkontrolujte zájem, další kontakt a souvislosti klienta."],
      ["/tasks", "PRÁCE", "Naplánovat dnešní práci", "Mějte aktivní úkoly a jejich další kroky na očích."],
      ["/calendar", "PLÁN", "Otevřít kalendář", "Prohlédněte si schůzky a vytvořte prostor pro důležité věci."],
      ["/quotes", "FINANCE", "Připravit nabídku", "Převeďte rozhovor do jasného dalšího obchodního kroku."],
    ],
  },
  fr: {
    workspace: "VOTRE ESPACE DE TRAVAIL", greeting: "Ravi de vous revoir", fallbackName: "ici",
    intro: "Commencez par le travail en cours ; Secretary gardera tous les détails reliés.", status: "État de l’espace de travail",
    workspaceLabel: "ESPACE DE TRAVAIL", ready: "Prêt à travailler", readyDetail: "Vos outils clients et opérationnels sont réunis au même endroit.",
    emma: "EMMA", available: "Disponible", managed: "Accès géré", voiceAvailable: "Les commandes vocales sont disponibles en haut de chaque page.", voiceManaged: "Demandez l’accès aux commandes vocales à un administrateur.",
    profile: "VOTRE PROFIL", member: "Utilisateur", profileDetail: "La langue, le mot de passe et les préférences personnelles sont conservés dans votre compte.",
    start: "COMMENCEZ ICI", next: "Étapes suivantes courantes", choose: "Choisissez votre action ; le menu groupé reste disponible pour toutes les autres fonctions.", place: "Chaque chose a sa place.", placeDetail: "Utilisez le menu de gauche pour passer entre clients, travail et finances, croissance et gestion du système.",
    actions: [["/leads", "CLIENTS", "Suivre les prospects", "Vérifiez l’intérêt, le prochain contact et le contexte client."], ["/tasks", "TRAVAIL", "Planifier le travail du jour", "Gardez les tâches actives et leur prochaine action visibles."], ["/calendar", "PLANNING", "Ouvrir le calendrier", "Consultez les rendez-vous et réservez du temps pour l’essentiel."], ["/quotes", "FINANCES", "Préparer un devis", "Transformez une conversation en prochaine étape commerciale claire."]],
  },
  de: {
    workspace: "IHR ARBEITSBEREICH", greeting: "Schön, Sie zu sehen", fallbackName: "hier",
    intro: "Beginnen Sie mit der aktuellen Arbeit; Secretary hält alle zugehörigen Details zusammen.", status: "Status des Arbeitsbereichs",
    workspaceLabel: "ARBEITSBEREICH", ready: "Arbeitsbereit", readyDetail: "Ihre Kunden- und Betriebswerkzeuge befinden sich an einem Ort.",
    emma: "EMMA", available: "Verfügbar", managed: "Zugriff verwaltet", voiceAvailable: "Die Sprachsteuerung ist oben auf jeder Arbeitsbereichsseite verfügbar.", voiceManaged: "Bitten Sie einen Administrator um Zugriff auf die Sprachsteuerung.",
    profile: "IHR PROFIL", member: "Benutzer", profileDetail: "Sprache, Passwort und persönliche Einstellungen werden in Ihrem Konto gespeichert.",
    start: "HIER BEGINNEN", next: "Häufige nächste Schritte", choose: "Wählen Sie Ihre Aufgabe; das gruppierte Menü bleibt für alle weiteren Funktionen verfügbar.", place: "Alles hat seinen Platz.", placeDetail: "Wechseln Sie über das linke Menü zwischen Kunden, Arbeit und Finanzen, Wachstum und Systemverwaltung.",
    actions: [["/leads", "KUNDEN", "Interessenten nachverfolgen", "Prüfen Sie Interesse, nächsten Kontakt und Kundenkontext."], ["/tasks", "ARBEIT", "Heutige Arbeit planen", "Behalten Sie aktive Aufgaben und den nächsten Schritt im Blick."], ["/calendar", "PLANUNG", "Kalender öffnen", "Sehen Sie Termine und schaffen Sie Zeit für Wichtiges."], ["/quotes", "FINANZEN", "Angebot vorbereiten", "Machen Sie aus einem Gespräch einen klaren nächsten Geschäftsschritt."]],
  },
  es: {
    workspace: "SU ESPACIO DE TRABAJO", greeting: "Me alegra verle", fallbackName: "aquí",
    intro: "Empiece por el trabajo actual; Secretary mantendrá conectados todos los detalles.", status: "Estado del espacio de trabajo",
    workspaceLabel: "ESPACIO DE TRABAJO", ready: "Listo para trabajar", readyDetail: "Sus herramientas de clientes y operaciones están en un solo lugar.",
    emma: "EMMA", available: "Disponible", managed: "Acceso gestionado", voiceAvailable: "Los controles de voz están disponibles en la parte superior de cada página.", voiceManaged: "Pida acceso al control por voz a un administrador.",
    profile: "SU PERFIL", member: "Usuario", profileDetail: "El idioma, la contraseña y las preferencias personales se guardan en su cuenta.",
    start: "EMPIECE AQUÍ", next: "Próximos pasos habituales", choose: "Elija qué desea hacer; el menú agrupado permanece disponible para las demás funciones.", place: "Todo tiene su lugar.", placeDetail: "Use el menú izquierdo para desplazarse entre clientes, trabajo y finanzas, crecimiento y gestión del sistema.",
    actions: [["/leads", "CLIENTES", "Seguir clientes potenciales", "Revise el interés, el próximo contacto y el contexto del cliente."], ["/tasks", "TRABAJO", "Planificar el trabajo de hoy", "Mantenga visibles las tareas activas y su siguiente acción."], ["/calendar", "AGENDA", "Abrir el calendario", "Consulte citas y reserve tiempo para lo importante."], ["/quotes", "FINANZAS", "Preparar un presupuesto", "Convierta una conversación en un próximo paso comercial claro."]],
  },
  it: {
    workspace: "LA SUA AREA DI LAVORO", greeting: "Piacere di rivederla", fallbackName: "qui",
    intro: "Inizi dal lavoro attuale; Secretary manterrà collegati tutti i dettagli.", status: "Stato dell’area di lavoro",
    workspaceLabel: "AREA DI LAVORO", ready: "Pronta per il lavoro", readyDetail: "Gli strumenti per clienti e operazioni sono riuniti in un unico posto.",
    emma: "EMMA", available: "Disponibile", managed: "Accesso gestito", voiceAvailable: "I comandi vocali sono disponibili nella parte superiore di ogni pagina.", voiceManaged: "Chieda a un amministratore l’accesso ai comandi vocali.",
    profile: "IL SUO PROFILO", member: "Utente", profileDetail: "Lingua, password e preferenze personali sono conservate nel suo account.",
    start: "INIZI QUI", next: "Passaggi successivi comuni", choose: "Scelga cosa fare; il menu raggruppato resta disponibile per tutte le altre funzioni.", place: "Ogni cosa ha il suo posto.", placeDetail: "Usi il menu a sinistra per passare tra clienti, lavoro e finanze, crescita e gestione del sistema.",
    actions: [["/leads", "CLIENTI", "Seguire i potenziali clienti", "Verifichi interesse, prossimo contatto e contesto del cliente."], ["/tasks", "LAVORO", "Pianificare il lavoro di oggi", "Mantenga visibili le attività e la loro prossima azione."], ["/calendar", "AGENDA", "Aprire il calendario", "Consulti gli appuntamenti e riservi tempo a ciò che conta."], ["/quotes", "FINANZE", "Preparare un preventivo", "Trasformi una conversazione in un chiaro passo commerciale successivo."]],
  },
} as const;

export function Dashboard() {
  const { user } = useAuth();
  const canUseVoice = user?.permissions?.includes("voice.execute") ?? false;
  const language = appLanguage(user?.voiceLanguage);
  const copy = language === "cs-CZ" ? DASHBOARD_COPY.cs
    : language === "pl-PL" ? DASHBOARD_COPY.pl
      : language === "fr-FR" ? DASHBOARD_COPY.fr
        : language === "de-DE" ? DASHBOARD_COPY.de
          : language === "es-ES" ? DASHBOARD_COPY.es
            : language === "it-IT" ? DASHBOARD_COPY.it
              : DASHBOARD_COPY.en;
  const workspaceActions = copy.actions;

  return (
    <div className="dashboard-page">
      <section className="dashboard-hero">
        <div>
          <p className="dashboard-eyebrow">{copy.workspace}</p>
          <h1>{copy.greeting}, {user?.displayName?.split(" ")[0] || copy.fallbackName}.</h1>
          <p>{copy.intro}</p>
        </div>
        <Link className="dashboard-account-link" to="/account">
          <span className="dashboard-avatar" aria-hidden="true">{user?.displayName?.slice(0, 1).toUpperCase() || "U"}</span>
          <span><strong>{user?.displayName}</strong><small>{roleLabel(user?.role, language)}</small></span>
          <span aria-hidden="true">→</span>
        </Link>
      </section>

      <section className="dashboard-status-grid" aria-label={copy.status}>
        <article className="dashboard-status-card">
          <span className="status-dot status-dot-ready" aria-hidden="true" />
          <div><small>{copy.workspaceLabel}</small><strong>{copy.ready}</strong></div>
          <p>{copy.readyDetail}</p>
        </article>
        <article className="dashboard-status-card">
          <span className={`status-dot ${canUseVoice ? "status-dot-ready" : "status-dot-muted"}`} aria-hidden="true" />
          <div><small>{copy.emma}</small><strong>{canUseVoice ? copy.available : copy.managed}</strong></div>
          <p>{canUseVoice ? copy.voiceAvailable : copy.voiceManaged}</p>
        </article>
        <article className="dashboard-status-card">
          <span className="status-dot status-dot-accent" aria-hidden="true" />
          <div><small>{copy.profile}</small><strong>{user?.role ? roleLabel(user.role, language) : copy.member}</strong></div>
          <p>{copy.profileDetail}</p>
        </article>
      </section>

      <section className="dashboard-section">
        <div className="dashboard-section-heading">
          <div>
            <p className="dashboard-eyebrow">{copy.start}</p>
            <h2>{copy.next}</h2>
          </div>
          <p>{copy.choose}</p>
        </div>
        <div className="dashboard-action-grid">
          {workspaceActions.map(([to, eyebrow, title, description]) => (
            <Link className="dashboard-action-card" to={to} key={to}>
              <p>{eyebrow}</p>
              <h3>{title}</h3>
              <span>{description}</span>
              <b aria-hidden="true">→</b>
            </Link>
          ))}
        </div>
      </section>

      <section className="dashboard-structure-note">
        <span className="dashboard-structure-mark" aria-hidden="true">S</span>
        <div><strong>{copy.place}</strong><p>{copy.placeDetail}</p></div>
      </section>
    </div>
  );
}
