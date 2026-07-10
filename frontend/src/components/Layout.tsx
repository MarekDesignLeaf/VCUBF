import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

export function Layout() {
  const { user, logout } = useAuth();
  const canRecruit = user?.permissions?.includes("recruitment.manage") ?? false;
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">VCUF Secretary</div>
        <nav>
          <NavLink to="/" end>Dashboard</NavLink>
          <NavLink to="/leads">Leads</NavLink>
          <NavLink to="/clients">Clients</NavLink>
          <NavLink to="/jobs">Jobs</NavLink>
          <NavLink to="/employees">Employees</NavLink>
          <NavLink to="/calendar">Calendar</NavLink>
          <NavLink to="/services">Services</NavLink>
          <NavLink to="/quotes">Quotes</NavLink>
          {canRecruit && <NavLink to="/recruitment">Recruitment</NavLink>}
        </nav>
        <div className="sidebar-footer">
          <div className="user-name">{user?.displayName}</div>
          <button onClick={logout}>Log out</button>
        </div>
      </aside>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
