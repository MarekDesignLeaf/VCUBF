import { appLanguage, menuText, type AppLanguage, type MenuKey } from "./i18n";

const PAGE_MENU_KEYS: Record<string, MenuKey> = {
  Dashboard: "dashboard", Account: "account", Notifications: "notifications", "Data Quality": "dataQuality",
  "Business Metrics": "metrics", Leads: "leads", Clients: "clients", Contacts: "contacts", Documents: "documents",
  Jobs: "jobs", Tasks: "tasks", Enquiries: "enquiries", "Communication Intake": "communicationIntake",
  Communications: "communications", Photos: "photos", "Photo Selection": "photoSelection",
  "Business Context": "businessContext", Industries: "industries", Connectors: "connectors",
  "Website Audit": "websiteAudit", "Website Content": "websiteContent", Company: "company", Employees: "employees",
  Calendar: "calendar", Services: "services", Quotes: "quotes", Invoices: "invoices", Recruitment: "recruitment",
  Playbooks: "playbooks", Learning: "learning", "Emma Memory": "emmaMemory",
};
const templateCache = new WeakMap<Record<string, string>, Array<{ pattern: RegExp; translated: string }>>();
const sentenceSegmentCache = new WeakMap<Record<string, string>, Array<[string, string]>>();

function escapePattern(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function templateTranslations(catalogue: Record<string, string>) {
  const cached = templateCache.get(catalogue);
  if (cached) return cached;
  const templates = Object.entries(catalogue).flatMap(([source, translated]) => {
    if (!source.includes("{{0}}")) return [];
    const parts = source.split(/\{\{\d+\}\}/g).map(escapePattern);
    return [{ pattern: new RegExp(`^${parts.join("(.*?)")}$`, "u"), translated }];
  });
  templateCache.set(catalogue, templates);
  return templates;
}

function translatedSentenceSegments(catalogue: Record<string, string>) {
  const cached = sentenceSegmentCache.get(catalogue);
  if (cached) return cached;
  const segments = Object.entries(catalogue)
    .filter(([source]) => source.length >= 12 && /[.!?]$/u.test(source) && !source.includes("{{"))
    .sort(([left], [right]) => right.length - left.length);
  sentenceSegmentCache.set(catalogue, segments);
  return segments;
}

function translateTemplateValue(catalogue: Record<string, string>, value: string) {
  const exact = catalogue[value];
  if (exact) return exact;
  return translatedSentenceSegments(catalogue).reduce(
    (translated, [source, target]) => translated.replaceAll(source, target),
    value,
  );
}

export async function loadUiCatalogue(language: AppLanguage): Promise<Record<string, string>> {
  switch (language) {
    case "cs-CZ": return (await import("./locales/generated/cs-CZ")).default;
    case "pl-PL": return (await import("./locales/generated/pl-PL")).default;
    case "fr-FR": return (await import("./locales/generated/fr-FR")).default;
    case "de-DE": return (await import("./locales/generated/de-DE")).default;
    case "es-ES": return (await import("./locales/generated/es-ES")).default;
    case "it-IT": return (await import("./locales/generated/it-IT")).default;
    default: return {};
  }
}

export function translateUiPhrase(catalogue: Record<string, string>, language: AppLanguage | string | null | undefined, phrase: string) {
  const resolved = appLanguage(language);
  const normalized = phrase.replace(/\s+/g, " ").trim();
  if (!normalized) return phrase;
  const menuKey = PAGE_MENU_KEYS[normalized];
  if (menuKey) return menuText(resolved, menuKey);
  const exact = catalogue[normalized];
  if (exact) return exact;
  for (const template of templateTranslations(catalogue)) {
    const match = normalized.match(template.pattern);
    if (!match) continue;
    return match.slice(1).reduce(
      (translated, value, index) => {
        const leading = value.match(/^\s*/u)?.[0] ?? "";
        const trailing = value.match(/\s*$/u)?.[0] ?? "";
        const normalizedValue = value.trim();
        const valueMenuKey = PAGE_MENU_KEYS[normalizedValue];
        const localizedCore = valueMenuKey
          ? menuText(resolved, valueMenuKey)
          : translateTemplateValue(catalogue, normalizedValue);
        const localizedValue = `${leading}${localizedCore}${trailing}`;
        return translated.replaceAll(`{{${index}}}`, localizedValue);
      },
      template.translated,
    );
  }
  return phrase;
}
