import { useEffect } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../context/useAuth";
import { CommandBar } from "./CommandBar";
import { VoiceControlCenter } from "./VoiceControlCenter";
import { MobileVoiceControl, isAndroidNative } from "./MobileVoiceControl";
import { appLanguage, languageLabel, menuText, type MenuKey } from "../i18n";

export function Layout() {
  const { user, logout } = useAuth();
  const canRecruit = user?.permissions?.includes("recruitment.manage") ?? false;
  const canReadAudit = user?.permissions?.includes("audit.read") ?? false;
  const canUseEmmaMemory = user?.permissions?.includes("voice.execute") ?? false;
  const canReadConnectors = user?.permissions?.includes("connectors.read") ?? false;
  const language = appLanguage(user?.voiceLanguage);
  const t = (key: MenuKey) => menuText(language, key);

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">VCUF Secretary</div>
        <nav aria-label="Secretary navigation">
          <NavLink to="/" end>{t("dashboard")}</NavLink>
          <NavLink to="/account">{t("account")}</NavLink>
          <NavLink to="/notifications">{t("notifications")}</NavLink>
          <NavLink to="/data-quality">{t("dataQuality")}</NavLink>
          <NavLink to="/metrics">{t("metrics")}</NavLink>
          <NavLink to="/leads">{t("leads")}</NavLink>
          <NavLink to="/clients">{t("clients")}</NavLink>
          <NavLink to="/contacts">{t("contacts")}</NavLink>
          <NavLink to="/documents">{t("documents")}</NavLink>
          <NavLink to="/jobs">{t("jobs")}</NavLink>
          <NavLink to="/tasks">{t("tasks")}</NavLink>
          <NavLink to="/enquiries">{t("enquiries")}</NavLink>
          <NavLink to="/communication-intake">{t("communicationIntake")}</NavLink>
          <NavLink to="/communications">{t("communications")}</NavLink>
          <NavLink to="/portfolio">{t("photos")}</NavLink>
          <NavLink to="/photo-selection">{t("photoSelection")}</NavLink>
          <NavLink to="/business-context">{t("businessContext")}</NavLink>
          <NavLink to="/industries">{t("industries")}</NavLink>
          {canReadConnectors && <NavLink to="/connectors">{t("connectors")}</NavLink>}
          <NavLink to="/website-audits">{t("websiteAudit")}</NavLink>
          <NavLink to="/website-content">{t("websiteContent")}</NavLink>
          <NavLink to="/employees">{t("employees")}</NavLink>
          <NavLink to="/calendar">{t("calendar")}</NavLink>
          <NavLink to="/services">{t("services")}</NavLink>
          <NavLink to="/quotes">{t("quotes")}</NavLink>
          <NavLink to="/invoices">{t("invoices")}</NavLink>
          {canRecruit && <NavLink to="/recruitment">{t("recruitment")}</NavLink>}
          <NavLink to="/playbooks">{t("playbooks")}</NavLink>
          <NavLink to="/learning">{t("learning")}</NavLink>
          {(canUseEmmaMemory || canReadAudit) && <NavLink to="/memory-model">{t("emmaMemory")}</NavLink>}
        </nav>
        <div className="sidebar-footer">
          <div className="user-name">{user?.displayName}</div>
          <div className="hint" title="Emma and Secretary menu language">{languageLabel(language, true)}</div>
          <button onClick={logout}>{t("logout")}</button>
        </div>
      </aside>
      <main className="content">
        {user?.permissions?.includes("voice.execute") && <>
          {isAndroidNative() ? <MobileVoiceControl /> : <VoiceControlCenter />}
          <CommandBar />
        </>}
        <Outlet />
      </main>
    </div>
  );
}
