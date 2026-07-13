import { useAuth } from "../context/useAuth";

export function Dashboard() {
  const { user } = useAuth();
  return (
    <div>
      <h1>Dashboard</h1>
      <p>
        Signed in as <strong>{user?.displayName}</strong> ({user?.role}).
      </p>
      <p className="hint">Windows Emma remains available above every page for hands-free voice assistance. An optional typed command field is collapsed below her controls.</p>
    </div>
  );
}
