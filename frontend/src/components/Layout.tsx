import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../context/useAuth";
import { CommandBar } from "./CommandBar";
import { VoiceControlCenter } from "./VoiceControlCenter";
import { MobileVoiceControl } from "./MobileVoiceControl";
import { DesignLeafCredit } from "./DesignLeafCredit";
import { isAndroidNative } from "../lib/platform";
import { appLanguage, languageLabel, menuText, type MenuKey } from "../i18n";

type NavigationItem = { key: MenuKey; to: string; visible?: boolean };
type NavigationGroup = { id: string; label: string; items: NavigationItem[] };

function isCurrentPage(pathname: string, destination: string) {
  return destination === "/" ? pathname === "/" : pathname === destination || pathname.startsWith(`${destination}/`);
}

export function Layout() {
  const { user, logout } = useAuth();
  const location = useLocation();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const canRecruit = user?.permissions?.includes("recruitment.manage") ?? false;
  const canReadAudit = user?.permissions?.includes("audit.read") ?? false;
  const canUseEmmaMemory = user?.permissions?.includes("voice.execute") ?? false;
  const canReadConnectors = user?.permissions?.includes("connectors.read") ?? false;
  const canManageCompany = user?.permissions?.includes("company.manage") ?? false;
  const isAdministrator = user?.role === "administrator" || user?.role === "admin";
  const language = appLanguage(user?.voiceLanguage);
  const t = (key: MenuKey) => menuText(language, key);

  const navigationGroups: NavigationGroup[] = [
    {
      id: "overview",
      label: t("overview"),
      items: [
        { key: "dashboard", to: "/" },
        { key: "notifications", to: "/notifications" },
        { key: "metrics", to: "/metrics" },
      ],
    },
    {
      id: "customers",
      label: t("customers"),
      items: [
        { key: "leads", to: "/leads" },
        { key: "enquiries", to: "/enquiries" },
        { key: "communicationIntake", to: "/communication-intake" },
        { key: "clients", to: "/clients" },
        { key: "contacts", to: "/contacts" },
        { key: "communications", to: "/communications" },
        { key: "documents", to: "/documents" },
      ],
    },
    {
      id: "work-finance",
      label: t("workFinance"),
      items: [
        { key: "jobs", to: "/jobs" },
        { key: "tasks", to: "/tasks" },
        { key: "calendar", to: "/calendar" },
        { key: "services", to: "/services" },
        { key: "quotes", to: "/quotes" },
        { key: "invoices", to: "/invoices" },
      ],
    },
    {
      id: "growth",
      label: t("growth"),
      items: [
        { key: "businessContext", to: "/business-context" },
        { key: "industries", to: "/industries" },
        { key: "photos", to: "/portfolio" },
        { key: "photoSelection", to: "/photo-selection" },
        { key: "websiteAudit", to: "/website-audits" },
        { key: "websiteContent", to: "/website-content" },
        { key: "connectors", to: "/connectors", visible: canReadConnectors },
      ],
    },
    {
      id: "management",
      label: t("management"),
      items: [
        { key: "company", to: "/company", visible: canManageCompany },
        { key: "emmaPermissions", to: "/emma-permissions", visible: isAdministrator },
        { key: "employees", to: "/employees" },
        { key: "recruitment", to: "/recruitment", visible: canRecruit },
        { key: "dataQuality", to: "/data-quality" },
        { key: "playbooks", to: "/playbooks" },
        { key: "learning", to: "/learning" },
        { key: "emmaMemory", to: "/memory-model", visible: canUseEmmaMemory || canReadAudit },
      ],
    },
  ];

  const currentItem = navigationGroups
    .flatMap((group) => group.items)
    .find((item) => item.visible !== false && isCurrentPage(location.pathname, item.to));
  const currentGroup = navigationGroups.find((group) => group.items.some((item) => item.visible !== false && isCurrentPage(location.pathname, item.to)));

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  useEffect(() => {
    setMobileMenuOpen(false);
  }, [location.pathname]);

  return (
    <div className={`app-shell ${mobileMenuOpen ? "menu-open" : ""}`}>
      <aside className="sidebar">
        <div className="sidebar-brand-row">
          <div className="brand" aria-label="VCUF Secretary">
            <span className="brand-mark" aria-hidden="true">S</span>
            <span><strong>VCUF</strong><small>Secretary</small></span>
          </div>
          <button
            className="sidebar-menu-button"
            type="button"
            aria-expanded={mobileMenuOpen}
            aria-controls="secretary-navigation"
            onClick={() => setMobileMenuOpen((open) => !open)}
          >
            <span aria-hidden="true">{mobileMenuOpen ? "×" : "☰"}</span>
            <span className="visually-hidden">{mobileMenuOpen ? t("closeMenu") : t("openMenu")}</span>
          </button>
        </div>
        <p className="sidebar-caption">{t("workspace")}</p>
        <nav id="secretary-navigation" aria-label="Secretary navigation">
          {navigationGroups.map((group) => {
            const visibleItems = group.items.filter((item) => item.visible !== false);
            if (visibleItems.length === 0) return null;
            const groupIsCurrent = currentGroup?.id === group.id;
            const groupIsOpen = expandedGroups[group.id] ?? (groupIsCurrent || group.id === "overview");
            return (
              <details
                className={`nav-group ${groupIsCurrent ? "is-current" : ""}`}
                key={group.id}
                open={groupIsOpen}
                onToggle={(event) => {
                  const open = event.currentTarget.open;
                  setExpandedGroups((current) => ({ ...current, [group.id]: open }));
                }}
              >
                <summary>{group.label}<span aria-hidden="true" /></summary>
                <div className="nav-group-items">
                  {visibleItems.map((item) => (
                    <NavLink key={item.key} to={item.to} end={item.to === "/"}>
                      <span className="nav-item-marker" aria-hidden="true" />
                      <span>{t(item.key)}</span>
                    </NavLink>
                  ))}
                </div>
              </details>
            );
          })}
        </nav>
        <div className="sidebar-footer">
          <NavLink to="/account" className="account-link">
            <span className="account-avatar" aria-hidden="true">{user?.displayName?.slice(0, 1).toUpperCase() || "U"}</span>
            <span><strong>{user?.displayName}</strong><small>{languageLabel(language, true)}</small></span>
          </NavLink>
          <button type="button" className="logout-button" onClick={logout}>{t("logout")}</button>
          <DesignLeafCredit />
        </div>
      </aside>
      <main className="content">
        <header className="workspace-header">
          <div>
            <p>{currentGroup?.label ?? t("workspace")}</p>
            <strong>{currentItem ? t(currentItem.key) : t("workspace")}</strong>
          </div>
          <div className="workspace-header-status">
            <span className="workspace-live-dot" aria-hidden="true" />
            <span>Secretary</span>
          </div>
        </header>
        {user?.permissions?.includes("voice.execute") && <section className="assistant-area" aria-label="Emma assistant controls">
          {isAndroidNative() ? <MobileVoiceControl /> : <VoiceControlCenter />}
          <CommandBar />
        </section>}
        <div className="page-content">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
