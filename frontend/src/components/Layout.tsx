import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

export function Layout() {
  const { user, logout } = useAuth();
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
