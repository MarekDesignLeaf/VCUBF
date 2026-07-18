import { VOICE_PAGE_ROUTES, voicePageLabel, type VoicePage } from "./voiceNavigation.js";
import { NAVIGATION_TRANSLATIONS } from "./navigationTranslations.js";

// This is the backend-certified map of every signed-in Secretary screen. It
// deliberately includes page subtrees that do not have their own sidebar row
// (for example a client detail or a quote editor), so Emma can explain the
// complete application rather than only the flat sidebar.
type PermissionRule = {
  all?: readonly string[];
  any?: readonly string[];
};

type NavigationChild = {
  label: string;
  path?: string;
  description: string;
  controls: readonly string[];
};

type NavigationItem = {
  page: VoicePage;
  description: string;
  controls: readonly string[];
  children?: readonly NavigationChild[];
  access?: PermissionRule;
};

type NavigationSection = {
  id: NavigationSectionId;
  label: string;
  description: string;
  aliases: readonly string[];
  items: readonly NavigationItem[];
};

export type NavigationSectionId =
  | "start_and_control"
  | "attention_and_insight"
  | "customers_and_work"
  | "communication"
  | "evidence_and_growth"
  | "sales_and_finance"
  | "people_process_and_learning";

export type NavigationItemView = {
  id: VoicePage;
  label: string;
  path: string;
  description: string;
  controls: string[];
  available: boolean;
  accessNote?: string;
  children: Array<{
    label: string;
    path?: string;
    description: string;
    controls: string[];
  }>;
};

export type NavigationSectionView = {
  id: NavigationSectionId;
  label: string;
  description: string;
  items: NavigationItemView[];
};

export type NavigationCatalogueView = {
  title: string;
  sections: NavigationSectionView[];
  readout: string;
};

function item(
  page: VoicePage,
  description: string,
  controls: readonly string[] = [],
  options: Pick<NavigationItem, "children" | "access"> = {}
): NavigationItem {
  return { page, description, controls, ...options };
}

function child(label: string, path: string | undefined, description: string, controls: readonly string[] = []): NavigationChild {
  return { label, path, description, controls };
}

export const SECRETARY_NAVIGATION_CATALOGUE: readonly NavigationSection[] = [
  {
    id: "start_and_control",
    label: "Start and control",
    description: "Personal settings, the operational overview and evidence that needs attention.",
    aliases: ["start", "control", "overview", "account", "začátek", "ovládání", "přehled", "účet"],
    items: [
      item("dashboard", "The operational overview and normal starting point."),
      item("setup", "First-time setup creates the owning company and its primary administrator together. It is available only before the workspace has been configured.", ["Create company and administrator"]),
      item(
        "forgot_password",
        "Public account recovery. Enter the account email to request a single-use recovery link. The response never reveals whether an account exists.",
        ["Send reset link"],
        { children: [
          child("Set new password", "/reset-password", "Opens only from a one-time recovery link. Set a new strong password; the link expires after 30 minutes and cannot be reused.", ["Save new password"]),
        ] }
      ),
      item(
        "account",
        "Personal account, password, wake word, recognition language, continuous listening and Windows pairing.",
        ["Change password", "Save voice preferences"],
        { children: [
          child("Voice control", undefined, "Changes Emma's wake word, spoken language, Secretary menu language and continuous-listening preference.", ["Save voice preferences"]),
          child("Windows pairing", undefined, "Approves the current Windows companion after browser sign-in."),
        ] }
      ),
      item("emma_permissions", "Company-wide administrator controls for every read, write, external and connector capability Emma may execute.", ["Enable", "Disable", "Save Emma permissions"], { access: { all: ["company.manage"] } }),
    ],
  },
  {
    id: "attention_and_insight",
    label: "Attention and insight",
    description: "Operational attention, evidence quality and company-level measurements.",
    aliases: ["attention", "insight", "alerts", "notifications", "data", "metrics", "upozornění", "kvalita dat", "metriky"],
    items: [
      item("notifications", "Attention feed for overdue follow-ups, capacity and quote facts; deleting hides an item without altering its source record and deleted items can be restored.", ["Delete", "Delete all", "Restore"]),
      item("data_quality", "Evidence of possible duplicate clients and missing contact methods. A client merge always shows a preview and needs explicit confirmation.", ["Merge", "Confirm"]),
      item("metrics", "Operational business measurements calculated from stored company records."),
    ],
  },
  {
    id: "customers_and_work",
    label: "Customers and work",
    description: "Prospects, customers, contacts, documents, jobs, tasks, people and the working calendar.",
    aliases: ["customers", "customer", "work", "crm", "clients", "jobs", "zákazníci", "klienti", "práce", "zakázky"],
    items: [
      item(
        "leads",
        "Prospective work before it becomes a real client or job workflow.",
        ["New lead"],
        { children: [child("Lead details", "/leads/:id", "Review the prospect and explicitly convert it only after the conversion preview.", ["Convert lead"])] }
      ),
      item(
        "clients",
        "Customer master records and the hub for their work, communications and commercial records.",
        ["New client"],
        { children: [child("Client details", "/clients/:id", "Shows linked jobs, communications, quotes and photo evidence.", ["Jobs", "New quote", "New job", "Log communication", "Log photo"])] }
      ),
      item("contacts", "People and contact details linked to company records. At least an email address or phone number is required.", ["Add contact", "Save contact", "Archive"]),
      item("documents", "Internal document records and links. Registering a document does not send it externally.", ["Register document", "Archive"]),
      item(
        "jobs",
        "Work records linked to clients, assigned employees, status, resources, photos and commercial context.",
        [],
        { children: [child("Job details", "/jobs/:id", "Manages assignment, status, materials/resources, linked quotes, communications and photos.", ["Materials and resources", "Add", "New quote", "Log communication", "Log photo"])] }
      ),
      item("tasks", "Actionable work linked to clients, jobs, communications and employees, with due dates and completion.", ["New task", "Start", "Complete"]),
      item(
        "company",
        "The owning company is the root of Secretary: company first, then its primary administrator, then user accounts. Company changes require company-management permission.",
        ["Save company profile"],
        { access: { all: ["company.manage"] }, children: [child("Company profile", "/company", "Shows the primary administrator and links to user access management.", ["Save company profile", "Users & access"])] }
      ),
      item(
        "employees",
        "User accounts, access profiles, optional permissions, skills and capacity. Secretary keeps at least one active administrator. Material access changes always require review.",
        ["New user", "Manage"],
        { children: [
          child("New user", "/employees/new", "Creates a proposed user account from an access profile; optional permissions stay visible and reviewable before confirmation.", ["Review changes", "Confirm changes"]),
          child("User access management", "/employees/:id/edit", "Edits access profiles, optional permissions, skills, capacity and access under the reviewed workflow.", ["Review changes", "Confirm changes", "Review reset", "Confirm reset"]),
        ] }
      ),
      item("calendar", "Scheduled work and capacity. Check overload before promising a date."),
    ],
  },
  {
    id: "communication",
    label: "Communication",
    description: "Inbound enquiries, reviewable intake and the permanent CRM communication log.",
    aliases: ["communication", "communications", "messages", "enquiries", "komunikace", "zprávy", "dotazy"],
    items: [
      item("enquiries", "Unresolved customer enquiries and their resolution state.", ["Add inbound message"]),
      item("communication_intake", "Preserves an inbound source message, extracts reviewable data, matches or creates a client and prepares a reply draft.", ["Preserve message", "Preview", "Confirm CRM conversion"]),
      item("communications", "Permanent CRM communication log with channel, direction, summary and follow-up.", ["Log communication"]),
    ],
  },
  {
    id: "evidence_and_growth",
    label: "Evidence, context and growth",
    description: "Photo evidence, verified company context, integrations and evidence-backed website work.",
    aliases: ["evidence", "growth", "photos", "website", "connectors", "důkazy", "fotografie", "web", "konektory"],
    items: [
      item("photos", "Internal photo references with provenance, quality, sensitivity and usage-permission review. Nothing is automatically published.", ["Log photo", "Human review"]),
      item("photo_selection", "Confirms evidence-backed internal photo selections for a service; selection does not publish photos.", ["Save selection", "Confirm internal selection"]),
      item("business_context", "Verified company facts, operating rules, regions, tone and constraints used by later planning and content.", ["Add context", "Archive"]),
      item("industries", "Verified company industry taxonomy linked to actual services.", ["Add industry", "Link service", "Archive link", "Archive industry"]),
      item(
        "connectors",
        "Gmail, Google Contacts, Calendar, Drive, Google Photos and WhatsApp Business integrations. Setup and final external sends remain confirmation-gated.",
        ["Register data source", "Authorize", "Enable", "Initial sync", "Sync changes", "Review and send email", "Review and send WhatsApp", "Disconnect"],
        { access: { all: ["connectors.read"] } }
      ),
      item("website_audit", "Records user-supplied website observations compared with real Secretary records; it does not crawl or alter a website.", ["New audit", "View findings"]),
      item("website_content", "Prepares evidence-backed website-content proposals. Approval does not publish anything.", ["New proposal", "View proposal", "Review decision"]),
    ],
  },
  {
    id: "sales_and_finance",
    label: "Services, sales and finance",
    description: "Service catalogue, commercial drafts and issued invoices or payment records.",
    aliases: ["sales", "finance", "commercial", "services", "quotes", "invoices", "obchod", "finance", "služby", "nabídky", "faktury"],
    items: [
      item("services", "Company service catalogue and confirmed reference activities. Reference prices never become company prices automatically.", ["New service", "Reference activities", "Search", "Activate"]),
      item(
        "quotes",
        "Itemised commercial drafts linked to clients. Review before issue or external delivery.",
        ["New quote"],
        { children: [
          child("New quote", "/quotes/new", "Starts a new itemised quote linked to a client or job.", ["Save"]),
          child("Quote details", "/quotes/:id", "Maintains line items, reviewed status and PDF download. Downloading does not send the quote.", ["Line items", "Save", "Download PDF"]),
        ] }
      ),
      item("invoices", "Creates drafts, issues invoices, records real payments and downloads PDF. Only recording payment is confirmation-gated; issuing or downloading does not send an email.", ["Create draft", "Issue", "Record payment", "PDF"]),
    ],
  },
  {
    id: "people_process_and_learning",
    label: "People, process and Emma learning",
    description: "Recruitment, repeatable workflows, visible phrase learning and explicit long-term memory.",
    aliases: ["people", "process", "learning", "memory", "team", "recruitment", "lidé", "procesy", "učení", "paměť", "nábor"],
    items: [
      item(
        "recruitment",
        "Job openings, candidates and evidence-based recommendations. It cannot hire, promise pay or confirm terms automatically.",
        ["New job opening"],
        { access: { all: ["recruitment.manage"] }, children: [child("Job opening details", "/recruitment/:id", "Maintains one opening, draft adverts, candidates and recommendations.", ["Draft advert", "Add candidate"])] }
      ),
      item(
        "playbooks",
        "Reviewed repeatable command sequences with placeholders. Every run needs preview and confirmation.",
        ["New playbook"],
        { children: [child("Playbook details", "/playbooks/:id", "Fills placeholders, previews a run and shows its history.", ["Preview run", "Confirm run", "Run history"])] }
      ),
      item("learning", "Visible, editable phrase aliases that map to deterministic commands; they never create hidden business policy.", ["Teach a rule", "Archive", "Reactivate"]),
      item("memory_model", "Visible personal and company persistent notes plus an admin/audit view of repeated action patterns. Audio is never retained and normal conversation is not silently promoted to memory.", ["For me", "For the company", "Remember", "Archive"], { access: { any: ["voice.execute", "audit.read"] } }),
    ],
  },
] as const;

const SECTION_COPY: Record<string, Partial<Record<NavigationSectionId, { label: string; description: string }>>> = {
  "pl-PL": {
    start_and_control: { label: "Start i sterowanie", description: "Ustawienia osobiste, przegląd operacyjny i sprawy wymagające uwagi." },
    attention_and_insight: { label: "Uwagi i analizy", description: "Powiadomienia operacyjne, jakość danych i wskaźniki firmy." },
    customers_and_work: { label: "Klienci i praca", description: "Potencjalni klienci, klienci, kontakty, dokumenty, zlecenia, zadania, pracownicy i kalendarz." },
    communication: { label: "Komunikacja", description: "Przychodzące wiadomości, historia komunikacji, zapytania i integracje kanałów." },
    evidence_and_growth: { label: "Materiały i rozwój", description: "Zdjęcia, kontekst firmy, branże i zawartość strony internetowej." },
    sales_and_finance: { label: "Sprzedaż i finanse", description: "Katalog usług, oferty i faktury." },
    people_process_and_learning: { label: "Ludzie, procesy i nauka", description: "Rekrutacja, procedury, uczenie i trwała pamięć Emmy." },
  },
  "cs-CZ": {
    start_and_control: { label: "Začátek a ovládání", description: "Osobní nastavení, provozní přehled a záležitosti vyžadující pozornost." },
    attention_and_insight: { label: "Pozornost a přehled", description: "Provozní upozornění, kvalita dat a firemní metriky." },
    customers_and_work: { label: "Klienti a práce", description: "Poptávky, klienti, kontakty, dokumenty, zakázky, úkoly, pracovníci a kalendář." },
    communication: { label: "Komunikace", description: "Příchozí zprávy, historie komunikace, dotazy a propojené kanály." },
    evidence_and_growth: { label: "Podklady a růst", description: "Fotografie, kontext firmy, obory a obsah webu." },
    sales_and_finance: { label: "Obchod a finance", description: "Katalog služeb, nabídky a faktury." },
    people_process_and_learning: { label: "Lidé, procesy a učení", description: "Nábor, postupy, učení a trvalá paměť Emmy." },
  },
  "fr-FR": {
    start_and_control: { label: "Démarrage et contrôle", description: "Paramètres personnels, vue opérationnelle et éléments nécessitant une attention." },
    attention_and_insight: { label: "Attention et analyse", description: "Notifications opérationnelles, qualité des données et indicateurs de l’entreprise." },
    customers_and_work: { label: "Clients et travail", description: "Prospects, clients, contacts, documents, interventions, tâches, employés et calendrier." },
    communication: { label: "Communication", description: "Messages entrants, historique des communications, demandes et canaux connectés." },
    evidence_and_growth: { label: "Preuves et croissance", description: "Photos, contexte de l’entreprise, secteurs et contenu du site." },
    sales_and_finance: { label: "Ventes et finances", description: "Catalogue de services, devis et factures." },
    people_process_and_learning: { label: "Personnel, processus et apprentissage", description: "Recrutement, procédures, apprentissage et mémoire permanente d’Emma." },
  },
  "de-DE": {
    start_and_control: { label: "Start und Steuerung", description: "Persönliche Einstellungen, Betriebsübersicht und Punkte, die Aufmerksamkeit erfordern." },
    attention_and_insight: { label: "Aufmerksamkeit und Einblicke", description: "Betriebliche Hinweise, Datenqualität und Unternehmenskennzahlen." },
    customers_and_work: { label: "Kunden und Arbeit", description: "Interessenten, Kunden, Kontakte, Dokumente, Aufträge, Aufgaben, Mitarbeiter und Kalender." },
    communication: { label: "Kommunikation", description: "Eingehende Nachrichten, Kommunikationsverlauf, Anfragen und verbundene Kanäle." },
    evidence_and_growth: { label: "Nachweise und Wachstum", description: "Fotos, Unternehmenskontext, Branchen und Website-Inhalte." },
    sales_and_finance: { label: "Vertrieb und Finanzen", description: "Leistungskatalog, Angebote und Rechnungen." },
    people_process_and_learning: { label: "Personal, Prozesse und Lernen", description: "Personalbeschaffung, Abläufe, Lernen und Emmas dauerhaftes Gedächtnis." },
  },
  "es-ES": {
    start_and_control: { label: "Inicio y control", description: "Ajustes personales, visión operativa y elementos que requieren atención." },
    attention_and_insight: { label: "Atención y análisis", description: "Avisos operativos, calidad de datos y métricas empresariales." },
    customers_and_work: { label: "Clientes y trabajo", description: "Clientes potenciales, clientes, contactos, documentos, trabajos, tareas, empleados y calendario." },
    communication: { label: "Comunicación", description: "Mensajes entrantes, historial de comunicaciones, consultas y canales conectados." },
    evidence_and_growth: { label: "Evidencia y crecimiento", description: "Fotos, contexto empresarial, sectores y contenido web." },
    sales_and_finance: { label: "Ventas y finanzas", description: "Catálogo de servicios, presupuestos y facturas." },
    people_process_and_learning: { label: "Personas, procesos y aprendizaje", description: "Selección de personal, procedimientos, aprendizaje y memoria permanente de Emma." },
  },
  "it-IT": {
    start_and_control: { label: "Avvio e controllo", description: "Impostazioni personali, panoramica operativa ed elementi che richiedono attenzione." },
    attention_and_insight: { label: "Attenzione e analisi", description: "Avvisi operativi, qualità dei dati e metriche aziendali." },
    customers_and_work: { label: "Clienti e lavoro", description: "Potenziali clienti, clienti, contatti, documenti, lavori, attività, dipendenti e calendario." },
    communication: { label: "Comunicazione", description: "Messaggi in arrivo, cronologia delle comunicazioni, richieste e canali collegati." },
    evidence_and_growth: { label: "Materiali e crescita", description: "Foto, contesto aziendale, settori e contenuto del sito." },
    sales_and_finance: { label: "Vendite e finanze", description: "Catalogo dei servizi, preventivi e fatture." },
    people_process_and_learning: { label: "Persone, processi e apprendimento", description: "Selezione del personale, procedure, apprendimento e memoria permanente di Emma." },
  },
};

function localizedSection(section: NavigationSection, language?: string) {
  return SECTION_COPY[language ?? ""]?.[section.id] ?? { label: section.label, description: section.description };
}

function localizedText(text: string, language?: string) {
  return NAVIGATION_TRANSLATIONS[language ?? ""]?.[text] ?? text;
}

const READOUT_COPY: Readonly<Record<string, { controls: string; subtree: string; permission: string }>> = {
  "cs-CZ": { controls: "Ovládací prvky", subtree: "Podstrom", permission: "Tato položka vyžaduje další oprávnění." },
  "pl-PL": { controls: "Elementy sterujące", subtree: "Poddrzewo", permission: "Ta pozycja wymaga dodatkowego uprawnienia." },
  "fr-FR": { controls: "Contrôles", subtree: "Sous-arborescence", permission: "Cet élément exige une autorisation supplémentaire." },
  "de-DE": { controls: "Steuerelemente", subtree: "Unterstruktur", permission: "Dieses Element erfordert eine zusätzliche Berechtigung." },
  "es-ES": { controls: "Controles", subtree: "Subárbol", permission: "Este elemento requiere un permiso adicional." },
  "it-IT": { controls: "Controlli", subtree: "Sottoalbero", permission: "Questo elemento richiede un’autorizzazione aggiuntiva." },
};

function hasAccess(rule: PermissionRule | undefined, permissions: readonly string[]) {
  if (!rule) return true;
  if (rule.all?.some((permission) => !permissions.includes(permission))) return false;
  if (rule.any && !rule.any.some((permission) => permissions.includes(permission))) return false;
  return true;
}

function accessNote(rule: PermissionRule | undefined, language?: string) {
  if (!rule) return undefined;
  if (READOUT_COPY[language ?? ""]) return READOUT_COPY[language ?? ""].permission;
  const all = rule.all?.join(", ");
  const any = rule.any?.join(" or ");
  if (all && any) return `Requires ${all} and (${any}).`;
  if (all) return `Requires ${all}.`;
  if (any) return `Requires ${any}.`;
  return undefined;
}

export function resolveNavigationSection(raw: string): NavigationSectionId | undefined {
  const normalized = raw
    .trim()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase()
    .replace(/[.!?]+$/g, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ");
  const section = SECRETARY_NAVIGATION_CATALOGUE.find((candidate) => {
    const names = [candidate.label, ...candidate.aliases, ...Object.values(SECTION_COPY).map((copy) => copy[candidate.id]?.label).filter(Boolean)] as string[];
    return names.some((name) => name.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase() === normalized);
  });
  return section?.id;
}

function toView(section: NavigationSection, permissions: readonly string[], language?: string): NavigationSectionView {
  const sectionCopy = localizedSection(section, language);
  return {
    id: section.id,
    label: sectionCopy.label,
    description: sectionCopy.description,
    items: section.items.map((entry) => {
      const page = VOICE_PAGE_ROUTES[entry.page];
      return {
        id: entry.page,
        label: voicePageLabel(entry.page, language),
        path: page.path,
        description: localizedText(entry.description, language),
        controls: entry.controls.map((control) => localizedText(control, language)),
        available: hasAccess(entry.access, permissions),
        accessNote: accessNote(entry.access, language),
        children: (entry.children ?? []).map((subtree) => ({
          ...subtree,
          label: localizedText(subtree.label, language),
          description: localizedText(subtree.description, language),
          controls: subtree.controls.map((control) => localizedText(control, language)),
        })),
      };
    }),
  };
}

function readItem(item: NavigationItemView, language?: string) {
  const copy = READOUT_COPY[language ?? ""] ?? { controls: "Controls", subtree: "Subtree", permission: "This item requires additional permission." };
  const controls = item.controls.length ? ` ${copy.controls}: ${item.controls.join(", ")}.` : "";
  const childReadout = item.children
    .map((subtree) => `${subtree.label}${subtree.path ? ` (${subtree.path})` : ""} — ${subtree.description}${subtree.controls.length ? ` ${copy.controls}: ${subtree.controls.join(", ")}` : ""}`)
    .join("; ");
  const children = childReadout
    ? ` ${copy.subtree}: ${childReadout}${/[.!?]$/u.test(childReadout) ? "" : "."}`
    : "";
  const availability = item.available ? "" : ` ${item.accessNote ?? copy.permission}`;
  return `${item.label} (${item.path}) — ${item.description}${controls}${children}${availability}`;
}

export function getNavigationCatalogue(permissions: readonly string[], sectionId?: NavigationSectionId, language?: string): NavigationCatalogueView {
  const sections = SECRETARY_NAVIGATION_CATALOGUE
    .filter((section) => !sectionId || section.id === sectionId)
    .map((section) => toView(section, permissions, language));
  const completeTitle = language === "pl-PL" ? "Pełne menu Secretary"
    : language === "cs-CZ" ? "Úplné menu Secretary"
    : language === "fr-FR" ? "Menu complet de Secretary"
    : language === "de-DE" ? "Vollständiges Secretary-Menü"
    : language === "es-ES" ? "Menú completo de Secretary"
    : language === "it-IT" ? "Menu completo di Secretary"
    : "Complete Secretary menu";
  const title = sectionId ? sections[0]?.label ?? "Secretary" : completeTitle;
  const readout = [
    `${title}.`,
    ...sections.map((section) => `${section.label}: ${section.description}\n${section.items.map((entry) => `- ${readItem(entry, language)}`).join("\n")}`),
  ].join("\n\n");
  return { title, sections, readout };
}

// The prompt form is generated from the same catalogue returned to the
// Windows companion and web control centre. This prevents a newly added page
// from being known by one Emma surface but not another.
export const FULL_SECRETARY_MENU_TREE = getNavigationCatalogue(
  ["connectors.read", "recruitment.manage", "voice.execute", "audit.read"],
).readout;
