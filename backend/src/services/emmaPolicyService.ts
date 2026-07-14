import { z } from "zod";
import { prisma } from "../db.js";
import type { AuthedUser } from "../middleware/auth.js";
import type { ParsedCommand } from "../lib/commandParser.js";
import { recordAudit } from "../lib/audit.js";
import {
  capabilityIdForCommand,
  EMMA_CAPABILITIES,
  type EmmaCapability,
  type EmmaCapabilityMode,
} from "../lib/emmaSurfaceCatalogue.js";

export { EMMA_CAPABILITIES, type EmmaCapability, type EmmaCapabilityMode };
export type EmmaCapabilityId = (typeof EMMA_CAPABILITIES)[number]["id"];

const CAPABILITY_IDS = new Set<string>(EMMA_CAPABILITIES.map((item) => item.id));
const LEGACY_CAPABILITY_IDS = new Set([
  "navigation.open", "navigation.help", "preferences.language", "customers.read", "customers.write",
  "customers.clients.create", "customers.clients.update", "customers.clients.archive", "customers.contacts.create",
  "customers.contacts.update", "customers.contacts.archive", "customers.leads.write", "work.read", "work.write",
  "services.write", "sales.read", "communication.read", "communication.write", "communication.email_send",
  "communication.whatsapp_send", "notifications.read", "notifications.delete", "quality.read", "analytics.patterns",
  "recruitment.read", "learning.read", "learning.write", "photos.read", "photos.write", "connectors.read", "connectors.manage",
]);
const SAFE_CANCELLATION_INTENTS = new Set<ParsedCommand["intent"]>([
  "cancel_gmail_message", "cancel_whatsapp_message", "cancel_delete_notifications", "cancel_archive_client", "cancel_archive_contact",
]);

function legacyMatches(legacyId: string, capability: EmmaCapability) {
  if (legacyId === "navigation.open") return capability.kind === "page";
  if (legacyId === "navigation.help") return capability.id === "command.describe_menu";
  if (legacyId === "preferences.language") return capability.id === "action.update_voice_preferences";
  if (legacyId === "customers.read") return capability.category === "customers" && capability.mode === "read";
  if (legacyId === "customers.write") return capability.category === "customers" && capability.mode === "write";
  if (legacyId === "work.read") return capability.category === "work" && capability.mode === "read";
  if (legacyId === "work.write") return capability.category === "work" && capability.mode === "write";
  if (legacyId === "sales.read") return capability.category === "sales" && capability.mode === "read";
  if (legacyId === "services.write") return capability.category === "sales" && capability.mode === "write" && capability.actionName?.includes("service");
  if (legacyId === "communication.read") return capability.category === "communication" && capability.mode === "read";
  if (legacyId === "communication.write") return capability.category === "communication" && capability.mode === "write";
  if (legacyId === "communication.email_send") return capability.actionName?.includes("gmail") ?? false;
  if (legacyId === "communication.whatsapp_send") return capability.actionName?.includes("whatsapp") ?? false;
  if (legacyId === "notifications.read") return capability.id === "action.get_attention_feed";
  if (legacyId === "notifications.delete") return capability.actionName?.includes("notification_deletion") ?? false;
  if (legacyId === "quality.read") return capability.id === "action.analyze_data_quality";
  if (legacyId === "analytics.patterns") return capability.id === "action.detect_action_patterns";
  if (legacyId === "recruitment.read") return capability.category === "people" && capability.mode === "read";
  if (legacyId === "learning.read") return capability.category === "learning" && capability.mode === "read";
  if (legacyId === "learning.write") return capability.category === "learning" && capability.mode === "write";
  if (legacyId === "photos.read") return capability.category === "evidence" && capability.mode === "read" && capability.label.toLowerCase().includes("photo");
  if (legacyId === "photos.write") return capability.category === "evidence" && capability.mode === "write" && capability.label.toLowerCase().includes("photo");
  if (legacyId === "connectors.read") return capability.category === "connectors" && capability.mode === "read";
  if (legacyId === "connectors.manage") return capability.category === "connectors" && capability.mode !== "read";
  const customerAction = legacyId.replace("customers.clients.", "").replace("customers.contacts.", "");
  const resource = legacyId.includes("clients") ? "client" : legacyId.includes("contacts") ? "contact" : "lead";
  if (legacyId.startsWith("customers.") && capability.category === "customers") {
    return capability.actionName?.includes(resource) === true
      && (customerAction === "create" ? capability.actionName.startsWith("create_") : customerAction === "update" ? capability.actionName.startsWith("update_") : capability.actionName.startsWith("archive_"));
  }
  return false;
}

function effectiveDisabledCapabilities(stored: string[]) {
  const disabled = new Set(stored.filter((id) => CAPABILITY_IDS.has(id)));
  for (const legacyId of stored.filter((id) => LEGACY_CAPABILITY_IDS.has(id))) {
    for (const capability of EMMA_CAPABILITIES) if (legacyMatches(legacyId, capability)) disabled.add(capability.id);
  }
  return disabled;
}

export const updateEmmaPolicySchema = z.object({
  disabled_capabilities: z.array(z.string()).max(EMMA_CAPABILITIES.length).refine(
    (ids) => new Set(ids).size === ids.length && ids.every((id) => CAPABILITY_IDS.has(id) || LEGACY_CAPABILITY_IDS.has(id)),
    "One or more Emma capability IDs are invalid.",
  ),
});

export function isAdministrator(user: Pick<AuthedUser, "role">) {
  return user.role === "administrator" || user.role === "admin";
}

export async function getEmmaPolicy(user: AuthedUser) {
  const company = await prisma.company.findUnique({ where: { id: user.companyId }, select: { emmaDisabledCapabilities: true } });
  if (!company) return null;
  const disabled = effectiveDisabledCapabilities(company.emmaDisabledCapabilities);
  return {
    summary: {
      pages: EMMA_CAPABILITIES.filter((item) => item.kind === "page").length,
      actions: EMMA_CAPABILITIES.filter((item) => item.kind === "action").length,
      commands: EMMA_CAPABILITIES.filter((item) => item.kind === "command").length,
    },
    capabilities: EMMA_CAPABILITIES.map((capability) => ({ ...capability, intents: [...capability.intents], enabled: !disabled.has(capability.id) })),
  };
}

export async function updateEmmaPolicy(user: AuthedUser, disabledCapabilities: string[]) {
  const before = await prisma.company.findUniqueOrThrow({ where: { id: user.companyId }, select: { emmaDisabledCapabilities: true } });
  const normalized = [...disabledCapabilities].filter((id) => CAPABILITY_IDS.has(id)).sort();
  await prisma.company.update({ where: { id: user.companyId }, data: { emmaDisabledCapabilities: normalized } });
  await recordAudit({
    companyId: user.companyId, userId: user.id, actionName: "update_emma_company_policy",
    inputPayload: { disabledCapabilities: normalized }, dataBefore: { disabledCapabilities: before.emmaDisabledCapabilities },
    dataAfter: { disabledCapabilities: normalized }, riskLevel: 3, confirmationRequired: false, result: "success",
  });
  return getEmmaPolicy(user);
}

export async function evaluateEmmaCommand(user: AuthedUser, command: ParsedCommand | ParsedCommand["intent"]) {
  const intent = typeof command === "string" ? command : command.intent;
  if (intent === "unrecognized" || SAFE_CANCELLATION_INTENTS.has(intent)) return { allowed: true as const };
  const capabilityId = capabilityIdForCommand(command);
  if (!capabilityId || !CAPABILITY_IDS.has(capabilityId)) {
    return { allowed: false as const, capabilityId: "unclassified", message: "This Emma action has not been assigned an administrator policy yet." };
  }
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

