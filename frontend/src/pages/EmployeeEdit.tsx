import { useEffect, useState } from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import { api, ApiError, KNOWN_PERMISSIONS, type ManagedEmployee } from "../api/client";

// Employee and Permission Model — create or edit an employee account.
// This is the first UI in the app for a confirmationRequired action: the
// first submit sends confirmed: false (implicit) and the backend returns a
// 409 CONFIRMATION_REQUIRED with a preview instead of writing anything;
// only the second submit (after the user reviews the preview) sends
// confirmed: true and actually creates/changes the account.
export function EmployeeEdit() {
  const { id } = useParams<{ id: string }>();
  const isNew = !id || id === "new";
  const navigate = useNavigate();

  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState("worker");
  const [permissions, setPermissions] = useState<string[]>([]);
  const [skills, setSkills] = useState("");
  const [weeklyCapacityHours, setWeeklyCapacityHours] = useState("40");
  const [isActive, setIsActive] = useState(true);

  const [preview, setPreview] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [loaded, setLoaded] = useState(isNew);
  const [temporaryPassword, setTemporaryPassword] = useState("");
  const [resetPreview, setResetPreview] = useState<Record<string, unknown> | null>(null);
  const [resetMessage, setResetMessage] = useState<string | null>(null);

  useEffect(() => {
    if (isNew || !id) return;
    api.employees
      .getManaged(id)
      .then((e: ManagedEmployee) => {
        setDisplayName(e.displayName);
        setEmail(e.email);
        setRole(e.role);
        setPermissions(e.permissions);
        setSkills(e.skills.join(", "));
        setWeeklyCapacityHours(String(e.weeklyCapacityHours));
        setIsActive(e.isActive);
        setLoaded(true);
      })
      .catch(() => setError("Could not load employee."));
  }, [id, isNew]);

  function togglePermission(p: string) {
    setPermissions((prev) => (prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]));
  }

  function buildPayload(confirmed: boolean) {
    const skillsList = skills
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (isNew) {
      return {
        display_name: displayName,
        email,
        password,
        role,
        permissions,
        skills: skillsList,
        weekly_capacity_hours: Number(weeklyCapacityHours) || 40,
        confirmed,
      };
    }
    return {
      display_name: displayName,
      role,
      permissions,
      skills: skillsList,
      weekly_capacity_hours: Number(weeklyCapacityHours) || 40,
      is_active: isActive,
      confirmed,
    };
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      if (isNew) {
        await api.employees.create(buildPayload(false));
      } else if (id) {
        await api.employees.update(id, buildPayload(false));
      }
      // Should not reach here — the backend always returns CONFIRMATION_REQUIRED first.
    } catch (err) {
      if (err instanceof ApiError && err.code === "CONFIRMATION_REQUIRED") {
        setPreview((err.details?.preview as Record<string, unknown>) ?? null);
      } else {
        setError(err instanceof ApiError ? err.message : "Could not save employee.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleConfirm() {
    setSubmitting(true);
    setError(null);
    try {
      if (isNew) {
        await api.employees.create(buildPayload(true));
      } else if (id) {
        await api.employees.update(id, buildPayload(true));
      }
      navigate("/employees");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save employee.");
    } finally {
      setSubmitting(false);
    }
  }

  async function resetPassword(confirmed: boolean) {
    if (!id) return;
    setSubmitting(true); setError(null); setResetMessage(null);
    try {
      await api.employees.resetPassword(id, temporaryPassword, confirmed);
      setTemporaryPassword(""); setResetPreview(null);
      if (confirmed) setResetMessage("Password reset complete. Give the temporary password to the employee securely.");
    } catch (err) {
      if (err instanceof ApiError && err.code === "CONFIRMATION_REQUIRED") setResetPreview((err.details?.preview as Record<string, unknown>) ?? null);
      else setError(err instanceof ApiError ? err.message : "Could not reset password.");
    } finally { setSubmitting(false); }
  }

  if (!loaded) return <p>Loading…</p>;

  return (
    <div>
      <Link to="/employees">← Back to employees</Link>
      <h1>{isNew ? "New employee" : "Edit employee"}</h1>
      {error && <div className="error-banner">{error}</div>}

      {preview ? (
        <div className="warning-banner" style={{ marginBottom: 16 }}>
          <strong>Confirm this change:</strong>
          <pre style={{ whiteSpace: "pre-wrap", fontSize: "0.85rem" }}>{JSON.stringify(preview, null, 2)}</pre>
          <button onClick={handleConfirm} disabled={submitting} style={{ marginRight: 8 }}>
            {submitting ? "Saving…" : "Confirm and save"}
          </button>
          <button onClick={() => setPreview(null)} disabled={submitting}>
            Cancel
          </button>
        </div>
      ) : (
        <form className="inline-form" style={{ flexDirection: "column", alignItems: "stretch", maxWidth: 480 }} onSubmit={handleSubmit}>
          <label>
            Display name
            <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} required />
          </label>
          {isNew && (
            <>
              <label>
                Email
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
              </label>
              <label>
                Password
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  minLength={8}
                  required
                />
              </label>
            </>
          )}
          <label>
            Role
            <input value={role} onChange={(e) => setRole(e.target.value)} />
          </label>
          <label>
            Skills (comma-separated)
            <input value={skills} onChange={(e) => setSkills(e.target.value)} />
          </label>
          <label>
            Weekly capacity (hours)
            <input
              type="number"
              min="1"
              value={weeklyCapacityHours}
              onChange={(e) => setWeeklyCapacityHours(e.target.value)}
            />
          </label>
          {!isNew && (
            <label style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
              Active
            </label>
          )}
          <div>
            <div className="hint">Permissions</div>
            {KNOWN_PERMISSIONS.map((p) => (
              <label key={p} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <input type="checkbox" checked={permissions.includes(p)} onChange={() => togglePermission(p)} />
                <code>{p}</code>
              </label>
            ))}
          </div>
          <button type="submit" disabled={submitting}>
            {submitting ? "Checking…" : "Review changes"}
          </button>
        </form>
      )}
      {!isNew && (
        <section style={{ maxWidth: 480, marginTop: 32 }}>
          <h2>Reset password</h2>
          <p className="hint">This invalidates existing sessions. The employee must change the temporary password after signing in.</p>
          {resetMessage && <div className="success-banner">{resetMessage}</div>}
          {resetPreview ? <div className="warning-banner">
            <strong>Confirm password reset:</strong>
            <pre style={{ whiteSpace: "pre-wrap", fontSize: "0.85rem" }}>{JSON.stringify(resetPreview, null, 2)}</pre>
            <button type="button" onClick={() => resetPassword(true)} disabled={submitting}>Confirm reset</button>{" "}
            <button type="button" onClick={() => setResetPreview(null)} disabled={submitting}>Cancel</button>
          </div> : <div className="inline-form">
            <input type="password" autoComplete="new-password" minLength={12} placeholder="Temporary password" value={temporaryPassword} onChange={(e) => setTemporaryPassword(e.target.value)} />
            <button type="button" onClick={() => resetPassword(false)} disabled={submitting || temporaryPassword.length < 12}>Review reset</button>
          </div>}
        </section>
      )}
    </div>
  );
}
