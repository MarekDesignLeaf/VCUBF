import { useAuth } from "../context/useAuth";
import { Link } from "react-router-dom";
import { appLanguage } from "../i18n";

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
} as const;

export function Dashboard() {
  const { user } = useAuth();
  const canUseVoice = user?.permissions?.includes("voice.execute") ?? false;
  const language = appLanguage(user?.voiceLanguage);
  const copy = language === "pl-PL" ? DASHBOARD_COPY.pl : DASHBOARD_COPY.en;
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
          <span><strong>{user?.displayName}</strong><small>{user?.role}</small></span>
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
          <div><small>{copy.profile}</small><strong>{user?.role || copy.member}</strong></div>
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
