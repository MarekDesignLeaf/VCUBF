import { isVoiceLanguage, VOICE_LANGUAGE_LABELS, type VoiceLanguage } from "./voiceLanguages.js";

export const VOICE_PAGE_ROUTES = {
  dashboard: { path: "/", label: "Dashboard" },
  setup: { path: "/setup", label: "First-time Setup" },
  forgot_password: { path: "/forgot-password", label: "Password Recovery" },
  reset_password: { path: "/reset-password", label: "Set New Password" },
  account: { path: "/account", label: "Account" },
  emma_permissions: { path: "/emma-permissions", label: "Emma Permissions" },
  notifications: { path: "/notifications", label: "Notifications" },
  data_quality: { path: "/data-quality", label: "Data Quality" },
  metrics: { path: "/metrics", label: "Business Metrics" },
  leads: { path: "/leads", label: "Leads" },
  clients: { path: "/clients", label: "Clients" },
  contacts: { path: "/contacts", label: "Contacts" },
  documents: { path: "/documents", label: "Documents" },
  jobs: { path: "/jobs", label: "Jobs" },
  tasks: { path: "/tasks", label: "Tasks" },
  enquiries: { path: "/enquiries", label: "Enquiries" },
  communication_intake: { path: "/communication-intake", label: "Communication Intake" },
  communications: { path: "/communications", label: "Communications" },
  photos: { path: "/portfolio", label: "Photos" },
  photo_selection: { path: "/photo-selection", label: "Photo Selection" },
  business_context: { path: "/business-context", label: "Business Context" },
  industries: { path: "/industries", label: "Industries" },
  connectors: { path: "/connectors", label: "Connectors" },
  company: { path: "/company", label: "Company" },
  website_audit: { path: "/website-audits", label: "Website Audit" },
  website_content: { path: "/website-content", label: "Website Content" },
  employees: { path: "/employees", label: "Employees" },
  calendar: { path: "/calendar", label: "Calendar" },
  services: { path: "/services", label: "Services" },
  quotes: { path: "/quotes", label: "Quotes" },
  invoices: { path: "/invoices", label: "Invoices" },
  recruitment: { path: "/recruitment", label: "Recruitment" },
  playbooks: { path: "/playbooks", label: "Playbooks" },
  learning: { path: "/learning", label: "Learning" },
  memory_model: { path: "/memory-model", label: "Memory Model" },
} as const;

export type VoicePage = keyof typeof VOICE_PAGE_ROUTES;

const LOCALIZED_PAGE_LABELS: Partial<Record<VoiceLanguage, Partial<Record<VoicePage, string>>>> = {
  "pl-PL": {
    dashboard: "Panel główny", setup: "Pierwsza konfiguracja", forgot_password: "Odzyskiwanie hasła", reset_password: "Ustaw nowe hasło",
    account: "Konto", emma_permissions: "Uprawnienia Emmy", notifications: "Powiadomienia", data_quality: "Jakość danych", metrics: "Wskaźniki firmy",
    leads: "Potencjalni klienci", clients: "Klienci", contacts: "Kontakty", documents: "Dokumenty", jobs: "Zlecenia", tasks: "Zadania",
    enquiries: "Zapytania", communication_intake: "Przychodząca komunikacja", communications: "Komunikacja", photos: "Zdjęcia",
    photo_selection: "Wybór zdjęć", business_context: "Kontekst firmy", industries: "Branże", connectors: "Integracje", company: "Firma",
    website_audit: "Audyt strony", website_content: "Treść strony", employees: "Pracownicy", calendar: "Kalendarz", services: "Usługi",
    quotes: "Oferty", invoices: "Faktury", recruitment: "Rekrutacja", playbooks: "Procedury", learning: "Uczenie", memory_model: "Pamięć Emmy",
  },
  "cs-CZ": {
    dashboard: "Přehled", setup: "První nastavení", forgot_password: "Obnovení hesla", reset_password: "Nastavit nové heslo",
    account: "Účet", emma_permissions: "Oprávnění Emmy", notifications: "Oznámení", data_quality: "Kvalita dat", metrics: "Firemní metriky", leads: "Poptávky",
    clients: "Klienti", contacts: "Kontakty", documents: "Dokumenty", jobs: "Zakázky", tasks: "Úkoly", enquiries: "Dotazy",
    communication_intake: "Příjem komunikace", communications: "Komunikace", photos: "Fotografie", photo_selection: "Výběr fotografií",
    business_context: "Kontext firmy", industries: "Obory", connectors: "Konektory", company: "Firma", website_audit: "Audit webu",
    website_content: "Obsah webu", employees: "Uživatelé a přístupy", calendar: "Kalendář", services: "Služby", quotes: "Nabídky",
    invoices: "Faktury", recruitment: "Nábor", playbooks: "Postupy", learning: "Učení", memory_model: "Paměť Emmy",
  },
  "fr-FR": {
    dashboard: "Tableau de bord", setup: "Configuration initiale", forgot_password: "Récupération du mot de passe", reset_password: "Définir un nouveau mot de passe",
    account: "Compte", emma_permissions: "Autorisations d’Emma", notifications: "Notifications", data_quality: "Qualité des données", metrics: "Indicateurs de l’entreprise",
    leads: "Prospects", clients: "Clients", contacts: "Contacts", documents: "Documents", jobs: "Interventions", tasks: "Tâches",
    enquiries: "Demandes", communication_intake: "Réception des communications", communications: "Communications", photos: "Photos",
    photo_selection: "Sélection de photos", business_context: "Contexte de l’entreprise", industries: "Secteurs", connectors: "Connecteurs", company: "Entreprise",
    website_audit: "Audit du site", website_content: "Contenu du site", employees: "Employés", calendar: "Calendrier", services: "Services",
    quotes: "Devis", invoices: "Factures", recruitment: "Recrutement", playbooks: "Procédures", learning: "Apprentissage", memory_model: "Mémoire d’Emma",
  },
  "de-DE": {
    dashboard: "Übersicht", setup: "Ersteinrichtung", forgot_password: "Passwortwiederherstellung", reset_password: "Neues Passwort festlegen",
    account: "Konto", emma_permissions: "Emma-Berechtigungen", notifications: "Benachrichtigungen", data_quality: "Datenqualität", metrics: "Unternehmenskennzahlen",
    leads: "Interessenten", clients: "Kunden", contacts: "Kontakte", documents: "Dokumente", jobs: "Aufträge", tasks: "Aufgaben",
    enquiries: "Anfragen", communication_intake: "Kommunikationseingang", communications: "Kommunikation", photos: "Fotos",
    photo_selection: "Fotoauswahl", business_context: "Unternehmenskontext", industries: "Branchen", connectors: "Konnektoren", company: "Unternehmen",
    website_audit: "Website-Audit", website_content: "Website-Inhalte", employees: "Mitarbeiter", calendar: "Kalender", services: "Leistungen",
    quotes: "Angebote", invoices: "Rechnungen", recruitment: "Personalbeschaffung", playbooks: "Abläufe", learning: "Lernen", memory_model: "Emma-Speicher",
  },
  "es-ES": {
    dashboard: "Panel", setup: "Configuración inicial", forgot_password: "Recuperación de contraseña", reset_password: "Establecer nueva contraseña",
    account: "Cuenta", emma_permissions: "Permisos de Emma", notifications: "Notificaciones", data_quality: "Calidad de datos", metrics: "Métricas empresariales",
    leads: "Clientes potenciales", clients: "Clientes", contacts: "Contactos", documents: "Documentos", jobs: "Trabajos", tasks: "Tareas",
    enquiries: "Consultas", communication_intake: "Entrada de comunicaciones", communications: "Comunicaciones", photos: "Fotos",
    photo_selection: "Selección de fotos", business_context: "Contexto empresarial", industries: "Sectores", connectors: "Conectores", company: "Empresa",
    website_audit: "Auditoría web", website_content: "Contenido web", employees: "Empleados", calendar: "Calendario", services: "Servicios",
    quotes: "Presupuestos", invoices: "Facturas", recruitment: "Selección de personal", playbooks: "Procedimientos", learning: "Aprendizaje", memory_model: "Memoria de Emma",
  },
  "it-IT": {
    dashboard: "Panoramica", setup: "Configurazione iniziale", forgot_password: "Recupero password", reset_password: "Imposta nuova password",
    account: "Account", emma_permissions: "Autorizzazioni di Emma", notifications: "Notifiche", data_quality: "Qualità dei dati", metrics: "Metriche aziendali",
    leads: "Potenziali clienti", clients: "Clienti", contacts: "Contatti", documents: "Documenti", jobs: "Lavori", tasks: "Attività",
    enquiries: "Richieste", communication_intake: "Ricezione comunicazioni", communications: "Comunicazioni", photos: "Foto",
    photo_selection: "Selezione foto", business_context: "Contesto aziendale", industries: "Settori", connectors: "Connettori", company: "Azienda",
    website_audit: "Audit del sito", website_content: "Contenuto del sito", employees: "Dipendenti", calendar: "Calendario", services: "Servizi",
    quotes: "Preventivi", invoices: "Fatture", recruitment: "Selezione del personale", playbooks: "Procedure", learning: "Apprendimento", memory_model: "Memoria di Emma",
  },
};

export function voicePageLabel(page: VoicePage, language?: string) {
  const resolved = language && isVoiceLanguage(language) ? language : "en-GB";
  return LOCALIZED_PAGE_LABELS[resolved]?.[page] ?? VOICE_PAGE_ROUTES[page].label;
}

export function openingVoicePageMessage(page: VoicePage, language?: string) {
  const label = voicePageLabel(page, language);
  if (language === "pl-PL") return `Otwieram: ${label}.`;
  if (language === "cs-CZ") return `Otevírám: ${label}.`;
  if (language === "fr-FR") return `J’ouvre : ${label}.`;
  if (language === "de-DE") return `Ich öffne: ${label}.`;
  if (language === "es-ES") return `Abriendo: ${label}.`;
  if (language === "it-IT") return `Apro: ${label}.`;
  return `Opening ${label}.`;
}

const PAGE_ALIASES: Record<string, VoicePage> = {
  home: "dashboard",
  "home page": "dashboard",
  dashboard: "dashboard",
  setup: "setup",
  "first-time setup": "setup",
  "company setup": "setup",
  "forgot password": "forgot_password",
  "password recovery": "forgot_password",
  "reset password": "forgot_password",
  account: "account",
  "my account": "account",
  notifications: "notifications",
  notification: "notifications",
  "data quality": "data_quality",
  "data quality issues": "data_quality",
  metrics: "metrics",
  "business metrics": "metrics",
  leads: "leads",
  lead: "leads",
  clients: "clients",
  client: "clients",
  contacts: "contacts",
  contact: "contacts",
  documents: "documents",
  document: "documents",
  jobs: "jobs",
  job: "jobs",
  tasks: "tasks",
  task: "tasks",
  enquiries: "enquiries",
  enquiry: "enquiries",
  inquiries: "enquiries",
  inquiry: "enquiries",
  "communication intake": "communication_intake",
  "message intake": "communication_intake",
  communications: "communications",
  communication: "communications",
  photos: "photos",
  photo: "photos",
  portfolio: "photos",
  "photo selection": "photo_selection",
  "business context": "business_context",
  industries: "industries",
  industry: "industries",
  connectors: "connectors",
  integrations: "connectors",
  company: "company",
  "company settings": "company",
  organisation: "company",
  organization: "company",
  "website audit": "website_audit",
  "website audits": "website_audit",
  "website content": "website_content",
  employees: "employees",
  employee: "employees",
  team: "employees",
  calendar: "calendar",
  schedule: "calendar",
  services: "services",
  service: "services",
  "service catalogue": "services",
  quotes: "quotes",
  quote: "quotes",
  invoices: "invoices",
  invoice: "invoices",
  recruitment: "recruitment",
  hiring: "recruitment",
  playbooks: "playbooks",
  playbook: "playbooks",
  learning: "learning",
  "learning rules": "learning",
  "memory model": "memory_model",
  patterns: "memory_model",
  // Czech menu labels and common spoken variants.
  prehled: "dashboard", ucet: "account", oznameni: "notifications", "kvalita dat": "data_quality", "firemni metriky": "metrics",
  poptavky: "leads", klienti: "clients", kontakty: "contacts", dokumenty: "documents", zakazky: "jobs", ukoly: "tasks",
  dotazy: "enquiries", "prijem komunikace": "communication_intake", komunikace: "communications", fotografie: "photos",
  "vyber fotografii": "photo_selection", "kontext firmy": "business_context", obory: "industries", konektory: "connectors",
  firma: "company", "audit webu": "website_audit", "obsah webu": "website_content", uzivatele: "employees", kalendar: "calendar",
  sluzby: "services", "katalog sluzeb": "services", nabidky: "quotes", faktury: "invoices", nabor: "recruitment", postupy: "playbooks",
  uceni: "learning", "pamet emmy": "memory_model",
  // Polish menu labels and common spoken variants.
  "panel glowny": "dashboard", przeglad: "dashboard", konto: "account", powiadomienia: "notifications", "jakosc danych": "data_quality",
  "wskazniki firmy": "metrics", "potencjalni klienci": "leads", klienci: "clients", zlecenia: "jobs", zadania: "tasks",
  zapytania: "enquiries", "przychodzaca komunikacja": "communication_intake", zdjecia: "photos", "wybor zdjec": "photo_selection",
  "kontekst firmy": "business_context", branze: "industries", integracje: "connectors", "audyt strony": "website_audit",
  "tresc strony": "website_content", pracownicy: "employees", kalendarz: "calendar", uslugi: "services", "katalog uslug": "services",
  oferty: "quotes", wyceny: "quotes", rekrutacja: "recruitment", procedury: "playbooks", "pamiec emmy": "memory_model",
};

function normalizePageName(rawPage: string) {
  return rawPage
    .trim()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[.!?]+$/g, "")
    .replace(/[-_]+/g, " ")
    .replace(/^(?:the|my)\s+/, "")
    .replace(/\s+page$/, "")
    .replace(/\s+/g, " ");
}

// Every label rendered by the localized Secretary menu is also a valid Emma
// navigation phrase. This keeps visual navigation and speech navigation tied
// to the same page IDs instead of maintaining two drifting vocabularies.
for (const labels of Object.values(LOCALIZED_PAGE_LABELS)) {
  for (const [page, label] of Object.entries(labels ?? {})) {
    if (label) PAGE_ALIASES[normalizePageName(label)] = page as VoicePage;
  }
}

export type CommandUiAction =
  | { kind: "navigate"; path: string; label: string }
  | { kind: "set_language"; language: VoiceLanguage; label: string };

export type VoiceUiAction = CommandUiAction & {
  id: string;
  intent: string;
  createdAt: string;
};

export function resolveVoicePage(rawPage: string): VoicePage | undefined {
  return PAGE_ALIASES[normalizePageName(rawPage)];
}

function record(value: unknown): Record<string, any> {
  return value && typeof value === "object" ? (value as Record<string, any>) : {};
}

export function buildCommandUiAction(intent: string, data: unknown, interpreted: unknown, language?: string): CommandUiAction | undefined {
  const payload = record(data);
  const entities = record(interpreted);
  const directId = typeof payload.id === "string" ? payload.id : undefined;
  const nestedJobId = typeof payload.job?.id === "string" ? payload.job.id : undefined;
  const nestedClientId = typeof payload.client?.id === "string" ? payload.client.id : undefined;
  const navigate = (page: VoicePage, path: string = VOICE_PAGE_ROUTES[page].path): CommandUiAction => ({
    kind: "navigate",
    path,
    label: voicePageLabel(page, language),
  });

  switch (intent) {
    case "navigate": {
      const page = entities.page as VoicePage;
      return navigate(page);
    }
    case "create_client": return navigate("clients", directId ? `/clients/${directId}` : "/clients");
    case "create_lead": return navigate("leads", directId ? `/leads/${directId}` : "/leads");
    case "create_job":
    case "change_job_status": return navigate("jobs", directId ? `/jobs/${directId}` : "/jobs");
    case "assign_job": return navigate("jobs", nestedJobId ? `/jobs/${nestedJobId}` : "/jobs");
    case "convert_lead": return navigate("clients", nestedClientId ? `/clients/${nestedClientId}` : "/clients");
    case "detect_overload": return navigate("employees");
    case "create_task":
    case "list_tasks": return navigate("tasks");
    case "create_service": return navigate("services");
    case "list_quotes": return navigate("quotes");
    case "list_job_openings": return navigate("recruitment");
    case "create_learning_rule":
    case "list_learning_rules": return navigate("learning");
    case "log_communication":
    case "list_communications":
    case "list_follow_ups": return navigate("communications");
    case "log_portfolio_photo":
    case "list_portfolio_photos": return navigate("photos");
    case "list_unresolved_enquiries": return navigate("enquiries", "/enquiries?resolution=unresolved");
    case "list_notifications":
    case "prepare_delete_notifications":
    case "confirm_delete_notifications":
    case "cancel_delete_notifications": return navigate("notifications");
    case "list_data_quality": return navigate("data_quality");
    case "detect_action_patterns": return navigate("memory_model");
    case "list_clients": return navigate("clients");
    case "list_contacts": return navigate("contacts");
    case "list_channel_messages": {
      const channel = entities.channel === "whatsapp" ? "whatsapp" : "email";
      return navigate("enquiries", `/enquiries?resolution=all&channel=${channel}`);
    }
    case "connector_status": return navigate("connectors");
    case "setup_connectors": {
      const target = typeof entities.connector_key === "string" ? entities.connector_key : "all";
      return navigate("connectors", `/connectors?setup=${encodeURIComponent(target)}`);
    }
    case "sync_connectors": return navigate("connectors");
    case "list_jobs": return navigate("jobs");
    case "list_leads": return navigate("leads");
    case "set_voice_language": {
      const language = typeof payload.voiceLanguage === "string" && isVoiceLanguage(payload.voiceLanguage)
        ? payload.voiceLanguage
        : typeof entities.language === "string" && isVoiceLanguage(entities.language)
          ? entities.language
          : undefined;
      return language ? { kind: "set_language", language, label: VOICE_LANGUAGE_LABELS[language] } : undefined;
    }
    default: return undefined;
  }
}
