const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

export class ApiError extends Error {
  status: number;
  code: string;
  details?: Record<string, unknown>;
  constructor(status: number, code: string, message?: string, details?: Record<string, unknown>) {
    super(message ?? code);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function getToken() {
  return localStorage.getItem("vcuf_token");
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers ?? {}),
    },
  });

  const isJson = res.headers.get("content-type")?.includes("application/json");
  const body = isJson ? await res.json() : undefined;

  if (!res.ok) {
    throw new ApiError(res.status, body?.error ?? "UNKNOWN_ERROR", body?.message, body);
  }
  return body as T;
}

async function download(path: string): Promise<Blob> {
  const token = getToken();
  const res = await fetch(`${API_URL}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) {
    const body = res.headers.get("content-type")?.includes("application/json") ? await res.json() : undefined;
    throw new ApiError(res.status, body?.error ?? "UNKNOWN_ERROR", body?.message, body);
  }
  return res.blob();
}

export interface LoginResponse {
  token: string;
  user: {
    id: string;
    email: string;
    displayName: string;
    role: string;
    permissions: string[];
  };
}

export interface Client {
  id: string;
  displayName: string;
  firstName?: string | null;
  lastName?: string | null;
  companyName?: string | null;
  emailPrimary?: string | null;
  phonePrimary?: string | null;
  clientType?: string | null;
  notes?: string | null;
  source?: string | null;
  createdAt: string;
}

export const CONTACT_CHANNELS = ["email", "phone_call", "whatsapp", "sms", "messenger", "other"] as const;
export type ContactChannel = (typeof CONTACT_CHANNELS)[number];
export const CONTACT_LANGUAGES = ["en", "cs", "pl", "other"] as const;
export type ContactLanguage = (typeof CONTACT_LANGUAGES)[number];

export interface Contact {
  id: string;
  clientId?: string | null;
  displayName: string;
  jobTitle?: string | null;
  department?: string | null;
  email?: string | null;
  phone?: string | null;
  preferredChannel?: ContactChannel | null;
  preferredLanguage?: ContactLanguage | null;
  source: string;
  sourceReference?: string | null;
  notes?: string | null;
  isActive: boolean;
  createdAt: string;
  client?: { id: string; displayName: string } | null;
}

export const DOCUMENT_TYPES = [
  "quote", "contract", "invoice", "receipt", "photo_consent", "employment",
  "certificate", "correspondence", "other",
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];
export const DOCUMENT_SENSITIVITIES = ["normal", "confidential", "personal_data", "financial", "legal"] as const;
export type DocumentSensitivity = (typeof DOCUMENT_SENSITIVITIES)[number];

export interface DocumentRecord {
  id: string;
  clientId?: string | null;
  jobId?: string | null;
  title: string;
  documentType: DocumentType;
  documentReference: string;
  source: string;
  sensitivity: DocumentSensitivity;
  verificationStatus: string;
  issuedAt?: string | null;
  expiresAt?: string | null;
  notes?: string | null;
  isActive: boolean;
  createdAt: string;
  client?: { id: string; displayName: string } | null;
  job?: { id: string; jobTitle: string } | null;
}

export interface IndustryServiceLink {
  id: string;
  industryId: string;
  serviceCatalogueItemId: string;
  notes?: string | null;
  isActive: boolean;
  serviceCatalogueItem: ServiceCatalogueItem;
}

export interface Industry {
  id: string;
  name: string;
  description?: string | null;
  source: string;
  verificationStatus: string;
  notes?: string | null;
  isActive: boolean;
  serviceLinks: IndustryServiceLink[];
}

// Keep in sync with backend/src/lib/actionContracts.ts JOB_STATUSES.
export const JOB_STATUSES = [
  "nova",
  "prijato",
  "naplanovano",
  "v_realizaci",
  "ceka_na_material",
  "ceka_na_klienta",
  "dokonceno",
  "zruseno",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const JOB_STATUS_LABELS: Record<JobStatus, string> = {
  nova: "New",
  prijato: "Accepted",
  naplanovano: "Scheduled",
  v_realizaci: "In progress",
  ceka_na_material: "Waiting for material",
  ceka_na_klienta: "Waiting for client",
  dokonceno: "Completed",
  zruseno: "Cancelled",
};

export interface Job {
  id: string;
  clientId: string;
  jobTitle: string;
  jobStatus: JobStatus;
  propertyAddress?: string | null;
  assignedUserId?: string | null;
  estimatedDurationHours?: number | null;
  requiredSkills?: string[];
  serviceCatalogueItemId?: string | null;
  plannedStartAt?: string | null;
  plannedEndAt?: string | null;
  notes?: string | null;
  createdAt: string;
  client?: { id: string; displayName: string };
  assignedUser?: { id: string; displayName: string } | null;
  serviceCatalogueItem?: { id: string; name: string } | null;
}

// Job Allocation and Capacity Management Module.
export interface CapacityResult {
  employeeId: string;
  employeeName: string;
  weekStart: string;
  weekEnd: string;
  weeklyCapacityHours: number;
  currentLoadHours: number;
  jobsCountedInLoad: number;
  jobsMissingEstimate: number;
  tasksCountedInLoad: number;
  tasksMissingEstimate: number;
  utilizationPct: number;
  overloaded: boolean;
}

export interface Employee {
  id: string;
  displayName: string;
  email: string;
  role: string;
  skills: string[];
  weeklyCapacityHours: number;
  capacity: CapacityResult | null;
}

// Employee and Permission Model — the fuller shape used by management
// screens (create/edit), which also exposes permissions and active status.
export const KNOWN_PERMISSIONS = [
  "crm.read",
  "crm.manage",
  "users.manage",
  "audit.read",
  "voice.execute",
  "recruitment.manage",
  "connectors.read",
  "connectors.manage",
] as const;
export type KnownPermission = (typeof KNOWN_PERMISSIONS)[number];

export interface ManagedEmployee {
  id: string;
  displayName: string;
  email: string;
  role: string;
  permissions: string[];
  skills: string[];
  weeklyCapacityHours: number;
  isActive: boolean;
}

export type ConnectorKey = "gmail" | "google_contacts" | "google_calendar" | "google_drive_photos";

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

export interface ConnectorSource {
  id: string;
  connectorKey: ConnectorKey;
  displayName: string;
  serviceType: ConnectorDefinition["serviceType"];
  configuredScopes: string[];
  connectionStatus: string;
  isEnabled: boolean;
  isActive: boolean;
  lastSyncAt?: string | null;
  lastSyncStatus?: string | null;
  lastErrorCode?: string | null;
  lastFullSyncAt?: string | null;
  credentialReferenceConfigured: boolean;
  authorizationConfigured: boolean;
  incrementalSyncConfigured: boolean;
  definition: ConnectorDefinition;
}

export interface ConnectorOAuthStart {
  authorizationUrl: string;
  expiresAt: string;
}

export interface ConnectorSyncResult {
  sourceId: string;
  mode: "full" | "incremental";
  fallbackFromExpiredHistory: boolean;
  fallbackFromExpiredSyncToken?: boolean;
  importedCount: number;
  skippedCount: number;
  importedIntakeIds: string[];
  upsertedCount?: number;
  deletedCount?: number;
  totalItems?: number | null;
  calendarsSeen?: number;
  eventsUpserted?: number;
  eventsDeleted?: number;
  eventFallbacks?: number;
  nextPageToken: string | null;
  resultSizeEstimate: number | null;
  hasMore: boolean;
  cursorAdvanced: boolean;
  syncedAt: string;
}

export interface ConnectorDisconnectResult {
  sourceId: string;
  provider: "gmail" | "google_contacts" | "google_calendar";
  disconnectedAt: string;
  providerGrantRevoked: boolean;
}

export interface ExternalContact {
  id: string;
  connectorSourceId: string;
  externalResourceName: string;
  displayName?: string | null;
  email?: string | null;
  phone?: string | null;
  organisation?: string | null;
  jobTitle?: string | null;
  department?: string | null;
  isDeleted: boolean;
  importedContactId?: string | null;
  importable: boolean;
  syncedAt: string;
}

export interface ExternalContactList {
  items: ExternalContact[];
  total: number;
  offset: number;
  limit: number;
}
export interface ExternalCalendarEvent {
  id: string; summary?: string | null; description?: string | null; location?: string | null;
  startAt?: string | null; endAt?: string | null; startDate?: string | null; endDate?: string | null;
  organiserEmail?: string | null; attendeeEmails: string[]; isDeleted: boolean;
  externalCalendar: { summary: string; timeZone?: string | null; isPrimary: boolean };
}
export interface ExternalCalendarEventList { items: ExternalCalendarEvent[]; total: number; offset: number; limit: number }
export interface DrivePickerToken { accessToken: string; expiresAt: string; appId: string; developerKey: string }
export interface ExternalDriveImage {
  id: string; externalFileId: string; name: string; mimeType: string; webViewLink?: string | null;
  thumbnailLink?: string | null; sizeBytes?: string | null; width?: number | null; height?: number | null;
  portfolioPhotoId?: string | null; stagedAt: string;
}

export interface AssignJobResult {
  job: Job;
  capacityWarning: { type: string; message?: string; [key: string]: unknown } | null;
  missingSkills: string[];
}

export const TASK_STATUSES = ["open", "in_progress", "completed", "cancelled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  completed: "Completed",
  cancelled: "Cancelled",
};

export const TASK_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const TASK_CATEGORIES = [
  "administrative",
  "client_follow_up",
  "job_work",
  "communication",
  "website",
  "recruitment",
  "other",
] as const;
export type TaskCategory = (typeof TASK_CATEGORIES)[number];

export interface SecretaryTask {
  id: string;
  companyId: string;
  clientId?: string | null;
  jobId?: string | null;
  communicationRecordId?: string | null;
  assignedUserId?: string | null;
  title: string;
  description?: string | null;
  taskStatus: TaskStatus;
  priority: TaskPriority;
  category: TaskCategory;
  source: string;
  dueAt?: string | null;
  estimatedDurationHours?: number | null;
  completedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  client?: { id: string; displayName: string } | null;
  job?: { id: string; jobTitle: string } | null;
  communicationRecord?: { id: string; channel: string; summary: string } | null;
  assignedUser?: { id: string; displayName: string } | null;
}

export interface TaskWriteResult {
  task: SecretaryTask;
  capacityWarning: {
    type: "OVERLOAD";
    employeeId: string;
    employeeName: string;
    weekStart: string;
    currentLoadHours: number;
    weeklyCapacityHours: number;
    utilizationPct: number;
  } | null;
}

// Calendar and Scheduling Intelligence Module.
export interface OverloadFinding {
  employeeId: string;
  employeeName: string;
  weekStart: string;
  weekEnd: string;
  weeklyCapacityHours: number;
  currentLoadHours: number;
  utilizationPct: number;
}

export interface OverloadReport {
  generatedAt: string;
  weeksAhead: number;
  overloadedWeeks: OverloadFinding[];
  suggestions: string[];
}

export interface SuggestedEmployee {
  employeeId: string;
  employeeName: string;
  hasAllRequiredSkills: boolean;
  missingSkills: string[];
  earliestAvailableWeekStart: string | null;
  earliestAvailableWeekLoadHours: number | null;
  weeklyCapacityHours: number;
}

// Service Catalogue Module.
export interface ServiceCatalogueItem {
  id: string;
  name: string;
  description?: string | null;
  category?: string | null;
  basePriceMin?: number | null;
  basePriceMax?: number | null;
  priceUnit?: string | null;
  defaultDurationHours?: number | null;
  defaultRequiredSkills: string[];
  source?: string;
  sourceReference?: string | null;
  referenceActivityCode?: string | null;
  referenceRateGbp?: number | null;
  referenceRateUnit?: string | null;
  isActive: boolean;
  createdAt: string;
}

export interface ReferenceActivity {
  industryCode: string;
  industryName: string;
  subtypeCode: string;
  subtypeName: string;
  activityCode: string;
  activityName: string;
  defaultPricingMethod: string;
  rateUnit: string;
  oxfordshireRateGbp: number;
  availablePricingMethods: string[];
  activatedServiceId: string | null;
  activatedServiceIsActive: boolean | null;
}

export interface ReferenceActivityList {
  items: ReferenceActivity[];
  total: number;
  offset: number;
  limit: number;
  industries: Array<{ code: string; name: string }>;
  catalogue: {
    sourceFile: string;
    rawRowCount: number;
    uniqueActivityCount: number;
    duplicateRowCount: number;
    industryCount: number;
    pricingDisclaimer: string;
  };
}

export interface ActivatedReferenceActivity {
  service: ServiceCatalogueItem;
  industry: Industry;
  link: IndustryServiceLink;
}

// Quote, Pricing and Profitability Module. Every price/cost is either typed
// in directly or pulled from a service catalogue entry the user created —
// never invented. Margin is computed on the backend from what was actually
// entered; a null margin means at least one line item has no cost entered
// yet, not that margin is zero.
export const QUOTE_STATUSES = ["draft", "sent", "accepted", "rejected", "expired"] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

export const QUOTE_STATUS_LABELS: Record<QuoteStatus, string> = {
  draft: "Draft",
  sent: "Sent",
  accepted: "Accepted",
  rejected: "Rejected",
  expired: "Expired",
};

export interface QuoteItem {
  id: string;
  serviceCatalogueItemId?: string | null;
  description: string;
  quantity: number;
  unitPrice: number;
  unitCost?: number | null;
}

export interface QuoteItemInput {
  service_catalogue_item_id?: string;
  description: string;
  quantity?: number;
  unit_price: number;
  unit_cost?: number;
}

export interface QuoteTotals {
  subtotal: number;
  costTotal: number;
  costKnown: boolean;
  marginAmount: number | null;
  marginPct: number | null;
}

export interface Quote {
  id: string;
  clientId: string;
  jobId?: string | null;
  title: string;
  quoteStatus: QuoteStatus;
  notes?: string | null;
  validUntil?: string | null;
  createdAt: string;
  items: QuoteItem[];
  totals: QuoteTotals;
  client?: { id: string; displayName: string };
  job?: { id: string; jobTitle: string } | null;
}

export interface MetricsOverview {
  period: { from: string; to: string; days: number };
  comparisonPeriod: { from: string; to: string };
  dataCompleteness: Record<"leadSource" | "quoteServiceLink" | "quoteCost" | "activeJobEstimate" | "activeJobPlannedDate" | "activeJobServiceLink", { complete: number; total: number; pct: number | null }>;
  trends: {
    newLeads: { current: number; previous: number; delta: number };
    quoteCount: { current: number; previous: number; delta: number };
    quoteConversionRatePct: { current: number | null; previous: number | null };
    averageQuoteValueGbp: { current: number | null; previous: number | null };
    completedJobs: { current: number; previous: number; delta: number };
  };
  leads: { newCount: number; convertedCount: number; lostCount: number; sources: { source: string; count: number; convertedCount: number; lostCount: number; conversionRatePct: number | null; lossRatePct: number | null }[] };
  quotes: { count: number; decidedCount: number; acceptedCount: number; conversionRatePct: number | null; averageValueGbp: number | null };
  jobs: { acceptedCount: number; completedCount: number; cancelledCount: number; lostDueToAvailability: { available: false; value: null; reason: string } };
  revenueByService: { rows: { serviceId: string; serviceName: string; acceptedValueGbp: number; lineCount: number; linesWithKnownCost: number; costKnown: boolean; marginGbp: number | null; marginPct: number | null }[]; unlinkedAcceptedValueGbp: number; basis: string };
  capacity: { available: true; weekStart: string | null; weekEnd: string | null; loadHours: number; capacityHours: number; utilizationPct: number | null; overloadedEmployees: number; missingEstimates: number } | { available: false; value: null; reason: string };
  unavailableMetrics: Record<string, string>;
  recommendations: { severity: "info" | "warning"; title: string; evidence: string; action: string }[];
}

// Recruitment and Workforce Expansion Module. Every field is what the user
// typed in — this module never legally hires anyone, sets a wage, or
// confirms employment terms; it only tracks openings/candidates and drafts
// content for the user to review and place manually.
export const JOB_OPENING_STATUSES = ["draft", "open", "closed"] as const;
export type JobOpeningStatus = (typeof JOB_OPENING_STATUSES)[number];

export const JOB_OPENING_URGENCY_LEVELS = ["low", "medium", "high"] as const;
export type JobOpeningUrgency = (typeof JOB_OPENING_URGENCY_LEVELS)[number];

export const CANDIDATE_STAGES = [
  "new",
  "screening",
  "interview",
  "trial_day",
  "offer",
  "hired",
  "rejected",
] as const;
export type CandidateStage = (typeof CANDIDATE_STAGES)[number];

export const CANDIDATE_STAGE_LABELS: Record<CandidateStage, string> = {
  new: "New",
  screening: "Screening",
  interview: "Interview",
  trial_day: "Trial day",
  offer: "Offer",
  hired: "Hired",
  rejected: "Rejected",
};

export interface Candidate {
  id: string;
  jobOpeningId: string;
  name: string;
  email?: string | null;
  phone?: string | null;
  stage: CandidateStage;
  notes?: string | null;
  createdAt: string;
}

export interface JobOpening {
  id: string;
  title: string;
  reason?: string | null;
  urgency: JobOpeningUrgency;
  openingStatus: JobOpeningStatus;
  skillsRequired: string[];
  expectedTasks?: string | null;
  minExperienceYears?: number | null;
  preferredExperienceYears?: number | null;
  languageRequirements: string[];
  availabilityRequirements?: string | null;
  description?: string | null;
  draftAdvertText?: string | null;
  createdAt: string;
  candidates: Candidate[];
}

export interface RecruitmentRecommendation {
  decision: "not_recommended" | "recommend_recruitment_review";
  reason: string;
  recommendation: null | {
    role: string;
    requiredSkills: string[];
    expectedTasks: string[];
    urgency: "medium" | "high";
    fastestRoute: string;
    suggestedOpening: {
      title: string;
      reason: string;
      urgency: "medium" | "high";
      skillsRequired: string[];
      expectedTasks: string | null;
    };
  };
  evidence: {
    weeksAhead: number;
    minimumRepeatedWeeks: number;
    distinctOverloadedWeeks: number;
    overloadedEmployeeWeeks: number;
    affectedEmployees?: string[];
    sourceJobIds?: string[];
    sourceTaskIds?: string[];
  };
  missingData: string[];
}

// Playbook Engine. A playbook is an ordered list of Voice/Text Command Layer
// templates ("create job {job_title} for {client_name}") with {placeholder}
// variables — the exact same syntax you could type into the command bar.
// Running one resolves the placeholders and dispatches each step through the
// same Action Engine a typed command uses, and always shows a preview of
// every resolved step before anything actually executes.
export interface Playbook {
  id: string;
  name: string;
  description?: string | null;
  stepTemplates: string[];
  isActive: boolean;
  createdAt: string;
}

export interface PlaybookStepPreview {
  template: string;
  resolvedText: string;
  interpretedIntent: string;
}

export interface PlaybookRunPreview {
  playbookName: string;
  steps: PlaybookStepPreview[];
}

export interface PlaybookStepResult {
  template: string;
  resolvedText: string;
  intent: string;
  ok: boolean;
  httpStatus: number;
  data?: unknown;
  error?: string;
  message?: string;
}

export interface PlaybookRun {
  id: string;
  playbookId: string;
  variables?: Record<string, string> | null;
  stepResults: PlaybookStepResult[];
  overallOk: boolean;
  createdAt: string;
}

// Learning Engine. Every rule is created from an explicit user statement —
// never inferred — and stays visible, editable and reversible (archive, not
// delete). A rule with aliasFor set is also applied as a real text
// substitution before a command is parsed, so it changes actual behaviour,
// not just a glossary entry.
export const LEARNING_RULE_STATUSES = ["active", "archived"] as const;
export type LearningRuleStatus = (typeof LEARNING_RULE_STATUSES)[number];

export interface LearningRule {
  id: string;
  term: string;
  meaning: string;
  aliasFor?: string | null;
  category?: string | null;
  status: LearningRuleStatus;
  createdAt: string;
}

// Communication Log Module — the manual-entry foundation of the
// Communication Intelligence Module. Every field is exactly what the user
// typed in; there is no email/WhatsApp/SMS connector yet, so nothing here
// is auto-extracted.
export const COMMUNICATION_CHANNELS = [
  "email",
  "whatsapp",
  "sms",
  "phone_call",
  "messenger",
  "portal_chat",
  "web_form",
  "voice_note",
  "in_person",
  "other",
] as const;
export type CommunicationChannel = (typeof COMMUNICATION_CHANNELS)[number];

export const COMMUNICATION_CHANNEL_LABELS: Record<CommunicationChannel, string> = {
  email: "Email",
  whatsapp: "WhatsApp",
  sms: "SMS",
  phone_call: "Phone call",
  messenger: "Messenger",
  portal_chat: "Portal chat",
  web_form: "Web form",
  voice_note: "Voice note",
  in_person: "In person",
  other: "Other",
};

export const COMMUNICATION_DIRECTIONS = ["inbound", "outbound"] as const;
export type CommunicationDirection = (typeof COMMUNICATION_DIRECTIONS)[number];

export const COMMUNICATION_DIRECTION_LABELS: Record<CommunicationDirection, string> = {
  inbound: "Inbound",
  outbound: "Outbound",
};

export interface CommunicationRecord {
  id: string;
  clientId: string;
  jobId?: string | null;
  channel: CommunicationChannel;
  direction: CommunicationDirection;
  summary: string;
  fullText?: string | null;
  occurredAt: string;
  followUpNeeded: boolean;
  followUpDueAt?: string | null;
  createdAt: string;
  client?: { id: string; displayName: string };
  job?: { id: string; jobTitle: string } | null;
}

export interface CommunicationExtraction {
  name: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  postcode: string | null;
  serviceMatches: Array<{ id: string; name: string }>;
  existingClientMatches: Array<{
    id: string;
    displayName: string;
    reasons: Array<"email_match" | "phone_match" | "name_match">;
  }>;
  identityConfidence: "exact_contact_match" | "new_contact" | "uncertain";
  missingFields: string[];
}

export interface CommunicationIntake {
  id: string;
  channel: CommunicationChannel;
  senderName?: string | null;
  senderEmail?: string | null;
  senderPhone?: string | null;
  messageText: string;
  receivedAt: string;
  sourceReference?: string | null;
  intakeStatus: "new" | "extracted" | "converted";
  resolutionNeeded: boolean;
  resolvedAt?: string | null;
  resolvedBy?: string | null;
  extractedData?: CommunicationExtraction | null;
  replyDraft?: string | null;
  clientId?: string | null;
  communicationRecordId?: string | null;
  client?: { id: string; displayName: string } | null;
  communicationRecord?: { id: string; summary: string; followUpNeeded: boolean } | null;
  createdAt: string;
}

export interface CommunicationConversionPreview {
  intakeId: string;
  operation: "link_existing" | "selection_required" | "create_new";
  selectedClient: { id: string; displayName: string } | null;
  possibleClients: CommunicationExtraction["existingClientMatches"];
  newClient: {
    displayName: string;
    emailPrimary: string | null;
    phonePrimary: string | null;
    billingAddressLine1: string | null;
    billingPostcode: string | null;
    source: string;
  } | null;
  communication: {
    channel: CommunicationChannel;
    summary: string;
    originalSourceReference: string | null;
    followUpNeeded: boolean;
  };
}

export interface CommunicationConversionResult {
  client: Client;
  communicationRecord: CommunicationRecord;
  intake: CommunicationIntake;
}

export type EnquiryResolution = "unresolved" | "resolved" | "all";

export interface EnquiryListItem {
  key: string;
  sourceType: "communication_intake" | "communication_record";
  sourceId: string;
  channel: CommunicationChannel;
  senderLabel: string;
  summary: string;
  receivedAt: string;
  sourceReference?: string | null;
  resolutionNeeded: boolean;
  resolvedAt?: string | null;
  followUpDueAt?: string | null;
  overdue: boolean;
  ageDays: number;
  client?: { id: string; displayName: string } | null;
}

export interface CommunicationResolutionResult {
  intake: CommunicationIntake;
  communicationRecord: CommunicationRecord | null;
}

// Notification and Escalation Module — a unified, read-only "things needing
// attention" feed computed from real data already owned by other modules
// (overdue Communication Log follow-ups, capacity overload weeks, expiring
// quotes). Nothing here is invented; acknowledging an item only records
// that it was seen/handled and is fully reversible — it never changes the
// underlying record it points to.
export const NOTIFICATION_TYPES = [
  "unresolved_enquiry",
  "follow_up_due",
  "capacity_overload",
  "quote_expiring",
  "duplicate_client_possible",
  "missing_client_contact_info",
  "portfolio_gap",
  "stale_lead",
  "stuck_job",
  "overdue_task",
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const NOTIFICATION_TYPE_LABELS: Record<NotificationType, string> = {
  unresolved_enquiry: "Unresolved enquiry",
  follow_up_due: "Follow-up due",
  capacity_overload: "Capacity overload",
  quote_expiring: "Quote expiring",
  duplicate_client_possible: "Possible duplicate client",
  missing_client_contact_info: "Missing contact info",
  portfolio_gap: "Portfolio gap",
  stale_lead: "Stale lead",
  stuck_job: "Stuck job",
  overdue_task: "Overdue task",
};

export const NOTIFICATION_SEVERITIES = ["info", "warning", "urgent"] as const;
export type NotificationSeverity = (typeof NOTIFICATION_SEVERITIES)[number];

export interface AttentionItem {
  key: string;
  type: NotificationType;
  severity: NotificationSeverity;
  title: string;
  message: string;
  dueAt?: string | null;
  entity: { type: string; id: string; label?: string };
  acknowledged: boolean;
  acknowledgedAt?: string | null;
}

// Data Quality Engine — read-only, structural duplicate-client and
// missing-contact-info findings computed over real CRM Core client data.
// Nothing here is invented and nothing is ever merged/edited automatically
// — see backend/src/services/dataQualityService.ts.
export type DuplicateMatchReason = "email_match" | "phone_match" | "name_match" | "name_similar";

export interface DuplicateClientGroup {
  clientAId: string;
  clientBId: string;
  clientALabel: string;
  clientBLabel: string;
  reason: DuplicateMatchReason;
  detail: string;
}

export interface MissingContactIssue {
  clientId: string;
  clientLabel: string;
  issue: "missing_contact_method";
  detail: string;
}

export interface DataQualityReport {
  duplicateClientGroups: DuplicateClientGroup[];
  missingContactIssues: MissingContactIssue[];
}

// merge_clients — confirmation-gated (risk 3). A request without
// confirmed:true returns a 409 CONFIRMATION_REQUIRED with this preview
// shape (thrown as ApiError, details.preview); a request with
// confirmed:true performs the merge and returns MergeClientsResult.
export interface MergeClientsPreview {
  primaryClientId: string;
  primaryClientLabel: string;
  duplicateClientId: string;
  duplicateClientLabel: string;
  recordsToRelink: {
    jobs: number;
    quotes: number;
    communicationRecords: number;
    communicationIntakes: number;
    portfolioPhotos: number;
    contacts: number;
    documentRecords: number;
    tasks: number;
  };
  duplicateWillBeArchived: boolean;
}

export interface MergeClientsResult {
  primaryClientId: string;
  duplicateClientId: string;
  relinked: {
    jobs: number;
    quotes: number;
    communicationRecords: number;
    communicationIntakes: number;
    portfolioPhotos: number;
    contacts: number;
    documentRecords: number;
    tasks: number;
  };
  duplicateClient: { id: string; isActive: boolean };
}

// Memory Model — Pattern Detection (read-only). See
// backend/src/services/memoryModelService.ts: candidate patterns are surfaced
// for human review only and never auto-create a Playbook, matching the
// Learning Engine's explicit-correction-only rule.
export interface RepeatedActionPattern {
  actionSequence: string[];
  occurrenceCount: number;
  exampleTimestamps: string[];
}

// Portfolio and Photo Intelligence Module — the manual-entry foundation of a
// future automated photo-selection/website-publishing workflow. There is no
// image upload/storage connector yet: `filename` is just the literal
// filename/reference the user typed in, and `source` is always a value the
// user picked from this fixed list, never guessed. Flipping
// usableForMarketing is only an internal review tag — it does not publish
// anything to a website or social channel by itself.
export const PORTFOLIO_PHOTO_SOURCES = [
  "employee_upload",
  "client_provided",
  "before_after",
  "other",
] as const;
export type PortfolioPhotoSource = (typeof PORTFOLIO_PHOTO_SOURCES)[number];

export const PORTFOLIO_PHOTO_SOURCE_LABELS: Record<PortfolioPhotoSource, string> = {
  employee_upload: "Employee upload",
  client_provided: "Client provided",
  before_after: "Before/after set",
  other: "Other",
};

export const PHOTO_QUALITY_REVIEW_STATUSES = ["unreviewed", "approved", "rejected"] as const;
export const PHOTO_DUPLICATE_REVIEW_STATUSES = ["unreviewed", "unique", "duplicate"] as const;
export const PHOTO_SENSITIVE_DATA_REVIEW_STATUSES = [
  "unreviewed",
  "clear",
  "contains_sensitive_data",
] as const;
export const PHOTO_USAGE_PERMISSION_STATUSES = ["unknown", "not_required", "confirmed", "denied"] as const;

export interface PortfolioPhoto {
  id: string;
  clientId?: string | null;
  jobId?: string | null;
  filename: string;
  caption?: string | null;
  tags: string[];
  takenAt?: string | null;
  source: PortfolioPhotoSource;
  usableForMarketing: boolean;
  usableForMarketingNotes?: string | null;
  qualityReviewStatus: (typeof PHOTO_QUALITY_REVIEW_STATUSES)[number];
  duplicateReviewStatus: (typeof PHOTO_DUPLICATE_REVIEW_STATUSES)[number];
  sensitiveDataReviewStatus: (typeof PHOTO_SENSITIVE_DATA_REVIEW_STATUSES)[number];
  usagePermissionStatus: (typeof PHOTO_USAGE_PERMISSION_STATUSES)[number];
  createdAt: string;
  client?: { id: string; displayName: string } | null;
  job?: { id: string; jobTitle: string; serviceCatalogueItemId?: string | null } | null;
}

export interface PhotoSelectionCandidate {
  photo: PortfolioPhoto;
  reasons: string[];
  blockers: string[];
  isSelected: boolean;
  eligible: boolean;
}

export interface PhotoSelectionWorkspace {
  service: Pick<ServiceCatalogueItem, "id" | "name" | "category" | "isActive">;
  ownProductionOnly: boolean;
  selectedPhotoIds: string[];
  candidates: PhotoSelectionCandidate[];
  limitations: {
    actualImageFilesAvailable: false;
    automatedVisualReviewPerformed: false;
    publishingAvailable: false;
    explanation: string;
  };
}

export interface PhotoSelectionPreview {
  service: Pick<ServiceCatalogueItem, "id" | "name" | "category" | "isActive">;
  ownProductionOnly: boolean;
  requestedPhotos: Array<{ id: string; filename: string; evidence: string[] }>;
  addedPhotoIds: string[];
  removedPhotoIds: string[];
  unchangedPhotoIds: string[];
  reviewNotes: string | null;
  publicationWillOccur: false;
}

// Business Context Layer — structured company knowledge used by future
// Website, Business Growth, Communication and Process Planning workflows.
// These are explicit facts/rules entered by a user or marked with their
// source and verification status; the UI does not generate or infer claims.
export const BUSINESS_CONTEXT_CATEGORIES = [
  "company_profile",
  "industry",
  "activity",
  "region",
  "pricing_rule",
  "work_rule",
  "communication_tone",
  "approval_rule",
  "capacity_rule",
  "website",
  "social_profile",
  "external_profile",
  "marketing_text",
  "document",
  "other",
] as const;
export type BusinessContextCategory = (typeof BUSINESS_CONTEXT_CATEGORIES)[number];

export const BUSINESS_CONTEXT_CATEGORY_LABELS: Record<BusinessContextCategory, string> = {
  company_profile: "Company profile",
  industry: "Industry",
  activity: "Activity",
  region: "Region",
  pricing_rule: "Pricing rule",
  work_rule: "Work rule",
  communication_tone: "Communication tone",
  approval_rule: "Approval rule",
  capacity_rule: "Capacity rule",
  website: "Website",
  social_profile: "Social profile",
  external_profile: "External profile",
  marketing_text: "Marketing text",
  document: "Document",
  other: "Other",
};

export const BUSINESS_CONTEXT_SOURCES = [
  "user_input",
  "confirmed_company_data",
  "crm_record",
  "communication_record",
  "document_reference",
  "external_reference",
] as const;
export type BusinessContextSource = (typeof BUSINESS_CONTEXT_SOURCES)[number];

export const BUSINESS_CONTEXT_SOURCE_LABELS: Record<BusinessContextSource, string> = {
  user_input: "User input",
  confirmed_company_data: "Confirmed company data",
  crm_record: "CRM record",
  communication_record: "Communication record",
  document_reference: "Document reference",
  external_reference: "External reference",
};

export const BUSINESS_CONTEXT_VERIFICATION_STATUSES = [
  "user_entered",
  "confirmed",
  "unverified",
  "needs_review",
] as const;
export type BusinessContextVerificationStatus = (typeof BUSINESS_CONTEXT_VERIFICATION_STATUSES)[number];

export const BUSINESS_CONTEXT_VERIFICATION_LABELS: Record<BusinessContextVerificationStatus, string> = {
  user_entered: "User entered",
  confirmed: "Confirmed",
  unverified: "Unverified",
  needs_review: "Needs review",
};

export interface BusinessContextItem {
  id: string;
  category: BusinessContextCategory;
  label: string;
  value: string;
  source: BusinessContextSource;
  verificationStatus: BusinessContextVerificationStatus;
  notes?: string | null;
  isActive: boolean;
  createdAt: string;
}

// Basic Website Audit — findings are generated only from explicit page
// observations plus real Service Catalogue, confirmed Business Context and
// reviewed Portfolio records. The current slice never crawls or publishes.
export type WebsiteAuditSeverity = "info" | "warning" | "urgent";

export interface WebsiteAuditFinding {
  id: string;
  category: string;
  severity: WebsiteAuditSeverity;
  title: string;
  evidence: string;
  recommendation: string;
  pageUrl?: string | null;
  sourceType: string;
  sourceRecordId?: string | null;
  status: string;
  createdAt: string;
}

export interface WebsiteAudit {
  id: string;
  websiteUrl: string;
  status: string;
  observationSource: string;
  observations: unknown;
  notes?: string | null;
  pageCount: number;
  findingCount: number;
  urgentCount: number;
  warningCount: number;
  infoCount: number;
  createdAt: string;
  findings?: WebsiteAuditFinding[];
  _count?: { findings: number };
}

export const WEBSITE_CONTENT_PROPOSAL_TYPES = [
  "page_title",
  "service_page",
  "contact_section",
  "call_to_action",
  "meta_description",
  "photo_selection",
  "other",
] as const;
export type WebsiteContentProposalType = (typeof WEBSITE_CONTENT_PROPOSAL_TYPES)[number];

export const WEBSITE_CONTENT_PROPOSAL_TYPE_LABELS: Record<WebsiteContentProposalType, string> = {
  page_title: "Page title",
  service_page: "Service page",
  contact_section: "Contact section",
  call_to_action: "Call to action",
  meta_description: "Meta description",
  photo_selection: "Photo selection",
  other: "Other",
};

export type WebsiteContentProposalStatus =
  | "ready_for_review"
  | "approved"
  | "rejected"
  | "published"
  | "verified";

export interface WebsiteContentSourceSnapshot {
  websiteAudit?: {
    id: string;
    websiteUrl: string;
    findingCount: number;
    urgentCount: number;
    warningCount: number;
    infoCount: number;
  } | null;
  businessContext: Array<{
    id: string;
    category: string;
    label: string;
    value: string;
    source: string;
    verificationStatus: string;
  }>;
  services: Array<{ id: string; name: string; description?: string | null; category?: string | null }>;
  photos: Array<{
    id: string;
    filename: string;
    caption?: string | null;
    tags: string[];
    source: string;
    usableForMarketingNotes?: string | null;
  }>;
  auditFindings: Array<{
    id: string;
    title: string;
    severity: WebsiteAuditSeverity;
    evidence: string;
    recommendation: string;
  }>;
}

export interface WebsiteContentProposal {
  id: string;
  websiteAuditId?: string | null;
  proposalType: WebsiteContentProposalType;
  targetPageUrl: string;
  headline?: string | null;
  contentBody: string;
  status: WebsiteContentProposalStatus;
  sourceSnapshot: WebsiteContentSourceSnapshot;
  notes?: string | null;
  decisionNotes?: string | null;
  reviewedBy?: string | null;
  reviewedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  websiteAudit?: {
    id: string;
    websiteUrl: string;
    findingCount: number;
    urgentCount: number;
    warningCount: number;
    infoCount: number;
  } | null;
}

export interface WebsiteContentProposalDecisionPreview {
  proposalId: string;
  proposalType: WebsiteContentProposalType;
  targetPageUrl: string;
  headline?: string | null;
  currentStatus: WebsiteContentProposalStatus;
  proposedStatus: "approved" | "rejected";
  contentBody: string;
  sourceCounts: {
    websiteAudit: number;
    businessContext: number;
    services: number;
    photos: number;
    auditFindings: number;
  };
}

export const LEAD_STATUSES = ["new", "contacted", "qualified", "converted", "lost"] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export const LEAD_STATUS_LABELS: Record<LeadStatus, string> = {
  new: "New",
  contacted: "Contacted",
  qualified: "Qualified",
  converted: "Converted",
  lost: "Lost",
};

export interface Lead {
  id: string;
  name: string;
  phone?: string | null;
  email?: string | null;
  serviceRequested?: string | null;
  location?: string | null;
  source?: string | null;
  urgency?: string | null;
  leadStatus: LeadStatus;
  notes?: string | null;
  convertedClientId?: string | null;
  createdAt: string;
}

export const api = {
  metrics: {
    overview: (params?: { from?: string; to?: string }) => {
      const qs = new URLSearchParams();
      if (params?.from) qs.set("from", params.from);
      if (params?.to) qs.set("to", params.to);
      return request<MetricsOverview>(`/metrics/overview${qs.size ? `?${qs}` : ""}`);
    },
  },
  login: (email: string, password: string) =>
    request<LoginResponse>("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }),
  me: () => request<LoginResponse["user"]>("/auth/me"),
  clients: {
    list: () => request<Client[]>("/crm/clients"),
    get: (id: string) => request<Client>(`/crm/clients/${id}`),
    create: (data: Record<string, unknown>) =>
      request<Client>("/crm/clients", { method: "POST", body: JSON.stringify(data) }),
    search: (q: string) => request<Client[]>(`/crm/clients/search?q=${encodeURIComponent(q)}`),
  },
  contacts: {
    list: (params?: { clientId?: string; activeOnly?: boolean; search?: string }) => {
      const qs = new URLSearchParams();
      if (params?.clientId) qs.set("client_id", params.clientId);
      if (params?.activeOnly) qs.set("active_only", "true");
      if (params?.search) qs.set("search", params.search);
      const suffix = qs.toString() ? `?${qs.toString()}` : "";
      return request<Contact[]>(`/crm/contacts${suffix}`);
    },
    get: (id: string) => request<Contact>(`/crm/contacts/${id}`),
    create: (data: Record<string, unknown>) =>
      request<Contact>("/crm/contacts", { method: "POST", body: JSON.stringify(data) }),
    update: (id: string, data: Record<string, unknown>) =>
      request<Contact>(`/crm/contacts/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  },
  documents: {
    list: (params?: { clientId?: string; jobId?: string; documentType?: string; sensitivity?: string; activeOnly?: boolean }) => {
      const qs = new URLSearchParams();
      if (params?.clientId) qs.set("client_id", params.clientId);
      if (params?.jobId) qs.set("job_id", params.jobId);
      if (params?.documentType) qs.set("document_type", params.documentType);
      if (params?.sensitivity) qs.set("sensitivity", params.sensitivity);
      if (params?.activeOnly) qs.set("active_only", "true");
      const suffix = qs.toString() ? `?${qs.toString()}` : "";
      return request<DocumentRecord[]>(`/documents${suffix}`);
    },
    get: (id: string) => request<DocumentRecord>(`/documents/${id}`),
    create: (data: Record<string, unknown>) =>
      request<DocumentRecord>("/documents", { method: "POST", body: JSON.stringify(data) }),
    update: (id: string, data: Record<string, unknown>) =>
      request<DocumentRecord>(`/documents/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  },
  industries: {
    list: (activeOnly?: boolean) => request<Industry[]>(`/industries${activeOnly ? "?active_only=true" : ""}`),
    get: (id: string) => request<Industry>(`/industries/${id}`),
    create: (data: Record<string, unknown>) =>
      request<Industry>("/industries", { method: "POST", body: JSON.stringify(data) }),
    update: (id: string, data: Record<string, unknown>) =>
      request<Industry>(`/industries/${id}`, { method: "PUT", body: JSON.stringify(data) }),
    linkService: (id: string, serviceCatalogueItemId: string, notes?: string) =>
      request<IndustryServiceLink>(`/industries/${id}/services`, {
        method: "POST", body: JSON.stringify({ service_catalogue_item_id: serviceCatalogueItemId, notes }),
      }),
    updateServiceLink: (linkId: string, data: Record<string, unknown>) =>
      request<IndustryServiceLink>(`/industries/service-links/${linkId}`, { method: "PUT", body: JSON.stringify(data) }),
  },
  connectors: {
    definitions: () => request<ConnectorDefinition[]>("/connectors/definitions"),
    sources: (activeOnly?: boolean) =>
      request<ConnectorSource[]>(`/connectors/sources${activeOnly ? "?active_only=true" : ""}`),
    getSource: (id: string) => request<ConnectorSource>(`/connectors/sources/${id}`),
    registerSource: (data: Record<string, unknown>) =>
      request<ConnectorSource>("/connectors/sources", { method: "POST", body: JSON.stringify(data) }),
    updateSource: (id: string, data: Record<string, unknown>) =>
      request<ConnectorSource>(`/connectors/sources/${id}`, { method: "PUT", body: JSON.stringify(data) }),
    disableSource: (id: string) =>
      request<ConnectorSource>(`/connectors/sources/${id}/disable`, { method: "POST", body: "{}" }),
    enableSource: (id: string, confirmed: boolean) =>
      request<ConnectorSource>(`/connectors/sources/${id}/enable`, {
        method: "POST",
        body: JSON.stringify({ confirmed }),
      }),
    startOAuth: (id: string) =>
      request<ConnectorOAuthStart>(`/connectors/sources/${id}/oauth/start`, { method: "POST", body: "{}" }),
    syncSource: (
      id: string,
      data: { max_results?: number; query?: string; page_token?: string; full_sync?: boolean } = {}
    ) =>
      request<ConnectorSyncResult>(`/connectors/sources/${id}/sync`, {
        method: "POST",
        body: JSON.stringify(data),
      }),
    disconnectSource: (id: string, confirmed: boolean) =>
      request<ConnectorDisconnectResult>(`/connectors/sources/${id}/disconnect`, {
        method: "POST",
        body: JSON.stringify({ confirmed }),
      }),
    externalContacts: (id: string) =>
      request<ExternalContactList>(`/connectors/sources/${id}/external-contacts?active_only=true&limit=100`),
    importExternalContact: (sourceId: string, externalContactId: string, confirmed: boolean) =>
      request<Contact>(`/connectors/sources/${sourceId}/external-contacts/${externalContactId}/import`, {
        method: "POST",
        body: JSON.stringify({ confirmed }),
      }),
    externalCalendarEvents: (id: string) =>
      request<ExternalCalendarEventList>(`/connectors/sources/${id}/external-calendar-events?limit=100`),
    drivePickerToken: (id: string) => request<DrivePickerToken>(`/connectors/sources/${id}/drive-picker-token`),
    stageDriveImages: (id: string, fileIds: string[]) =>
      request<{ items: ExternalDriveImage[] }>(`/connectors/sources/${id}/drive-images/stage`, { method: "POST", body: JSON.stringify({ file_ids: fileIds }) }),
    driveImages: (id: string) => request<ExternalDriveImage[]>(`/connectors/sources/${id}/drive-images`),
    registerDrivePhoto: (sourceId: string, imageId: string, confirmed: boolean) =>
      request<PortfolioPhoto>(`/connectors/sources/${sourceId}/drive-images/${imageId}/register`, { method: "POST", body: JSON.stringify({ confirmed }) }),
  },
  jobs: {
    list: (params?: { clientId?: string; status?: string }) => {
      const qs = new URLSearchParams();
      if (params?.clientId) qs.set("client_id", params.clientId);
      if (params?.status) qs.set("status", params.status);
      const suffix = qs.toString() ? `?${qs.toString()}` : "";
      return request<Job[]>(`/crm/jobs${suffix}`);
    },
    get: (id: string) => request<Job>(`/crm/jobs/${id}`),
    create: (data: Record<string, unknown>) =>
      request<Job>("/crm/jobs", { method: "POST", body: JSON.stringify(data) }),
    changeStatus: (id: string, jobStatus: JobStatus) =>
      request<Job>(`/crm/jobs/${id}`, { method: "PUT", body: JSON.stringify({ job_status: jobStatus }) }),
    assign: (id: string, assignedUserId: string) =>
      request<AssignJobResult>(`/crm/jobs/${id}/assign`, {
        method: "PUT",
        body: JSON.stringify({ assigned_user_id: assignedUserId }),
      }),
  },
  employees: {
    list: () => request<Employee[]>("/crm/employees"),
    get: (id: string) => request<Employee>(`/crm/employees/${id}`),
    capacity: (id: string, week?: string) =>
      request<CapacityResult>(`/crm/employees/${id}/capacity${week ? `?week=${encodeURIComponent(week)}` : ""}`),
    getManaged: (id: string) => request<ManagedEmployee>(`/crm/employees/${id}/manage`),
    permissions: () => request<string[]>("/crm/employees/meta/permissions"),
    create: (data: Record<string, unknown>) =>
      request<ManagedEmployee>("/crm/employees", { method: "POST", body: JSON.stringify(data) }),
    update: (id: string, data: Record<string, unknown>) =>
      request<ManagedEmployee>(`/crm/employees/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  },
  calendar: {
    jobs: (from: string, to: string) =>
      request<Job[]>(`/calendar/jobs?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
    tasks: (from: string, to: string) =>
      request<SecretaryTask[]>(`/calendar/tasks?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
    overload: (weeksAhead?: number) =>
      request<OverloadReport>(`/calendar/overload${weeksAhead ? `?weeks_ahead=${weeksAhead}` : ""}`),
    suggest: (params: { estimatedDurationHours?: number; requiredSkills?: string[]; weeksAhead?: number }) => {
      const qs = new URLSearchParams();
      if (params.estimatedDurationHours) qs.set("estimated_duration_hours", String(params.estimatedDurationHours));
      if (params.requiredSkills && params.requiredSkills.length > 0)
        qs.set("required_skills", params.requiredSkills.join(","));
      if (params.weeksAhead) qs.set("weeks_ahead", String(params.weeksAhead));
      const suffix = qs.toString() ? `?${qs.toString()}` : "";
      return request<SuggestedEmployee[]>(`/calendar/suggest${suffix}`);
    },
  },
  tasks: {
    list: (params?: {
      status?: string;
      priority?: string;
      assignedUserId?: string;
      clientId?: string;
      jobId?: string;
      overdue?: boolean;
    }) => {
      const qs = new URLSearchParams();
      if (params?.status) qs.set("status", params.status);
      if (params?.priority) qs.set("priority", params.priority);
      if (params?.assignedUserId) qs.set("assigned_user_id", params.assignedUserId);
      if (params?.clientId) qs.set("client_id", params.clientId);
      if (params?.jobId) qs.set("job_id", params.jobId);
      if (params?.overdue) qs.set("overdue", "true");
      const suffix = qs.toString() ? `?${qs.toString()}` : "";
      return request<SecretaryTask[]>(`/tasks${suffix}`);
    },
    get: (id: string) => request<SecretaryTask>(`/tasks/${id}`),
    create: (data: Record<string, unknown>) =>
      request<TaskWriteResult>("/tasks", { method: "POST", body: JSON.stringify(data) }),
    update: (id: string, data: Record<string, unknown>) =>
      request<TaskWriteResult>(`/tasks/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  },
  catalogue: {
    list: (activeOnly?: boolean) =>
      request<ServiceCatalogueItem[]>(`/service-catalogue${activeOnly ? "?active_only=true" : ""}`),
    get: (id: string) => request<ServiceCatalogueItem>(`/service-catalogue/${id}`),
    create: (data: Record<string, unknown>) =>
      request<ServiceCatalogueItem>("/service-catalogue", { method: "POST", body: JSON.stringify(data) }),
    update: (id: string, data: Record<string, unknown>) =>
      request<ServiceCatalogueItem>(`/service-catalogue/${id}`, { method: "PUT", body: JSON.stringify(data) }),
    referenceActivities: (params?: { search?: string; industryCode?: string; offset?: number; limit?: number }) => {
      const qs = new URLSearchParams();
      if (params?.search) qs.set("search", params.search);
      if (params?.industryCode) qs.set("industry_code", params.industryCode);
      if (params?.offset !== undefined) qs.set("offset", String(params.offset));
      if (params?.limit !== undefined) qs.set("limit", String(params.limit));
      const suffix = qs.toString() ? `?${qs.toString()}` : "";
      return request<ReferenceActivityList>(`/service-catalogue/reference-activities${suffix}`);
    },
    activateReferenceActivity: (activityCode: string, data: Record<string, unknown>) =>
      request<ActivatedReferenceActivity>(
        `/service-catalogue/reference-activities/${encodeURIComponent(activityCode)}/activate`,
        { method: "POST", body: JSON.stringify(data) }
      ),
  },
  quotes: {
    list: (params?: { clientId?: string; jobId?: string; status?: string }) => {
      const qs = new URLSearchParams();
      if (params?.clientId) qs.set("client_id", params.clientId);
      if (params?.jobId) qs.set("job_id", params.jobId);
      if (params?.status) qs.set("status", params.status);
      const suffix = qs.toString() ? `?${qs.toString()}` : "";
      return request<Quote[]>(`/quotes${suffix}`);
    },
    get: (id: string) => request<Quote>(`/quotes/${id}`),
    downloadPdf: (id: string) => download(`/quotes/${id}/pdf`),
    create: (data: { client_id: string; job_id?: string; title: string; notes?: string; valid_until?: string; items: QuoteItemInput[] }) =>
      request<Quote>("/quotes", { method: "POST", body: JSON.stringify(data) }),
    update: (
      id: string,
      data: { title?: string; notes?: string; valid_until?: string | null; items?: QuoteItemInput[] }
    ) => request<Quote>(`/quotes/${id}`, { method: "PUT", body: JSON.stringify(data) }),
    changeStatus: (id: string, quoteStatus: QuoteStatus) =>
      request<Quote>(`/quotes/${id}/status`, { method: "PUT", body: JSON.stringify({ quote_status: quoteStatus }) }),
  },
  recruitment: {
    capacityRecommendation: (weeksAhead = 6, minimumRepeatedWeeks = 2) =>
      request<RecruitmentRecommendation>(
        `/recruitment/capacity-recommendation?weeks_ahead=${weeksAhead}&minimum_repeated_weeks=${minimumRepeatedWeeks}`
      ),
    listJobOpenings: (status?: string) =>
      request<JobOpening[]>(`/recruitment/job-openings${status ? `?status=${status}` : ""}`),
    getJobOpening: (id: string) => request<JobOpening>(`/recruitment/job-openings/${id}`),
    createJobOpening: (data: Record<string, unknown>) =>
      request<JobOpening>("/recruitment/job-openings", { method: "POST", body: JSON.stringify(data) }),
    updateJobOpening: (id: string, data: Record<string, unknown>) =>
      request<JobOpening>(`/recruitment/job-openings/${id}`, { method: "PUT", body: JSON.stringify(data) }),
    draftAdvert: (id: string) =>
      request<JobOpening>(`/recruitment/job-openings/${id}/draft-advert`, { method: "POST" }),
    createCandidate: (jobOpeningId: string, data: Record<string, unknown>) =>
      request<Candidate>(`/recruitment/job-openings/${jobOpeningId}/candidates`, {
        method: "POST",
        body: JSON.stringify(data),
      }),
    updateCandidate: (id: string, data: Record<string, unknown>) =>
      request<Candidate>(`/recruitment/candidates/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  },
  playbooks: {
    list: (activeOnly?: boolean) => request<Playbook[]>(`/playbooks${activeOnly ? "?active_only=true" : ""}`),
    get: (id: string) => request<Playbook>(`/playbooks/${id}`),
    create: (data: { name: string; description?: string; step_templates: string[] }) =>
      request<Playbook>("/playbooks", { method: "POST", body: JSON.stringify(data) }),
    update: (id: string, data: Record<string, unknown>) =>
      request<Playbook>(`/playbooks/${id}`, { method: "PUT", body: JSON.stringify(data) }),
    run: (id: string, variables: Record<string, string>, confirmed?: boolean) =>
      request<PlaybookRun>(`/playbooks/${id}/run`, {
        method: "POST",
        body: JSON.stringify({ variables, confirmed }),
      }),
    runs: (id: string) => request<PlaybookRun[]>(`/playbooks/${id}/runs`),
  },
  learningRules: {
    list: (status?: string) => request<LearningRule[]>(`/learning-rules${status ? `?status=${status}` : ""}`),
    get: (id: string) => request<LearningRule>(`/learning-rules/${id}`),
    create: (data: { term: string; meaning: string; alias_for?: string; category?: string }) =>
      request<LearningRule>("/learning-rules", { method: "POST", body: JSON.stringify(data) }),
    update: (id: string, data: Record<string, unknown>) =>
      request<LearningRule>(`/learning-rules/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  },
  leads: {
    list: (params?: { status?: string }) => {
      const qs = new URLSearchParams();
      if (params?.status) qs.set("status", params.status);
      const suffix = qs.toString() ? `?${qs.toString()}` : "";
      return request<Lead[]>(`/crm/leads${suffix}`);
    },
    get: (id: string) => request<Lead>(`/crm/leads/${id}`),
    create: (data: Record<string, unknown>) =>
      request<Lead>("/crm/leads", { method: "POST", body: JSON.stringify(data) }),
    convert: (id: string) =>
      request<{ lead: Lead; client: Client }>(`/crm/leads/${id}/convert`, { method: "POST" }),
  },
  communications: {
    enquiries: (params?: { resolution?: EnquiryResolution; since?: string; channel?: string }) => {
      const qs = new URLSearchParams();
      if (params?.resolution) qs.set("resolution", params.resolution);
      if (params?.since) qs.set("since", params.since);
      if (params?.channel) qs.set("channel", params.channel);
      const suffix = qs.toString() ? `?${qs.toString()}` : "";
      return request<EnquiryListItem[]>(`/communications/enquiries${suffix}`);
    },
    list: (params?: { clientId?: string; jobId?: string; channel?: string; followUpNeeded?: boolean }) => {
      const qs = new URLSearchParams();
      if (params?.clientId) qs.set("client_id", params.clientId);
      if (params?.jobId) qs.set("job_id", params.jobId);
      if (params?.channel) qs.set("channel", params.channel);
      if (params?.followUpNeeded !== undefined) qs.set("follow_up_needed", String(params.followUpNeeded));
      const suffix = qs.toString() ? `?${qs.toString()}` : "";
      return request<CommunicationRecord[]>(`/communications${suffix}`);
    },
    get: (id: string) => request<CommunicationRecord>(`/communications/${id}`),
    create: (data: Record<string, unknown>) =>
      request<CommunicationRecord>("/communications", { method: "POST", body: JSON.stringify(data) }),
    update: (id: string, data: Record<string, unknown>) =>
      request<CommunicationRecord>(`/communications/${id}`, { method: "PUT", body: JSON.stringify(data) }),
    followUpsDue: () => request<CommunicationRecord[]>("/communications/follow-ups-due"),
    intakes: {
      list: (status?: string) =>
        request<CommunicationIntake[]>(`/communications/intakes${status ? `?status=${encodeURIComponent(status)}` : ""}`),
      get: (id: string) => request<CommunicationIntake>(`/communications/intakes/${id}`),
      create: (data: Record<string, unknown>) =>
        request<CommunicationIntake>("/communications/intakes", { method: "POST", body: JSON.stringify(data) }),
      extract: (id: string) =>
        request<CommunicationIntake>(`/communications/intakes/${id}/extract`, { method: "POST" }),
      convert: (id: string, confirmed: boolean, clientId?: string) =>
        request<CommunicationConversionResult>(`/communications/intakes/${id}/convert`, {
          method: "POST",
          body: JSON.stringify({ confirmed, client_id: clientId || undefined }),
        }),
      draftReply: (id: string) =>
        request<CommunicationIntake>(`/communications/intakes/${id}/reply-draft`, { method: "POST" }),
      setResolution: (id: string, resolutionNeeded: boolean) =>
        request<CommunicationResolutionResult>(`/communications/intakes/${id}/resolution`, {
          method: "PUT",
          body: JSON.stringify({ resolution_needed: resolutionNeeded }),
        }),
    },
  },
  notifications: {
    feed: (includeAcknowledged?: boolean) =>
      request<AttentionItem[]>(`/notifications${includeAcknowledged ? "?include_acknowledged=true" : ""}`),
    acknowledge: (notificationKey: string) =>
      request<unknown>("/notifications/acknowledge", {
        method: "POST",
        body: JSON.stringify({ notification_key: notificationKey }),
      }),
    unacknowledge: (notificationKey: string) =>
      request<unknown>(`/notifications/${encodeURIComponent(notificationKey)}/unacknowledge`, { method: "POST" }),
  },
  dataQuality: {
    report: () => request<DataQualityReport>("/data-quality"),
    // Same confirm-preview pattern as employees.create/update: call without
    // confirmed (or confirmed:false) first — the backend throws ApiError
    // with code CONFIRMATION_REQUIRED and details.preview; call again with
    // confirmed:true to actually perform the merge.
    mergeClients: (primaryClientId: string, duplicateClientId: string, confirmed: boolean) =>
      request<MergeClientsResult>("/data-quality/merge-clients", {
        method: "POST",
        body: JSON.stringify({
          primary_client_id: primaryClientId,
          duplicate_client_id: duplicateClientId,
          confirmed,
        }),
      }),
  },
  memoryModel: {
    patterns: () => request<RepeatedActionPattern[]>("/memory-model/patterns"),
  },
  portfolio: {
    list: (params?: { clientId?: string; jobId?: string; tag?: string; usableForMarketing?: boolean; source?: string }) => {
      const qs = new URLSearchParams();
      if (params?.clientId) qs.set("client_id", params.clientId);
      if (params?.jobId) qs.set("job_id", params.jobId);
      if (params?.tag) qs.set("tag", params.tag);
      if (params?.usableForMarketing !== undefined) qs.set("usable_for_marketing", String(params.usableForMarketing));
      if (params?.source) qs.set("source", params.source);
      const suffix = qs.toString() ? `?${qs.toString()}` : "";
      return request<PortfolioPhoto[]>(`/portfolio${suffix}`);
    },
    get: (id: string) => request<PortfolioPhoto>(`/portfolio/${id}`),
    create: (data: Record<string, unknown>) =>
      request<PortfolioPhoto>("/portfolio", { method: "POST", body: JSON.stringify(data) }),
    update: (id: string, data: Record<string, unknown>) =>
      request<PortfolioPhoto>(`/portfolio/${id}`, { method: "PUT", body: JSON.stringify(data) }),
    selectionWorkspace: (serviceCatalogueItemId: string, ownProductionOnly: boolean) => {
      const qs = new URLSearchParams({
        service_catalogue_item_id: serviceCatalogueItemId,
        own_production_only: String(ownProductionOnly),
      });
      return request<PhotoSelectionWorkspace>(`/portfolio/service-selection/workspace?${qs.toString()}`);
    },
    selectForService: (data: {
      service_catalogue_item_id: string;
      photo_ids: string[];
      own_production_only: boolean;
      review_notes?: string;
      confirmed: boolean;
    }) =>
      request<PhotoSelectionWorkspace>("/portfolio/service-selection", {
        method: "POST",
        body: JSON.stringify(data),
      }),
  },
  businessContext: {
    list: (params?: { category?: string; activeOnly?: boolean }) => {
      const qs = new URLSearchParams();
      if (params?.category) qs.set("category", params.category);
      if (params?.activeOnly) qs.set("active_only", "true");
      const suffix = qs.toString() ? `?${qs.toString()}` : "";
      return request<BusinessContextItem[]>(`/business-context${suffix}`);
    },
    get: (id: string) => request<BusinessContextItem>(`/business-context/${id}`),
    create: (data: Record<string, unknown>) =>
      request<BusinessContextItem>("/business-context", { method: "POST", body: JSON.stringify(data) }),
    update: (id: string, data: Record<string, unknown>) =>
      request<BusinessContextItem>(`/business-context/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  },
  websiteAudits: {
    list: () => request<WebsiteAudit[]>("/website-audits"),
    get: (id: string) => request<WebsiteAudit>(`/website-audits/${id}`),
    create: (data: Record<string, unknown>) =>
      request<WebsiteAudit>("/website-audits", { method: "POST", body: JSON.stringify(data) }),
  },
  websiteContentProposals: {
    list: (status?: string) =>
      request<WebsiteContentProposal[]>(
        `/website-content-proposals${status ? `?status=${encodeURIComponent(status)}` : ""}`
      ),
    get: (id: string) => request<WebsiteContentProposal>(`/website-content-proposals/${id}`),
    create: (data: Record<string, unknown>) =>
      request<WebsiteContentProposal>("/website-content-proposals", {
        method: "POST",
        body: JSON.stringify(data),
      }),
    decide: (id: string, decision: "approved" | "rejected", decisionNotes: string, confirmed: boolean) =>
      request<WebsiteContentProposal>(`/website-content-proposals/${id}/decision`, {
        method: "POST",
        body: JSON.stringify({
          decision,
          decision_notes: decisionNotes || undefined,
          confirmed,
        }),
      }),
  },
  command: {
    text: (text: string, inputMethod: "text" | "voice_transcript" = "text") =>
      request<{
        intent: string;
        interpreted: unknown;
        ok: boolean;
        data?: unknown;
        error?: string;
        message?: string;
      }>("/command/text", {
        method: "POST",
        body: JSON.stringify({ text, input_method: inputMethod }),
      }),
  },
};

export { getToken };
export function setToken(token: string | null) {
  if (token) localStorage.setItem("vcuf_token", token);
  else localStorage.removeItem("vcuf_token");
}
