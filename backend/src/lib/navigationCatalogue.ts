import { VOICE_PAGE_ROUTES, type VoicePage } from "./voiceNavigation.js";

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
    ],
  },
  {
    id: "attention_and_insight",
    label: "Attention and insight",
    description: "Operational attention, evidence quality and company-level measurements.",
    aliases: ["attention", "insight", "alerts", "notifications", "data", "metrics", "upozornění", "kvalita dat", "metriky"],
    items: [
      item("notifications", "Attention feed for overdue follow-ups, capacity and quote facts; acknowledging an item does not alter its source record."),
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
        "employees",
        "Users, roles, permissions, skills and capacity. Material employment changes always require review.",
        ["New employee", "Manage"],
        { children: [
          child("New employee", "/employees/new", "Creates a proposed employee record; review before confirmation.", ["Review changes", "Confirm changes"]),
          child("Employee management", "/employees/:id/edit", "Edits roles, permissions, skills, capacity and access under the reviewed workflow.", ["Review changes", "Confirm changes", "Review reset", "Confirm reset"]),
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

function hasAccess(rule: PermissionRule | undefined, permissions: readonly string[]) {
  if (!rule) return true;
  if (rule.all?.some((permission) => !permissions.includes(permission))) return false;
  if (rule.any && !rule.any.some((permission) => permissions.includes(permission))) return false;
  return true;
}

function accessNote(rule: PermissionRule | undefined) {
  if (!rule) return undefined;
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
    .toLocaleLowerCase()
    .replace(/[.!?]+$/g, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ");
  const section = SECRETARY_NAVIGATION_CATALOGUE.find((candidate) =>
    candidate.aliases.some((alias) => alias.toLocaleLowerCase() === normalized) || candidate.label.toLocaleLowerCase() === normalized
  );
  return section?.id;
}

function toView(section: NavigationSection, permissions: readonly string[]): NavigationSectionView {
  return {
    id: section.id,
    label: section.label,
    description: section.description,
    items: section.items.map((entry) => {
      const page = VOICE_PAGE_ROUTES[entry.page];
      return {
        id: entry.page,
        label: page.label,
        path: page.path,
        description: entry.description,
        controls: [...entry.controls],
        available: hasAccess(entry.access, permissions),
        accessNote: accessNote(entry.access),
        children: (entry.children ?? []).map((subtree) => ({ ...subtree, controls: [...subtree.controls] })),
      };
    }),
  };
}

function readItem(item: NavigationItemView) {
  const controls = item.controls.length ? ` Controls: ${item.controls.join(", ")}.` : "";
  const children = item.children.length
    ? ` Subtree: ${item.children
        .map((subtree) => `${subtree.label}${subtree.path ? ` (${subtree.path})` : ""} — ${subtree.description}${subtree.controls.length ? ` Controls: ${subtree.controls.join(", ")}` : ""}`)
        .join("; ")}.`
    : "";
  const availability = item.available ? "" : ` ${item.accessNote ?? "This item requires additional permission."}`;
  return `${item.label} (${item.path}) — ${item.description}${controls}${children}${availability}`;
}

export function getNavigationCatalogue(permissions: readonly string[], sectionId?: NavigationSectionId): NavigationCatalogueView {
  const sections = SECRETARY_NAVIGATION_CATALOGUE
    .filter((section) => !sectionId || section.id === sectionId)
    .map((section) => toView(section, permissions));
  const title = sectionId ? `${sections[0]?.label ?? "Secretary"} menu` : "Complete Secretary menu";
  const readout = [
    `${title}.`,
    ...sections.map((section) => `${section.label}: ${section.description}\n${section.items.map((entry) => `- ${readItem(entry)}`).join("\n")}`),
  ].join("\n\n");
  return { title, sections, readout };
}

// The prompt form is generated from the same catalogue returned to the
// Windows companion and web control centre. This prevents a newly added page
// from being known by one Emma surface but not another.
export const FULL_SECRETARY_MENU_TREE = getNavigationCatalogue(
  ["connectors.read", "recruitment.manage", "voice.execute", "audit.read"],
).readout;
