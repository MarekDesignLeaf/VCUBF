import * as actionContractModule from "./actionContracts.js";
import type { ActionContract } from "./actionContracts.js";
import type { ParsedCommand } from "./commandParser.js";
import { SECRETARY_NAVIGATION_CATALOGUE } from "./navigationCatalogue.js";
import { VOICE_PAGE_ROUTES, type VoicePage } from "./voiceNavigation.js";

export type EmmaCapabilityMode = "read" | "write" | "external" | "administration";
export type EmmaCapabilityKind = "page" | "action" | "command";

export type EmmaCapability = {
  id: string;
  category: string;
  mode: EmmaCapabilityMode;
  kind: EmmaCapabilityKind;
  label: string;
  description: string;
  intents: readonly ParsedCommand["intent"][];
  route?: string;
  page?: VoicePage;
  actionName?: string;
  requiredPermission?: string;
  riskLevel?: ActionContract["riskLevel"];
  confirmationRequired?: boolean;
};

type CommandPolicy = {
  category: string;
  mode: EmmaCapabilityMode;
  actionName?: string;
  description?: string;
};

// Exhaustive by type: adding a new ParsedCommand intent cannot compile until
// it has an administrator-visible policy assignment here.
export const COMMAND_POLICY = {
  create_client: { category: "customers", mode: "write", actionName: "create_client" },
  update_client: { category: "customers", mode: "write", actionName: "update_client" },
  prepare_archive_client: { category: "customers", mode: "write", actionName: "archive_client" },
  confirm_archive_client: { category: "customers", mode: "write", actionName: "archive_client" },
  cancel_archive_client: { category: "customers", mode: "write", actionName: "archive_client" },
  create_contact: { category: "customers", mode: "write", actionName: "create_contact" },
  update_contact: { category: "customers", mode: "write", actionName: "update_contact" },
  prepare_archive_contact: { category: "customers", mode: "write", actionName: "archive_contact" },
  confirm_archive_contact: { category: "customers", mode: "write", actionName: "archive_contact" },
  cancel_archive_contact: { category: "customers", mode: "write", actionName: "archive_contact" },
  create_lead: { category: "customers", mode: "write", actionName: "create_lead" },
  create_job: { category: "work", mode: "write", actionName: "create_job" },
  change_job_status: { category: "work", mode: "write", actionName: "change_job_status" },
  convert_lead: { category: "customers", mode: "write", actionName: "convert_lead_to_client" },
  assign_job: { category: "work", mode: "write", actionName: "assign_job" },
  detect_overload: { category: "work", mode: "read", actionName: "detect_overload" },
  create_service: { category: "sales", mode: "write", actionName: "create_service_catalogue_item" },
  create_task: { category: "work", mode: "write", actionName: "create_task" },
  list_tasks: { category: "work", mode: "read" },
  change_task_status: { category: "work", mode: "write", actionName: "update_task" },
  list_quotes: { category: "sales", mode: "read" },
  list_job_openings: { category: "people", mode: "read" },
  create_learning_rule: { category: "learning", mode: "write", actionName: "create_learning_rule" },
  list_learning_rules: { category: "learning", mode: "read" },
  create_assistant_memory: { category: "learning", mode: "write", actionName: "create_assistant_memory" },
  recall_assistant_memory: { category: "learning", mode: "read", actionName: "recall_assistant_memory" },
  log_communication: { category: "communication", mode: "write", actionName: "log_communication" },
  list_communications: { category: "communication", mode: "read" },
  log_portfolio_photo: { category: "evidence", mode: "write", actionName: "log_portfolio_photo" },
  list_portfolio_photos: { category: "evidence", mode: "read" },
  list_follow_ups: { category: "communication", mode: "read" },
  list_unresolved_enquiries: { category: "communication", mode: "read", actionName: "find_unresolved_enquiries" },
  list_notifications: { category: "attention", mode: "read", actionName: "get_attention_feed" },
  prepare_delete_notifications: { category: "attention", mode: "write", actionName: "prepare_voice_notification_deletion" },
  confirm_delete_notifications: { category: "attention", mode: "write", actionName: "confirm_voice_notification_deletion" },
  cancel_delete_notifications: { category: "attention", mode: "write", actionName: "cancel_voice_notification_deletion" },
  list_data_quality: { category: "attention", mode: "read", actionName: "analyze_data_quality" },
  detect_action_patterns: { category: "attention", mode: "read", actionName: "detect_action_patterns" },
  list_clients: { category: "customers", mode: "read" },
  list_contacts: { category: "customers", mode: "read" },
  list_channel_messages: { category: "communication", mode: "read" },
  prepare_gmail_message: { category: "communication", mode: "external", actionName: "prepare_voice_gmail_message" },
  confirm_gmail_message: { category: "communication", mode: "external", actionName: "confirm_voice_gmail_message" },
  cancel_gmail_message: { category: "communication", mode: "external", actionName: "cancel_voice_gmail_message" },
  list_calendar_events: { category: "work", mode: "read" },
  prepare_whatsapp_message: { category: "communication", mode: "external", actionName: "send_whatsapp_message" },
  confirm_whatsapp_message: { category: "communication", mode: "external", actionName: "send_whatsapp_message" },
  cancel_whatsapp_message: { category: "communication", mode: "external", actionName: "send_whatsapp_message" },
  set_voice_language: { category: "navigation", mode: "write", actionName: "update_voice_preferences" },
  describe_menu: { category: "navigation", mode: "read" },
  connector_status: { category: "connectors", mode: "read" },
  setup_connectors: { category: "connectors", mode: "administration" },
  sync_connectors: { category: "connectors", mode: "administration" },
  list_jobs: { category: "work", mode: "read" },
  list_leads: { category: "customers", mode: "read" },
  navigate: { category: "navigation", mode: "read" },
  unrecognized: { category: "navigation", mode: "read" },
} as const satisfies Record<ParsedCommand["intent"], CommandPolicy>;

const PAGE_CATEGORIES: Record<VoicePage, string> = {
  dashboard: "navigation", setup: "administration", forgot_password: "navigation", reset_password: "navigation",
  account: "navigation", emma_permissions: "administration", notifications: "attention", data_quality: "attention",
  metrics: "attention", leads: "customers", clients: "customers", contacts: "customers", documents: "customers",
  jobs: "work", tasks: "work", enquiries: "communication", communication_intake: "communication",
  communications: "communication", photos: "evidence", photo_selection: "evidence", business_context: "evidence",
  industries: "evidence", connectors: "connectors", company: "administration", website_audit: "evidence",
  website_content: "evidence", employees: "people", calendar: "work", services: "sales", quotes: "sales",
  invoices: "sales", recruitment: "people", playbooks: "learning", learning: "learning", memory_model: "learning",
};

function isActionContract(value: unknown): value is ActionContract {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ActionContract>;
  return typeof candidate.actionName === "string"
    && typeof candidate.purpose === "string"
    && typeof candidate.requiredPermission === "string"
    && typeof candidate.riskLevel === "number"
    && typeof candidate.confirmationRequired === "boolean"
    && Array.isArray(candidate.dataSources)
    && Array.isArray(candidate.possibleErrors);
}

export const EMMA_ACTION_CONTRACTS = Object.values(actionContractModule)
  .filter(isActionContract)
  .sort((left, right) => left.actionName.localeCompare(right.actionName));

function humanize(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function slug(value: string) {
  return value.toLowerCase().replace(/:[a-z]+/g, "detail").replace(/[^a-z0-9]+/g, ".").replace(/^\.|\.$/g, "");
}

function actionCategory(action: ActionContract) {
  const name = action.actionName;
  if (/gmail|whatsapp|google_|connector/.test(name)) return "connectors";
  if (/client|contact|lead/.test(name)) return "customers";
  if (/job_|task|capacity|schedule|overload/.test(name)) return "work";
  if (/quote|invoice|payment|service_catalogue|reference_activity/.test(name)) return "sales";
  if (/communication|enquir/.test(name)) return "communication";
  if (/notification|data_quality|metrics|action_patterns/.test(name)) return "attention";
  if (/employee|candidate|recruitment|job_opening/.test(name)) return "people";
  if (/learning|memory|playbook|behavior/.test(name)) return "learning";
  if (/photo|website|industry|business_context|document/.test(name)) return "evidence";
  if (/password|pairing|company_policy|voice_preferences/.test(name)) return "administration";
  return "administration";
}

function actionMode(action: ActionContract): EmmaCapabilityMode {
  if (/gmail|whatsapp|google_|connector/.test(action.actionName)) return "external";
  if (action.requiredPermission === "company.manage" || action.requiredPermission === "users.manage") return "administration";
  if (action.riskLevel === 0 || /^(get|list|find|detect|check|recall|export|analyze)_/.test(action.actionName)) return "read";
  return "write";
}

const intentsByAction = new Map<string, ParsedCommand["intent"][]>();
for (const [intent, policy] of Object.entries(COMMAND_POLICY) as Array<[ParsedCommand["intent"], CommandPolicy]>) {
  if (!policy.actionName) continue;
  const intents = intentsByAction.get(policy.actionName) ?? [];
  intents.push(intent);
  intentsByAction.set(policy.actionName, intents);
}

const pageCapabilities: EmmaCapability[] = Object.entries(VOICE_PAGE_ROUTES).map(([page, definition]) => ({
  id: `page.${page}`,
  category: PAGE_CATEGORIES[page as VoicePage],
  mode: "read",
  kind: "page",
  label: `Open ${definition.label}`,
  description: `Emma may open and guide the user through ${definition.label}.`,
  intents: [],
  route: definition.path,
  page: page as VoicePage,
}));

const knownRoutes = new Set(pageCapabilities.map((capability) => capability.route));
for (const section of SECRETARY_NAVIGATION_CATALOGUE) {
  for (const item of section.items) {
    for (const child of item.children ?? []) {
      if (!child.path || knownRoutes.has(child.path)) continue;
      knownRoutes.add(child.path);
      pageCapabilities.push({
        id: `page.${item.page}.${slug(child.path)}`,
        category: PAGE_CATEGORIES[item.page],
        mode: "read",
        kind: "page",
        label: `Open ${child.label}`,
        description: child.description,
        intents: [],
        route: child.path,
        page: item.page,
      });
    }
  }
}

const actionCapabilities: EmmaCapability[] = EMMA_ACTION_CONTRACTS.map((action) => ({
  id: `action.${action.actionName}`,
  category: actionCategory(action),
  mode: actionMode(action),
  kind: "action",
  label: humanize(action.actionName),
  description: action.purpose,
  intents: intentsByAction.get(action.actionName) ?? [],
  actionName: action.actionName,
  requiredPermission: action.requiredPermission,
  riskLevel: action.riskLevel,
  confirmationRequired: action.confirmationRequired,
}));

const actionNames = new Set(EMMA_ACTION_CONTRACTS.map((action) => action.actionName));
const commandCapabilities: EmmaCapability[] = (Object.entries(COMMAND_POLICY) as Array<[ParsedCommand["intent"], CommandPolicy]>)
  .filter(([intent, policy]) => intent !== "navigate" && intent !== "unrecognized" && (!policy.actionName || !actionNames.has(policy.actionName)))
  .map(([intent, policy]) => ({
    id: `command.${intent}`,
    category: policy.category,
    mode: policy.mode,
    kind: "command",
    label: humanize(intent),
    description: policy.description ?? `Emma may execute the ${humanize(intent).toLowerCase()} voice operation.`,
    intents: [intent],
  }));

export const EMMA_CAPABILITIES = [...pageCapabilities, ...actionCapabilities, ...commandCapabilities]
  .sort((left, right) => left.category.localeCompare(right.category) || left.kind.localeCompare(right.kind) || left.label.localeCompare(right.label));

export const EMMA_PAGE_CAPABILITY_COUNT = pageCapabilities.length;
export const EMMA_ACTION_CAPABILITY_COUNT = actionCapabilities.length;

export function capabilityIdForCommand(command: ParsedCommand | ParsedCommand["intent"]): string | undefined {
  const intent = typeof command === "string" ? command : command.intent;
  if (intent === "unrecognized") return undefined;
  if (intent === "navigate" && typeof command !== "string") {
    const navigation = command as Extract<ParsedCommand, { intent: "navigate" }>;
    return `page.${navigation.entities.page}`;
  }
  const policy: CommandPolicy = COMMAND_POLICY[intent];
  if (policy.actionName && actionNames.has(policy.actionName)) return `action.${policy.actionName}`;
  return `command.${intent}`;
}
