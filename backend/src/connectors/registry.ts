export const CONNECTOR_KEYS = ["gmail", "google_contacts", "google_calendar", "google_drive", "google_photos", "whatsapp_business"] as const;
export type ConnectorKey = (typeof CONNECTOR_KEYS)[number];

export interface ConnectorDefinition {
  key: ConnectorKey;
  serviceName: string;
  serviceType: "email" | "contacts" | "calendar" | "photo_storage" | "messaging";
  canRead: string[];
  canWrite: string[];
  logicalScopes: string[];
  requiredPermissions: string[];
  returnedDataTypes: string[];
  supportedActions: string[];
  possibleErrors: string[];
  supportsAudit: boolean;
  supportsRollback: boolean;
  actionMode: "proposal_and_confirmed_action";
  adapterAvailable: boolean;
}

// Phase 3 contract registry. Capabilities describe the adapter boundary the
// provider implementation must honour. Availability is true only for an
// adapter implemented and verified in this build.
export const CONNECTOR_DEFINITIONS: Record<ConnectorKey, ConnectorDefinition> = {
  gmail: {
    key: "gmail",
    serviceName: "Gmail Connector",
    serviceType: "email",
    canRead: ["messages", "threads", "attachment metadata"],
    canWrite: ["draft messages", "send messages after explicit confirmation"],
    logicalScopes: ["read:messages", "write:drafts", "send:messages"],
    requiredPermissions: ["connectors.read", "connectors.manage"],
    returnedDataTypes: ["communication intake", "thread reference"],
    supportedActions: ["authorize selected Gmail access", "synchronise messages into communication intake", "create a draft", "send a reviewed and confirmed message"],
    possibleErrors: ["AUTHORIZATION_REQUIRED", "SCOPE_DENIED", "RATE_LIMITED", "PROVIDER_UNAVAILABLE", "MESSAGE_NOT_FOUND"],
    supportsAudit: true,
    supportsRollback: false,
    actionMode: "proposal_and_confirmed_action",
    adapterAvailable: true,
  },
  google_contacts: {
    key: "google_contacts",
    serviceName: "Google Contacts Connector",
    serviceType: "contacts",
    canRead: ["contact names", "email addresses", "telephone numbers", "organisation metadata"],
    canWrite: [],
    logicalScopes: ["read:contacts"],
    requiredPermissions: ["connectors.read", "connectors.manage", "crm.read", "crm.manage"],
    returnedDataTypes: ["external contact", "external contact source reference"],
    supportedActions: ["authorize read-only access", "synchronise contact previews", "import one contact into CRM after confirmation"],
    possibleErrors: ["AUTHORIZATION_REQUIRED", "SCOPE_DENIED", "RATE_LIMITED", "PROVIDER_UNAVAILABLE", "SYNC_TOKEN_EXPIRED", "CONTACT_NOT_FOUND"],
    supportsAudit: true,
    supportsRollback: false,
    actionMode: "proposal_and_confirmed_action",
    adapterAvailable: true,
  },
  google_calendar: {
    key: "google_calendar",
    serviceName: "Google Calendar Connector",
    serviceType: "calendar",
    canRead: ["calendar metadata", "event time", "event attendees", "availability"],
    canWrite: [],
    logicalScopes: ["read:calendar"],
    requiredPermissions: ["connectors.read", "connectors.manage", "crm.read", "crm.manage"],
    returnedDataTypes: ["calendar", "calendar event", "availability interval"],
    supportedActions: ["authorize read-only access", "synchronise calendars and event previews", "review external events"],
    possibleErrors: ["AUTHORIZATION_REQUIRED", "SCOPE_DENIED", "RATE_LIMITED", "PROVIDER_UNAVAILABLE", "SYNC_TOKEN_EXPIRED"],
    supportsAudit: true,
    supportsRollback: false,
    actionMode: "proposal_and_confirmed_action",
    adapterAvailable: true,
  },
  google_drive: {
    key: "google_drive",
    serviceName: "Google Drive Image Picker",
    serviceType: "photo_storage",
    canRead: ["file metadata", "folder metadata", "image file references"],
    canWrite: [],
    logicalScopes: ["select:image_files"],
    requiredPermissions: ["connectors.read", "connectors.manage", "crm.read", "crm.manage"],
    returnedDataTypes: ["photo file reference", "folder reference", "file metadata"],
    supportedActions: ["authorize per-file access", "select image files with Google Picker", "stage image metadata", "register confirmed portfolio reference"],
    possibleErrors: ["AUTHORIZATION_REQUIRED", "SCOPE_DENIED", "RATE_LIMITED", "PROVIDER_UNAVAILABLE", "FILE_NOT_FOUND", "NOT_AN_IMAGE"],
    supportsAudit: true,
    supportsRollback: false,
    actionMode: "proposal_and_confirmed_action",
    adapterAvailable: true,
  },
  google_photos: {
    key: "google_photos",
    serviceName: "Google Photos Picker",
    serviceType: "photo_storage",
    canRead: ["metadata for photos explicitly selected by the user"],
    canWrite: [],
    logicalScopes: ["select:user_selected_photos"],
    requiredPermissions: ["connectors.read", "connectors.manage", "crm.read", "crm.manage"],
    returnedDataTypes: ["selected Google Photos reference", "photo metadata"],
    supportedActions: ["authorize Google Photos Picker", "open a user-controlled Google Photos selection session", "stage selected photo metadata", "register confirmed portfolio reference"],
    possibleErrors: ["AUTHORIZATION_REQUIRED", "SCOPE_DENIED", "RATE_LIMITED", "PROVIDER_UNAVAILABLE", "PICKER_SELECTION_PENDING", "NOT_AN_IMAGE"],
    supportsAudit: true,
    supportsRollback: false,
    actionMode: "proposal_and_confirmed_action",
    adapterAvailable: true,
  },
  whatsapp_business: {
    key: "whatsapp_business",
    serviceName: "WhatsApp Business Cloud API",
    serviceType: "messaging",
    canRead: ["inbound message text", "sender number", "sender profile name", "delivery status webhooks"],
    canWrite: ["send text messages after explicit confirmation"],
    logicalScopes: ["read:messages", "send:messages"],
    requiredPermissions: ["connectors.read", "connectors.manage", "crm.read"],
    returnedDataTypes: ["communication intake", "message delivery reference"],
    supportedActions: ["verify signed Meta webhooks", "import inbound messages", "send a reviewed and confirmed text message"],
    possibleErrors: ["CONFIGURATION_MISSING", "AUTHORIZATION_REQUIRED", "WEBHOOK_SIGNATURE_INVALID", "SCOPE_DENIED", "RATE_LIMITED", "PROVIDER_UNAVAILABLE"],
    supportsAudit: true,
    supportsRollback: false,
    actionMode: "proposal_and_confirmed_action",
    adapterAvailable: true,
  },
};

export function getConnectorDefinition(key: string): ConnectorDefinition | null {
  return CONNECTOR_KEYS.includes(key as ConnectorKey) ? CONNECTOR_DEFINITIONS[key as ConnectorKey] : null;
}
