export const APP_LANGUAGES = [
  { code: "en-GB", label: "English (United Kingdom)", nativeLabel: "English (United Kingdom)" },
  { code: "en-US", label: "English (United States)", nativeLabel: "English (United States)" },
  { code: "cs-CZ", label: "Czech", nativeLabel: "Čeština" },
  { code: "pl-PL", label: "Polish", nativeLabel: "Polski" },
  { code: "fr-FR", label: "French", nativeLabel: "Français" },
  { code: "de-DE", label: "German", nativeLabel: "Deutsch" },
  { code: "es-ES", label: "Spanish", nativeLabel: "Español" },
  { code: "it-IT", label: "Italian", nativeLabel: "Italiano" },
] as const;

export type AppLanguage = (typeof APP_LANGUAGES)[number]["code"];

export function isAppLanguage(value: string | null | undefined): value is AppLanguage {
  return APP_LANGUAGES.some((language) => language.code === value);
}

export function appLanguage(value: string | null | undefined): AppLanguage {
  return isAppLanguage(value) ? value : "en-GB";
}

export function languageLabel(value: string | null | undefined, native = false) {
  const language = APP_LANGUAGES.find((candidate) => candidate.code === value) ?? APP_LANGUAGES[0];
  return native ? language.nativeLabel : language.label;
}

export const MENU_KEYS = [
  "dashboard", "account", "notifications", "dataQuality", "metrics", "leads", "clients", "contacts", "documents", "jobs",
  "tasks", "enquiries", "communicationIntake", "communications", "photos", "photoSelection", "businessContext", "industries",
  "connectors", "websiteAudit", "websiteContent", "employees", "calendar", "services", "quotes", "invoices", "recruitment",
  "playbooks", "learning", "emmaMemory", "logout",
] as const;

export type MenuKey = (typeof MENU_KEYS)[number];

const ENGLISH: Record<MenuKey, string> = {
  dashboard: "Dashboard", account: "Account", notifications: "Notifications", dataQuality: "Data Quality", metrics: "Business Metrics",
  leads: "Leads", clients: "Clients", contacts: "Contacts", documents: "Documents", jobs: "Jobs", tasks: "Tasks", enquiries: "Enquiries",
  communicationIntake: "Communication Intake", communications: "Communications", photos: "Photos", photoSelection: "Photo Selection",
  businessContext: "Business Context", industries: "Industries", connectors: "Connectors", websiteAudit: "Website Audit", websiteContent: "Website Content",
  employees: "Employees", calendar: "Calendar", services: "Services", quotes: "Quotes", invoices: "Invoices", recruitment: "Recruitment",
  playbooks: "Playbooks", learning: "Learning", emmaMemory: "Emma Memory", logout: "Log out",
};

const TRANSLATIONS: Record<AppLanguage, Partial<Record<MenuKey, string>>> = {
  "en-GB": ENGLISH,
  "en-US": ENGLISH,
  "cs-CZ": {
    dashboard: "Přehled", account: "Účet", notifications: "Oznámení", dataQuality: "Kvalita dat", metrics: "Firemní metriky",
    leads: "Poptávky", clients: "Klienti", contacts: "Kontakty", documents: "Dokumenty", jobs: "Zakázky", tasks: "Úkoly", enquiries: "Dotazy",
    communicationIntake: "Příjem komunikace", communications: "Komunikace", photos: "Fotografie", photoSelection: "Výběr fotografií",
    businessContext: "Kontext firmy", industries: "Obory", connectors: "Konektory", websiteAudit: "Audit webu", websiteContent: "Obsah webu",
    employees: "Zaměstnanci", calendar: "Kalendář", services: "Služby", quotes: "Nabídky", invoices: "Faktury", recruitment: "Nábor",
    playbooks: "Postupy", learning: "Učení", emmaMemory: "Paměť Emmy", logout: "Odhlásit se",
  },
  "pl-PL": {
    dashboard: "Panel główny", account: "Konto", notifications: "Powiadomienia", dataQuality: "Jakość danych", metrics: "Wskaźniki firmy",
    leads: "Potencjalni klienci", clients: "Klienci", contacts: "Kontakty", documents: "Dokumenty", jobs: "Zlecenia", tasks: "Zadania", enquiries: "Zapytania",
    communicationIntake: "Przychodząca komunikacja", communications: "Komunikacja", photos: "Zdjęcia", photoSelection: "Wybór zdjęć",
    businessContext: "Kontekst firmy", industries: "Branże", connectors: "Integracje", websiteAudit: "Audyt strony", websiteContent: "Treść strony",
    employees: "Pracownicy", calendar: "Kalendarz", services: "Usługi", quotes: "Oferty", invoices: "Faktury", recruitment: "Rekrutacja",
    playbooks: "Procedury", learning: "Uczenie", emmaMemory: "Pamięć Emmy", logout: "Wyloguj się",
  },
  "fr-FR": {
    dashboard: "Tableau de bord", account: "Compte", notifications: "Notifications", dataQuality: "Qualité des données", metrics: "Indicateurs de l’entreprise",
    leads: "Prospects", clients: "Clients", contacts: "Contacts", documents: "Documents", jobs: "Interventions", tasks: "Tâches", enquiries: "Demandes",
    communicationIntake: "Réception des communications", communications: "Communications", photos: "Photos", photoSelection: "Sélection de photos",
    businessContext: "Contexte de l’entreprise", industries: "Secteurs", connectors: "Connecteurs", websiteAudit: "Audit du site", websiteContent: "Contenu du site",
    employees: "Employés", calendar: "Calendrier", services: "Services", quotes: "Devis", invoices: "Factures", recruitment: "Recrutement",
    playbooks: "Procédures", learning: "Apprentissage", emmaMemory: "Mémoire d’Emma", logout: "Se déconnecter",
  },
  "de-DE": {
    dashboard: "Übersicht", account: "Konto", notifications: "Benachrichtigungen", dataQuality: "Datenqualität", metrics: "Unternehmenskennzahlen",
    leads: "Interessenten", clients: "Kunden", contacts: "Kontakte", documents: "Dokumente", jobs: "Aufträge", tasks: "Aufgaben", enquiries: "Anfragen",
    communicationIntake: "Kommunikationseingang", communications: "Kommunikation", photos: "Fotos", photoSelection: "Fotoauswahl",
    businessContext: "Unternehmenskontext", industries: "Branchen", connectors: "Konnektoren", websiteAudit: "Website-Audit", websiteContent: "Website-Inhalte",
    employees: "Mitarbeiter", calendar: "Kalender", services: "Leistungen", quotes: "Angebote", invoices: "Rechnungen", recruitment: "Personalbeschaffung",
    playbooks: "Abläufe", learning: "Lernen", emmaMemory: "Emma-Speicher", logout: "Abmelden",
  },
  "es-ES": {
    dashboard: "Panel", account: "Cuenta", notifications: "Notificaciones", dataQuality: "Calidad de datos", metrics: "Métricas empresariales",
    leads: "Clientes potenciales", clients: "Clientes", contacts: "Contactos", documents: "Documentos", jobs: "Trabajos", tasks: "Tareas", enquiries: "Consultas",
    communicationIntake: "Entrada de comunicaciones", communications: "Comunicaciones", photos: "Fotos", photoSelection: "Selección de fotos",
    businessContext: "Contexto empresarial", industries: "Sectores", connectors: "Conectores", websiteAudit: "Auditoría web", websiteContent: "Contenido web",
    employees: "Empleados", calendar: "Calendario", services: "Servicios", quotes: "Presupuestos", invoices: "Facturas", recruitment: "Selección de personal",
    playbooks: "Procedimientos", learning: "Aprendizaje", emmaMemory: "Memoria de Emma", logout: "Cerrar sesión",
  },
  "it-IT": {
    dashboard: "Panoramica", account: "Account", notifications: "Notifiche", dataQuality: "Qualità dei dati", metrics: "Metriche aziendali",
    leads: "Potenziali clienti", clients: "Clienti", contacts: "Contatti", documents: "Documenti", jobs: "Lavori", tasks: "Attività", enquiries: "Richieste",
    communicationIntake: "Ricezione comunicazioni", communications: "Comunicazioni", photos: "Foto", photoSelection: "Selezione foto",
    businessContext: "Contesto aziendale", industries: "Settori", connectors: "Connettori", websiteAudit: "Audit del sito", websiteContent: "Contenuto del sito",
    employees: "Dipendenti", calendar: "Calendario", services: "Servizi", quotes: "Preventivi", invoices: "Fatture", recruitment: "Selezione del personale",
    playbooks: "Procedure", learning: "Apprendimento", emmaMemory: "Memoria di Emma", logout: "Esci",
  },
};

export function menuText(language: string | null | undefined, key: MenuKey) {
  const resolved = appLanguage(language);
  return TRANSLATIONS[resolved][key] ?? ENGLISH[key];
}
