import { useAuth } from "../context/AuthContext";

export function Dashboard() {
  const { user } = useAuth();
  return (
    <div>
      <h1>Dashboard</h1>
      <p>
        Signed in as <strong>{user?.displayName}</strong> ({user?.role}).
      </p>
      <p className="hint">
        This is the Secretary Core dashboard shell. Capacity, jobs and voice command widgets land here next.
      </p>
    </div>
  );
}
