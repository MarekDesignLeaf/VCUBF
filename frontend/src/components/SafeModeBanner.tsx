import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, SAFE_MODE_EVENT, type SafeModeState } from "../api/client";

const TEXT = {
  "cs-CZ": { title: "Nouzové zastavení je zapnuté.", body: "Nic se nemění ani neodesílá. Číst můžete dál.", link: "Nastavení firmy" },
  "pl-PL": { title: "Awaryjne zatrzymanie jest włączone.", body: "Nic nie jest zmieniane ani wysyłane. Nadal można czytać.", link: "Ustawienia firmy" },
  "en-GB": { title: "Emergency stop is on.", body: "Nothing is changed or sent. Reading still works.", link: "Company settings" },
} as const;

/**
 * Shows the company's emergency stop on every page. The backend decides and
 * enforces it; this only tells people before they try to change something.
 */
export function SafeModeBanner({ language, canManage }: { language: string; canManage: boolean }) {
  const [state, setState] = useState<SafeModeState | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => api.company.safeMode()
      .then((value) => { if (!cancelled) setState(value); })
      .catch(() => { /* Unknown is shown as nothing; the backend still refuses. */ });
    load();
    window.addEventListener(SAFE_MODE_EVENT, load);
    window.addEventListener("focus", load);
    return () => {
      cancelled = true;
      window.removeEventListener(SAFE_MODE_EVENT, load);
      window.removeEventListener("focus", load);
    };
  }, []);

  if (!state?.enabled) return null;
  const text = TEXT[language as keyof typeof TEXT] ?? TEXT["en-GB"];
  return <div className="error-banner safe-mode-banner" role="alert">
    <strong>{text.title}</strong> {text.body}
    {canManage && <> <Link to="/company">{text.link}</Link></>}
  </div>;
}
