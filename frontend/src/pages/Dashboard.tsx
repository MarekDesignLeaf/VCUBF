import { useAuth } from "../context/AuthContext";
import { CommandBar } from "../components/CommandBar";

export function Dashboard() {
  const { user } = useAuth();
  return (
    <div>
      <h1>Dashboard</h1>
      <p>
        Signed in as <strong>{user?.displayName}</strong> ({user?.role}).
      </p>
      <h2>Command</h2>
      <p className="hint">
        Type or dictate an English command instead of clicking through forms. A dictated
        transcript must be reviewed and run manually. Every submitted command is interpreted
        deterministically (no guessing) and fully audited by the same backend.
      </p>
      <CommandBar />
    </div>
  );
}
