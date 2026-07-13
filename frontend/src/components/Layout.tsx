import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../context/useAuth";
import { CommandBar } from "./CommandBar";
import { VoiceControlCenter } from "./VoiceControlCenter";

export function Layout() {
  const { user, logout } = useAuth();
  const canRecruit = user?.permissions?.includes("recruitment.manage") ?? false;
  const canReadAudit = user?.permissions?.includes("audit.read") ?? false;
  const canUseEmmaMemory = user?.permissions?.includes("voice.execute") ?? false;
  const canReadConnectors = user?.permissions?.includes("connectors.read") ?? false;
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">VCUF Secretary</div>
        <nav>
          <NavLink to="/" end>Dashboard</NavLink>
          <NavLink to="/account">Account</NavLink>
          <NavLink to="/notifications">Notifications</NavLink>
          <NavLink to="/data-quality">Data Quality</NavLink>
          <NavLink to="/metrics">Business Metrics</NavLink>
          <NavLink to="/leads">Leads</NavLink>
          <NavLink to="/clients">Clients</NavLink>
          <NavLink to="/contacts">Contacts</NavLink>
          <NavLink to="/documents">Documents</NavLink>
          <NavLink to="/jobs">Jobs</NavLink>
          <NavLink to="/tasks">Tasks</NavLink>
          <NavLink to="/enquiries">Enquiries</NavLink>
          <NavLink to="/communication-intake">Communication Intake</NavLink>
          <NavLink to="/communications">Communications</NavLink>
          <NavLink to="/portfolio">Photos</NavLink>
          <NavLink to="/photo-selection">Photo Selection</NavLink>
          <NavLink to="/business-context">Business Context</NavLink>
          <NavLink to="/industries">Industries</NavLink>
          {canReadConnectors && <NavLink to="/connectors">Connectors</NavLink>}
          <NavLink to="/website-audits">Website Audit</NavLink>
          <NavLink to="/website-content">Website Content</NavLink>
          <NavLink to="/employees">Employees</NavLink>
          <NavLink to="/calendar">Calendar</NavLink>
          <NavLink to="/services">Services</NavLink>
          <NavLink to="/quotes">Quotes</NavLink>
          <NavLink to="/invoices">Invoices</NavLink>
          {canRecruit && <NavLink to="/recruitment">Recruitment</NavLink>}
          <NavLink to="/playbooks">Playbooks</NavLink>
          <NavLink to="/learning">Learning</NavLink>
          {(canUseEmmaMemory || canReadAudit) && <NavLink to="/memory-model">Emma Memory</NavLink>}
        </nav>
        <div className="sidebar-footer">
          <div className="user-name">{user?.displayName}</div>
          <button onClick={logout}>Log out</button>
        </div>
      </aside>
      <main className="content">
        {user?.permissions?.includes("voice.execute") && <><VoiceControlCenter /><CommandBar /></>}
        <Outlet />
      </main>
    </div>
  );
}
