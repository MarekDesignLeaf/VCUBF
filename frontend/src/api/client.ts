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

// Keep in sync with backend/src/lib/actionContracts.ts JOB_STATUSES.
export const JOB_STATUSES = [
  "nova",
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

export interface AssignJobResult {
  job: Job;
  capacityWarning: { type: string; message?: string; [key: string]: unknown } | null;
  missingSkills: string[];
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
  isActive: boolean;
  createdAt: string;
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

// Notification and Escalation Module — a unified, read-only "things needing
// attention" feed computed from real data already owned by other modules
// (overdue Communication Log follow-ups, capacity overload weeks, expiring
// quotes). Nothing here is invented; acknowledging an item only records
// that it was seen/handled and is fully reversible — it never changes the
// underlying record it points to.
export const NOTIFICATION_TYPES = [
  "follow_up_due",
  "capacity_overload",
  "quote_expiring",
  "duplicate_client_possible",
  "missing_client_contact_info",
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const NOTIFICATION_TYPE_LABELS: Record<NotificationType, string> = {
  follow_up_due: "Follow-up due",
  capacity_overload: "Capacity overload",
  quote_expiring: "Quote expiring",
  duplicate_client_possible: "Possible duplicate client",
  missing_client_contact_info: "Missing contact info",
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
    portfolioPhotos: number;
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
    portfolioPhotos: number;
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
  createdAt: string;
  client?: { id: string; displayName: string } | null;
  job?: { id: string; jobTitle: string } | null;
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
  catalogue: {
    list: (activeOnly?: boolean) =>
      request<ServiceCatalogueItem[]>(`/service-catalogue${activeOnly ? "?active_only=true" : ""}`),
    get: (id: string) => request<ServiceCatalogueItem>(`/service-catalogue/${id}`),
    create: (data: Record<string, unknown>) =>
      request<ServiceCatalogueItem>("/service-catalogue", { method: "POST", body: JSON.stringify(data) }),
    update: (id: string, data: Record<string, unknown>) =>
      request<ServiceCatalogueItem>(`/service-catalogue/${id}`, { method: "PUT", body: JSON.stringify(data) }),
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
  },
  command: {
    text: (text: string) =>
      request<{
        intent: string;
        interpreted: unknown;
        ok: boolean;
        data?: unknown;
        error?: string;
        message?: string;
      }>("/command/text", { method: "POST", body: JSON.stringify({ text }) }),
  },
};

export { getToken };
export function setToken(token: string | null) {
  if (token) localStorage.setItem("vcuf_token", token);
  else localStorage.removeItem("vcuf_token");
}
