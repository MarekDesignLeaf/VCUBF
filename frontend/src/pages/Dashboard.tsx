import { useAuth } from "../context/useAuth";

export function Dashboard() {
  const { user } = useAuth();
  return (
    <div>
      <h1>Dashboard</h1>
      <p>
        Signed in as <strong>{user?.displayName}</strong> ({user?.role}).
      </p>
      <p className="hint">The voice and text command centre remains available above every page. Dictated commands always pause for transcript review before execution.</p>
    </div>
  );
}
