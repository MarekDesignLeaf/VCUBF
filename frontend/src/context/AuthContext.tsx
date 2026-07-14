import { useEffect, useState, type ReactNode } from "react";
import { api, ApiError, getToken, setToken, type LoginResponse } from "../api/client";
import { AuthContext } from "./auth-state";

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<LoginResponse["user"] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!getToken()) {
      setLoading(false);
      return;
    }
    let active = true;
    let retryTimer: number | undefined;
    const loadSession = async (attempt = 0) => {
      try {
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

  function logout() {
    setToken(null);
    setUser(null);
  }

  function updateUser(patch: Partial<LoginResponse["user"]>) {
    setUser((current) => current ? { ...current, ...patch } : current);
  }

  return <AuthContext.Provider value={{ user, loading, login, logout, updateUser }}>{children}</AuthContext.Provider>;
}
