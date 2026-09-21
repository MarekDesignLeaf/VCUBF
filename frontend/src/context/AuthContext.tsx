import { useEffect, useState, type ReactNode } from "react";
import { api, ApiError, getToken, setToken, SESSION_ENDED_EVENT, type LoginResponse } from "../api/client";
import { AuthContext } from "./auth-state";

/** Whether this page is served from the developer's own machine. */
function isLocalhost() {
  return ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<LoginResponse["user"] | null>(null);
  const [loading, setLoading] = useState(true);

  /**
   * The session can end while the app is open — a token outlives its seven days,
   * or a password change moves the account on. The api layer recovers where it
   * can and raises this when it cannot; forgetting the signed-in user here is
   * what sends the person to the sign-in screen instead of leaving every panel
   * reporting its own failure.
   */
  useEffect(() => {
    const ended = () => setUser(null);
    window.addEventListener(SESSION_ENDED_EVENT, ended);
    return () => window.removeEventListener(SESSION_ENDED_EVENT, ended);
  }, []);

  useEffect(() => {
    let active = true;
    let retryTimer: number | undefined;
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const desktopBootstrap = hash.get("desktop_token");
    const localTestChooser = new URLSearchParams(window.location.search).get("localTest") === "1";
    if (desktopBootstrap) window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    if (localTestChooser) setToken(null);
    const loadSession = async (attempt = 0) => {
      try {
        if (desktopBootstrap && attempt === 0) {
          const session = await api.desktopLogin(desktopBootstrap);
          setToken(session.token);
          if (active) setUser(session.user);
          if (active) setLoading(false);
          return;
        }
        if (localTestChooser || !getToken()) {
          // Running from localhost there is no reason to demand a password:
          // ask the backend for the account already selected on this machine.
          // It answers only to 127.0.0.1 and only when explicitly enabled, so
          // this cannot weaken a deployed server.
          if (!localTestChooser && isLocalhost()) {
            try {
              const session = await api.localTestActiveSession();
              setToken(session.token);
              if (active) setUser(session.user);
            } catch { /* No account chosen yet; the tiles will ask once. */ }
          }
          if (active) setLoading(false);
          return;
        }
        const profile = await api.me();
        if (active) setUser(profile);
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          setToken(null);
        } else if (active && attempt < 3) {
          retryTimer = window.setTimeout(() => void loadSession(attempt + 1), 750 * (attempt + 1));
          return;
        }
      }
      if (active) setLoading(false);
    };
    void loadSession();
    return () => {
      active = false;
      if (retryTimer) window.clearTimeout(retryTimer);
    };
  }, []);

  async function login(email: string, password: string) {
    const res = await api.login(email, password);
    setToken(res.token);
    setUser(res.user);
    return res.user;
  }

  async function localTestLogin(userId: string) {
    const res = await api.localTestLogin(userId);
    setToken(res.token);
    setUser(res.user);
    return res.user;
  }

  function logout() {
    setToken(null);
    setUser(null);
  }

  function updateUser(patch: Partial<LoginResponse["user"]>) {
    setUser((current) => current ? { ...current, ...patch } : current);
  }

  return <AuthContext.Provider value={{ user, loading, login, localTestLogin, logout, updateUser }}>{children}</AuthContext.Provider>;
}
