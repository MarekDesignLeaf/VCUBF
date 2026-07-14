import { useAuth } from "../context/useAuth";
import { Link } from "react-router-dom";

const workspaceActions = [
  { to: "/leads", eyebrow: "CUSTOMERS", title: "Follow up leads", description: "Review interest, next contact and customer context." },
  { to: "/tasks", eyebrow: "WORK", title: "Plan today’s work", description: "Keep active tasks and their next action visible." },
  { to: "/calendar", eyebrow: "SCHEDULE", title: "Open the calendar", description: "See appointments and make room for what matters." },
  { to: "/quotes", eyebrow: "FINANCE", title: "Prepare a quote", description: "Move a conversation into a clear commercial next step." },
];

export function Dashboard() {
  const { user } = useAuth();
  const canUseVoice = user?.permissions?.includes("voice.execute") ?? false;

  return (
    <div className="dashboard-page">
      <section className="dashboard-hero">
        <div>
          <p className="dashboard-eyebrow">YOUR WORKSPACE</p>
          <h1>Good to see you, {user?.displayName?.split(" ")[0] || "there"}.</h1>
          <p>Start with the work in front of you, then let Secretary keep the detail connected.</p>
        </div>
        <Link className="dashboard-account-link" to="/account">
          <span className="dashboard-avatar" aria-hidden="true">{user?.displayName?.slice(0, 1).toUpperCase() || "U"}</span>
          <span><strong>{user?.displayName}</strong><small>{user?.role}</small></span>
          <span aria-hidden="true">→</span>
        </Link>
      </section>

      <section className="dashboard-status-grid" aria-label="Workspace status">
        <article className="dashboard-status-card">
          <span className="status-dot status-dot-ready" aria-hidden="true" />
          <div><small>WORKSPACE</small><strong>Ready to work</strong></div>
          <p>Your customer and operational tools are in one place.</p>
        </article>
        <article className="dashboard-status-card">
          <span className={`status-dot ${canUseVoice ? "status-dot-ready" : "status-dot-muted"}`} aria-hidden="true" />
          <div><small>EMMA</small><strong>{canUseVoice ? "Available" : "Access managed"}</strong></div>
          <p>{canUseVoice ? "Voice controls are available at the top of every workspace page." : "Ask an administrator if you need voice-control access."}</p>
        </article>
        <article className="dashboard-status-card">
          <span className="status-dot status-dot-accent" aria-hidden="true" />
          <div><small>YOUR PROFILE</small><strong>{user?.role || "Member"}</strong></div>
          <p>Language, password and personal preferences are kept in your account.</p>
        </article>
      </section>

      <section className="dashboard-section">
        <div className="dashboard-section-heading">
          <div>
            <p className="dashboard-eyebrow">START HERE</p>
            <h2>Common next steps</h2>
          </div>
          <p>Choose what you want to do; the grouped menu stays available for everything else.</p>
        </div>
        <div className="dashboard-action-grid">
          {workspaceActions.map((action) => (
            <Link className="dashboard-action-card" to={action.to} key={action.to}>
              <p>{action.eyebrow}</p>
              <h3>{action.title}</h3>
              <span>{action.description}</span>
              <b aria-hidden="true">→</b>
            </Link>
          ))}
        </div>
      </section>

      <section className="dashboard-structure-note">
        <span className="dashboard-structure-mark" aria-hidden="true">S</span>
        <div><strong>Everything has a place.</strong><p>Use the left menu to move between customers, work and finance, growth, and system management without searching through one long list.</p></div>
      </section>
    </div>
  );
}
