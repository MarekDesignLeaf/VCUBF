import { z } from "zod";
import { prisma } from "../db.js";
import type { AuthedUser } from "../middleware/auth.js";
import type { ParsedCommand } from "../lib/commandParser.js";
import { recordAudit } from "../lib/audit.js";

export type EmmaCapabilityMode = "read" | "write" | "external" | "administration";

export type EmmaCapability = {
  id: string;
  category: string;
  mode: EmmaCapabilityMode;
  label: string;
  description: string;
  intents: readonly ParsedCommand["intent"][];
};

export const EMMA_CAPABILITIES = [
  { id: "navigation.open", category: "navigation", mode: "read", label: "Open application pages", description: "Emma may open screens and tabs in Secretary.", intents: ["navigate"] },
  { id: "navigation.help", category: "navigation", mode: "read", label: "Read the menu and guide users", description: "Emma may read the application hierarchy and explain where functions are.", intents: ["describe_menu"] },
  { id: "preferences.language", category: "navigation", mode: "write", label: "Change application language", description: "Emma may change her spoken language and the Secretary menu language together.", intents: ["set_voice_language"] },
  { id: "customers.read", category: "customers", mode: "read", label: "Read customers, contacts and leads", description: "Emma may list customer, contact and lead records.", intents: ["list_clients", "list_contacts", "list_leads"] },
  { id: "customers.clients.create", category: "customers", mode: "write", label: "Create clients", description: "Emma may create a client after validating the name, email and phone number.", intents: ["create_client"] },
  { id: "customers.clients.update", category: "customers", mode: "write", label: "Edit clients", description: "Emma may change an existing client's validated details.", intents: ["update_client"] },
  { id: "customers.clients.archive", category: "customers", mode: "write", label: "Archive clients", description: "Emma may prepare and, after explicit confirmation, archive a client without deleting linked records.", intents: ["prepare_archive_client", "confirm_archive_client", "cancel_archive_client"] },
  { id: "customers.contacts.create", category: "customers", mode: "write", label: "Create contacts", description: "Emma may add a validated person to the contact directory.", intents: ["create_contact"] },
  { id: "customers.contacts.update", category: "customers", mode: "write", label: "Edit contacts", description: "Emma may change an existing contact's validated details.", intents: ["update_contact"] },
  { id: "customers.contacts.archive", category: "customers", mode: "write", label: "Archive contacts", description: "Emma may prepare and, after explicit confirmation, archive a contact.", intents: ["prepare_archive_contact", "confirm_archive_contact", "cancel_archive_contact"] },
  { id: "customers.leads.write", category: "customers", mode: "write", label: "Create and convert leads", description: "Emma may create leads and convert a reviewed lead to a client.", intents: ["create_lead", "convert_lead"] },
  { id: "work.read", category: "work", mode: "read", label: "Read jobs, tasks and calendar", description: "Emma may list work, tasks, follow-ups, calendar events and capacity information.", intents: ["list_jobs", "list_tasks", "list_calendar_events", "list_follow_ups", "detect_overload"] },
  { id: "work.write", category: "work", mode: "write", label: "Change jobs and tasks", description: "Emma may create or update jobs and tasks and assign work to employees.", intents: ["create_job", "change_job_status", "assign_job", "create_task", "change_task_status"] },
  { id: "services.write", category: "sales", mode: "write", label: "Create services", description: "Emma may add an item to the service catalogue.", intents: ["create_service"] },
  { id: "sales.read", category: "sales", mode: "read", label: "Read quotes", description: "Emma may list quotes and filter them by customer.", intents: ["list_quotes"] },
  { id: "communication.read", category: "communication", mode: "read", label: "Read communication", description: "Emma may read communication history, enquiries, email and WhatsApp message lists.", intents: ["list_communications", "list_unresolved_enquiries", "list_channel_messages"] },
  { id: "communication.write", category: "communication", mode: "write", label: "Record communication", description: "Emma may add an internal communication record.", intents: ["log_communication"] },
  { id: "communication.email_send", category: "communication", mode: "external", label: "Prepare and send email", description: "Emma may prepare and, after explicit confirmation, send Gmail messages.", intents: ["prepare_gmail_message", "confirm_gmail_message"] },
  { id: "communication.whatsapp_send", category: "communication", mode: "external", label: "Prepare and send WhatsApp messages", description: "Emma may prepare and, after explicit confirmation, send WhatsApp Business messages.", intents: ["prepare_whatsapp_message", "confirm_whatsapp_message"] },
  { id: "notifications.read", category: "attention", mode: "read", label: "Read notifications", description: "Emma may list the company attention feed.", intents: ["list_notifications"] },
  { id: "notifications.delete", category: "attention", mode: "write", label: "Delete notifications", description: "Emma may prepare and confirm deletion of notifications.", intents: ["prepare_delete_notifications", "confirm_delete_notifications"] },
  { id: "quality.read", category: "attention", mode: "read", label: "Read data quality", description: "Emma may report possible duplicates and missing contact data.", intents: ["list_data_quality"] },
  { id: "analytics.patterns", category: "attention", mode: "read", label: "Analyse action patterns", description: "Emma may inspect audited repeated action patterns.", intents: ["detect_action_patterns"] },
  { id: "recruitment.read", category: "people", mode: "read", label: "Read recruitment", description: "Emma may list current job openings.", intents: ["list_job_openings"] },
  { id: "learning.read", category: "learning", mode: "read", label: "Read learning rules and memory", description: "Emma may list phrase rules and recall explicitly stored memory.", intents: ["list_learning_rules", "recall_assistant_memory"] },
  { id: "learning.write", category: "learning", mode: "write", label: "Teach Emma and store memory", description: "Emma may create a visible learning rule or an explicit personal/company memory.", intents: ["create_learning_rule", "create_assistant_memory"] },
  { id: "photos.read", category: "evidence", mode: "read", label: "Read portfolio photos", description: "Emma may list registered portfolio photos.", intents: ["list_portfolio_photos"] },
  { id: "photos.write", category: "evidence", mode: "write", label: "Register portfolio photos", description: "Emma may register photo evidence from an entered file reference.", intents: ["log_portfolio_photo"] },
  { id: "connectors.read", category: "connectors", mode: "read", label: "Read connector status", description: "Emma may report which connectors are configured and available.", intents: ["connector_status"] },
  { id: "connectors.manage", category: "connectors", mode: "administration", label: "Configure and synchronise connectors", description: "Emma may start guided connector setup and trigger synchronisation.", intents: ["setup_connectors", "sync_connectors"] },
] as const satisfies readonly EmmaCapability[];

export type EmmaCapabilityId = (typeof EMMA_CAPABILITIES)[number]["id"];
const CAPABILITY_IDS = new Set<string>(EMMA_CAPABILITIES.map((item) => item.id));
const SAFE_CANCELLATION_INTENTS = new Set<ParsedCommand["intent"]>([
  "cancel_gmail_message",
  "cancel_whatsapp_message",
  "cancel_delete_notifications",
  "cancel_archive_client",
  "cancel_archive_contact",
]);

const LEGACY_CUSTOMER_WRITE_CAPABILITY = "customers.write";
const CUSTOMER_MUTATION_CAPABILITIES = EMMA_CAPABILITIES
  .filter((item) => item.id.startsWith("customers.") && item.mode === "write")
  .map((item) => item.id);

function effectiveDisabledCapabilities(stored: string[]) {
  const disabled = new Set(stored);
  if (disabled.has(LEGACY_CUSTOMER_WRITE_CAPABILITY)) {
    for (const id of CUSTOMER_MUTATION_CAPABILITIES) disabled.add(id);
  }
  return disabled;
}
const INTENT_CAPABILITY = new Map<ParsedCommand["intent"], EmmaCapabilityId>();
for (const capability of EMMA_CAPABILITIES) {
  for (const intent of capability.intents) INTENT_CAPABILITY.set(intent, capability.id);
}

export const updateEmmaPolicySchema = z.object({
  disabled_capabilities: z.array(z.string()).max(EMMA_CAPABILITIES.length).refine(
    (ids) => new Set(ids).size === ids.length && ids.every((id) => CAPABILITY_IDS.has(id)),
    "One or more Emma capability IDs are invalid.",
  ),
});

export function isAdministrator(user: Pick<AuthedUser, "role">) {
  return user.role === "administrator" || user.role === "admin";
}

export async function getEmmaPolicy(user: AuthedUser) {
  const company = await prisma.company.findUnique({
    where: { id: user.companyId },
    select: { emmaDisabledCapabilities: true },
  });
  if (!company) return null;
  const disabled = effectiveDisabledCapabilities(company.emmaDisabledCapabilities);
  return {
    capabilities: EMMA_CAPABILITIES.map((capability) => ({
      id: capability.id,
      category: capability.category,
      mode: capability.mode,
      label: capability.label,
      description: capability.description,
      intents: [...capability.intents],
      enabled: !disabled.has(capability.id),
    })),
  };
}

export async function updateEmmaPolicy(user: AuthedUser, disabledCapabilities: string[]) {
  const before = await prisma.company.findUniqueOrThrow({
    where: { id: user.companyId },
    select: { emmaDisabledCapabilities: true },
  });
  const normalized = [...disabledCapabilities].sort();
  await prisma.company.update({
    where: { id: user.companyId },
    data: { emmaDisabledCapabilities: normalized },
  });
  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: "update_emma_company_policy",
    inputPayload: { disabledCapabilities: normalized },
    dataBefore: { disabledCapabilities: before.emmaDisabledCapabilities },
    dataAfter: { disabledCapabilities: normalized },
    riskLevel: 3,
    confirmationRequired: false,
    result: "success",
  });
  return getEmmaPolicy(user);
}

export async function evaluateEmmaCommand(user: AuthedUser, intent: ParsedCommand["intent"]) {
  if (intent === "unrecognized" || SAFE_CANCELLATION_INTENTS.has(intent)) return { allowed: true as const };
  const capabilityId = INTENT_CAPABILITY.get(intent);
  if (!capabilityId) return { allowed: false as const, capabilityId: "unclassified", message: "This Emma action has not been assigned an administrator policy yet." };
  const company = await prisma.company.findUnique({ where: { id: user.companyId }, select: { emmaDisabledCapabilities: true } });
  if (!company) return { allowed: false as const, capabilityId, message: "The company policy could not be loaded." };
  if (!effectiveDisabledCapabilities(company.emmaDisabledCapabilities).has(capabilityId)) return { allowed: true as const, capabilityId };
  const capability = EMMA_CAPABILITIES.find((item) => item.id === capabilityId)!;
  const message = user.voiceLanguage === "pl-PL"
    ? `Administrator wyłączył dla Emmy uprawnienie: ${capability.label}.`
    : user.voiceLanguage === "cs-CZ"
      ? `Správce vypnul Emmě oprávnění: ${capability.label}.`
      : `The administrator has disabled this Emma capability: ${capability.label}.`;
  return { allowed: false as const, capabilityId, message };
}
