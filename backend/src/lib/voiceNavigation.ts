export const VOICE_PAGE_ROUTES = {
  dashboard: { path: "/", label: "Dashboard" },
  account: { path: "/account", label: "Account" },
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

const PAGE_ALIASES: Record<string, VoicePage> = {
  home: "dashboard",
  "home page": "dashboard",
  dashboard: "dashboard",
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
};

export type CommandUiAction =
  | { kind: "navigate"; path: string; label: string }
  | { kind: "set_language"; language: VoiceLanguage; label: string };

export type VoiceUiAction = CommandUiAction & {
  id: string;
  intent: string;
  createdAt: string;
};

export function resolveVoicePage(rawPage: string): VoicePage | undefined {
  const normalized = rawPage
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/g, "")
    .replace(/[-_]+/g, " ")
    .replace(/^(?:the|my)\s+/, "")
    .replace(/\s+page$/, "")
    .replace(/\s+/g, " ");
  return PAGE_ALIASES[normalized];
}

function record(value: unknown): Record<string, any> {
  return value && typeof value === "object" ? (value as Record<string, any>) : {};
}

export function buildCommandUiAction(intent: string, data: unknown, interpreted: unknown): CommandUiAction | undefined {
  const payload = record(data);
  const entities = record(interpreted);
  const directId = typeof payload.id === "string" ? payload.id : undefined;
  const nestedJobId = typeof payload.job?.id === "string" ? payload.job.id : undefined;
  const nestedClientId = typeof payload.client?.id === "string" ? payload.client.id : undefined;

  switch (intent) {
    case "navigate": {
      const page = entities.page as VoicePage;
      return { kind: "navigate", ...VOICE_PAGE_ROUTES[page] };
    }
    case "create_client": return { kind: "navigate", path: directId ? `/clients/${directId}` : "/clients", label: "Client" };
    case "create_lead": return { kind: "navigate", path: directId ? `/leads/${directId}` : "/leads", label: "Lead" };
    case "create_job":
    case "change_job_status": return { kind: "navigate", path: directId ? `/jobs/${directId}` : "/jobs", label: "Job" };
    case "assign_job": return { kind: "navigate", path: nestedJobId ? `/jobs/${nestedJobId}` : "/jobs", label: "Job" };
    case "convert_lead": return { kind: "navigate", path: nestedClientId ? `/clients/${nestedClientId}` : "/clients", label: "Client" };
    case "detect_overload": return { kind: "navigate", path: "/employees", label: "Employees" };
    case "create_task":
    case "list_tasks": return { kind: "navigate", path: "/tasks", label: "Tasks" };
    case "create_service": return { kind: "navigate", path: "/services", label: "Services" };
    case "list_quotes": return { kind: "navigate", path: "/quotes", label: "Quotes" };
    case "list_job_openings": return { kind: "navigate", path: "/recruitment", label: "Recruitment" };
    case "create_learning_rule":
    case "list_learning_rules": return { kind: "navigate", path: "/learning", label: "Learning" };
    case "log_communication":
    case "list_communications":
    case "list_follow_ups": return { kind: "navigate", path: "/communications", label: "Communications" };
    case "log_portfolio_photo":
    case "list_portfolio_photos": return { kind: "navigate", path: "/portfolio", label: "Photos" };
    case "list_unresolved_enquiries": return { kind: "navigate", path: "/enquiries?resolution=unresolved", label: "Unresolved Enquiries" };
    case "list_notifications": return { kind: "navigate", path: "/notifications", label: "Notifications" };
    case "list_data_quality": return { kind: "navigate", path: "/data-quality", label: "Data Quality" };
    case "detect_action_patterns": return { kind: "navigate", path: "/memory-model", label: "Memory Model" };
    case "list_clients": return { kind: "navigate", path: "/clients", label: "Clients" };
    case "list_contacts": return { kind: "navigate", path: "/contacts", label: "Contacts" };
    case "list_channel_messages": {
      const channel = entities.channel === "whatsapp" ? "whatsapp" : "email";
      const label = channel === "whatsapp" ? "WhatsApp Messages" : "Email Messages";
      return { kind: "navigate", path: `/enquiries?resolution=all&channel=${channel}`, label };
    }
    case "connector_status": return { kind: "navigate", path: "/connectors", label: "Connector Status" };
    case "setup_connectors": {
      const target = typeof entities.connector_key === "string" ? entities.connector_key : "all";
      return { kind: "navigate", path: `/connectors?setup=${encodeURIComponent(target)}`, label: "Guided Connector Setup" };
    }
    case "sync_connectors": return { kind: "navigate", path: "/connectors", label: "Connectors" };
    case "list_jobs": return { kind: "navigate", path: "/jobs", label: "Jobs" };
    case "list_leads": return { kind: "navigate", path: "/leads", label: "Leads" };
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
import { isVoiceLanguage, VOICE_LANGUAGE_LABELS, type VoiceLanguage } from "./voiceLanguages.js";
