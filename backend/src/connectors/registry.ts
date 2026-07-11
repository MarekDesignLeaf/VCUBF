export const CONNECTOR_KEYS = ["gmail", "google_contacts", "google_calendar", "google_drive_photos"] as const;
export type ConnectorKey = (typeof CONNECTOR_KEYS)[number];

export interface ConnectorDefinition {
  key: ConnectorKey;
  serviceName: string;
  serviceType: "email" | "contacts" | "calendar" | "photo_storage";
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
    canWrite: [],
    logicalScopes: ["read:messages"],
    requiredPermissions: ["connectors.read", "connectors.manage"],
    returnedDataTypes: ["communication intake", "thread reference"],
    supportedActions: ["authorize read-only access", "synchronise messages into communication intake"],
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
    canWrite: ["confirmed contact records"],
    logicalScopes: ["read:contacts", "write:contacts"],
    requiredPermissions: ["connectors.read", "connectors.manage", "crm.read", "crm.manage"],
    returnedDataTypes: ["external contact", "external contact source reference"],
    supportedActions: ["list contacts", "read contact", "propose CRM match", "write confirmed contact"],
    possibleErrors: ["AUTHORIZATION_REQUIRED", "SCOPE_DENIED", "RATE_LIMITED", "PROVIDER_UNAVAILABLE", "CONTACT_NOT_FOUND"],
    supportsAudit: true,
    supportsRollback: false,
    actionMode: "proposal_and_confirmed_action",
    adapterAvailable: false,
  },
  google_calendar: {
    key: "google_calendar",
    serviceName: "Google Calendar Connector",
    serviceType: "calendar",
    canRead: ["calendar metadata", "event time", "event attendees", "availability"],
    canWrite: ["confirmed calendar events", "confirmed event updates"],
    logicalScopes: ["read:calendars", "read:events", "write:events"],
    requiredPermissions: ["connectors.read", "connectors.manage", "crm.read", "crm.manage"],
    returnedDataTypes: ["calendar", "calendar event", "availability interval"],
    supportedActions: ["list calendars", "read events", "check availability", "write confirmed event"],
    possibleErrors: ["AUTHORIZATION_REQUIRED", "SCOPE_DENIED", "RATE_LIMITED", "PROVIDER_UNAVAILABLE", "EVENT_NOT_FOUND", "CALENDAR_CONFLICT"],
    supportsAudit: true,
    supportsRollback: false,
    actionMode: "proposal_and_confirmed_action",
    adapterAvailable: false,
  },
  google_drive_photos: {
    key: "google_drive_photos",
    serviceName: "Google Drive Photo Storage Connector",
    serviceType: "photo_storage",
    canRead: ["file metadata", "folder metadata", "image file references"],
    canWrite: ["confirmed image files", "confirmed folder metadata"],
    logicalScopes: ["read:file_metadata", "read:image_files", "write:image_files"],
    requiredPermissions: ["connectors.read", "connectors.manage", "crm.read", "crm.manage"],
    returnedDataTypes: ["photo file reference", "folder reference", "file metadata"],
    supportedActions: ["list photo files", "read photo metadata", "register photo reference", "write confirmed photo file"],
    possibleErrors: ["AUTHORIZATION_REQUIRED", "SCOPE_DENIED", "RATE_LIMITED", "PROVIDER_UNAVAILABLE", "FILE_NOT_FOUND", "STORAGE_LIMIT_REACHED"],
    supportsAudit: true,
    supportsRollback: false,
    actionMode: "proposal_and_confirmed_action",
    adapterAvailable: false,
  },
};

export function getConnectorDefinition(key: string): ConnectorDefinition | null {
  return CONNECTOR_KEYS.includes(key as ConnectorKey) ? CONNECTOR_DEFINITIONS[key as ConnectorKey] : null;
}
