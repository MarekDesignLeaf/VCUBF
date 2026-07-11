/**
 * Action Contracts — every executable action in VCUF must declare one.
 * See vcubf-programmer-skill "Action Contract rule".
 * This is structured data, not a prompt — business rules live here, not in an LLM.
 */
export interface ActionContract {
  actionName: string;
  purpose: string;
  requiredPermission: string;
  riskLevel: 0 | 1 | 2 | 3 | 4 | 5;
  confirmationRequired: boolean;
  dataSources: string[];
  possibleErrors: string[];
}

export const CREATE_CLIENT_ACTION: ActionContract = {
  actionName: "create_client",
  purpose: "Create a new client record in CRM Core from a verified or manually entered source.",
  requiredPermission: "crm.manage",
  riskLevel: 2,
  confirmationRequired: false,
  dataSources: ["user_input"],
  possibleErrors: ["MISSING_PERMISSION", "MISSING_DATA", "DUPLICATE_CLIENT_POSSIBLE", "VALIDATION_FAILED"],
};

// Canonical job statuses — must stay in sync with prisma/schema.prisma and the
// VCUF master documentation section 25 (Calendar and Scheduling Intelligence
// Module statuses). Technical ASCII codes; Czech/English display labels belong
// in a translation layer, not hardcoded here (language rule).
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

// The single canonical "job finished" status value, reused wherever a
// service needs to check "is this job done" (e.g. the Portfolio Marketing
// Readiness Gap notification source) instead of re-typing the literal
// string "dokonceno" in multiple places.
export const JOB_STATUS_COMPLETED: JobStatus = "dokonceno";

export const CREATE_JOB_ACTION: ActionContract = {
  actionName: "create_job",
  purpose: "Create a new job record in CRM Core, linked to an existing client.",
  requiredPermission: "crm.manage",
  riskLevel: 2,
  confirmationRequired: false,
  dataSources: ["user_input", "crm.clients"],
  possibleErrors: ["MISSING_PERMISSION", "MISSING_DATA", "VALIDATION_FAILED", "CLIENT_NOT_FOUND"],
};

// This is a status change only — real capacity-aware assignment to a specific
// employee/team (skills, availability, workload) belongs to the Job Allocation
// and Capacity Management Module and is a later vertical slice, not implemented
// here. Do not treat this as "job allocation" — it only records a status.
export const CHANGE_JOB_STATUS_ACTION: ActionContract = {
  actionName: "change_job_status",
  purpose: "Change a job's status along its lifecycle.",
  requiredPermission: "crm.manage",
  riskLevel: 2,
  confirmationRequired: false,
  dataSources: ["user_input", "crm.jobs"],
  possibleErrors: ["MISSING_PERMISSION", "MISSING_DATA", "VALIDATION_FAILED", "JOB_NOT_FOUND", "UNSUPPORTED_ACTION"],
};

// Lead Intake Module — statuses for the lead lifecycle before conversion to a
// real CRM client. See VCUF master documentation section 24 (Lead Intake Module).
export const LEAD_STATUSES = ["new", "contacted", "qualified", "converted", "lost"] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export const CREATE_LEAD_ACTION: ActionContract = {
  actionName: "create_lead",
  purpose: "Create a new lead record from an enquiry source (manual entry in this slice).",
  requiredPermission: "crm.manage",
  riskLevel: 2,
  confirmationRequired: false,
  dataSources: ["user_input"],
  possibleErrors: ["MISSING_PERMISSION", "MISSING_DATA", "VALIDATION_FAILED"],
};

// Converting a lead creates a real CRM client record. This is still an internal
// data change (risk level 2), not external communication — no message is sent
// to anyone as part of conversion. The system must not silently convert an
// already-converted lead twice.
export const CONVERT_LEAD_ACTION: ActionContract = {
  actionName: "convert_lead_to_client",
  purpose: "Convert a qualified lead into a CRM Core client record, preserving the lead as its origin.",
  requiredPermission: "crm.manage",
  riskLevel: 2,
  confirmationRequired: false,
  dataSources: ["crm.leads"],
  possibleErrors: ["MISSING_PERMISSION", "LEAD_NOT_FOUND", "UNSUPPORTED_ACTION", "DUPLICATE_CLIENT_POSSIBLE"],
};

// Voice and Text Command Layer — the top-level action wrapping any parsed
// text command. Risk level matches the worst case among the intents it can
// dispatch to (internal data change); each underlying action (create_client,
// create_job, ...) still records its own detailed audit entry in addition to
// this one, which captures how the raw text was interpreted.
export const EXECUTE_TEXT_COMMAND_ACTION: ActionContract = {
  actionName: "execute_text_command",
  purpose:
    "Interpret a typed command or user-reviewed voice transcript and dispatch it through the same deterministic parser to the matching Action Contract.",
  requiredPermission: "voice.execute",
  riskLevel: 2,
  confirmationRequired: false,
  dataSources: ["user_input"],
  possibleErrors: ["MISSING_PERMISSION", "UNSUPPORTED_ACTION", "AMBIGUOUS_REFERENCE", "NOT_FOUND"],
};

// Job Allocation and Capacity Management Module — see VCUF master
// documentation section 24A / 26. Assignment is capacity-aware: it computes
// real workload from existing jobs (estimated_duration_hours, planned dates)
// against the employee's declared weekly capacity, and it reports skill
// gaps, rather than only checking whether the calendar slot is empty.
export const ASSIGN_JOB_ACTION: ActionContract = {
  actionName: "assign_job",
  purpose:
    "Assign a job to an employee, computing real workload against their weekly capacity and flagging skill or overload issues instead of only checking for a free calendar slot.",
  requiredPermission: "crm.manage",
  riskLevel: 2,
  confirmationRequired: false,
  dataSources: ["user_input", "crm.jobs", "crm.users"],
  possibleErrors: [
    "MISSING_PERMISSION",
    "JOB_NOT_FOUND",
    "JOB_NOT_ACCEPTED",
    "EMPLOYEE_NOT_FOUND",
    "VALIDATION_FAILED",
  ],
};

export const GET_RECRUITMENT_RECOMMENDATION_ACTION: ActionContract = {
  actionName: "get_recruitment_recommendation",
  purpose:
    "Recommend whether and how to strengthen the team only when real capacity evidence shows repeated insufficiency, with role, skills, tasks, urgency and fastest route grounded in source records.",
  requiredPermission: "recruitment.manage",
  riskLevel: 0,
  confirmationRequired: false,
  dataSources: ["crm.jobs", "crm.tasks", "crm.users"],
  possibleErrors: ["MISSING_PERMISSION", "VALIDATION_FAILED"],
};

// Read-only capacity computation — no data is changed. Used both by the
// assign_job flow (to decide whether to surface an overload warning) and
// standalone (to answer "check capacity" questions / power a dashboard).
export const CHECK_CAPACITY_ACTION: ActionContract = {
  actionName: "check_capacity",
  purpose:
    "Compute an employee's current workload for a week from real job data and compare it to their declared weekly capacity.",
  requiredPermission: "crm.read",
  riskLevel: 0,
  confirmationRequired: false,
  dataSources: ["crm.jobs", "crm.users"],
  possibleErrors: ["MISSING_PERMISSION", "EMPLOYEE_NOT_FOUND"],
};

// Calendar and Scheduling Intelligence Module — see VCUF master documentation
// section 25/26. Both actions here are read-only decision support: they
// compute recommendations from real job/employee data, they never invent
// business facts, and they never publish or change anything by themselves.
export const DETECT_OVERLOAD_ACTION: ActionContract = {
  actionName: "detect_overload",
  purpose:
    "Detect upcoming weeks where an employee's real computed workload would exceed their declared weekly capacity, and attach the standard set of realistic mitigation options for the user to consider.",
  requiredPermission: "crm.read",
  riskLevel: 0,
  confirmationRequired: false,
  dataSources: ["crm.jobs", "crm.users"],
  possibleErrors: ["MISSING_PERMISSION"],
};

export const SUGGEST_SCHEDULE_ACTION: ActionContract = {
  actionName: "suggest_schedule",
  purpose:
    "Rank employees for a new job by real spare capacity and skill fit across upcoming weeks, instead of offering a date only because a calendar slot looks empty.",
  requiredPermission: "crm.read",
  riskLevel: 0,
  confirmationRequired: false,
  dataSources: ["crm.jobs", "crm.users"],
  possibleErrors: ["MISSING_PERMISSION", "VALIDATION_FAILED"],
};

// Employee and Permission Model — creating or changing a user's role,
// permissions, skills or active status is an access-control decision, not a
// routine CRM edit. These are the first Action Contracts in this codebase
// with confirmationRequired: true — see the generic confirm-preview flow in
// employeeService (a request without `confirmed: true` returns a preview of
// exactly what would change instead of applying it, per the "fail safely,
// ask before risky actions" rule in section 9 of the project instructions).
export const CREATE_EMPLOYEE_ACTION: ActionContract = {
  actionName: "create_employee",
  purpose: "Create a new employee/user account with a role, permission set, skills and weekly capacity.",
  requiredPermission: "users.manage",
  riskLevel: 3,
  confirmationRequired: true,
  dataSources: ["user_input"],
  possibleErrors: ["MISSING_PERMISSION", "VALIDATION_FAILED", "EMAIL_ALREADY_EXISTS", "CONFIRMATION_REQUIRED"],
};

export const UPDATE_EMPLOYEE_ACTION: ActionContract = {
  actionName: "update_employee",
  purpose: "Change an employee's role, permissions, skills, weekly capacity, or active status.",
  requiredPermission: "users.manage",
  riskLevel: 3,
  confirmationRequired: true,
  dataSources: ["user_input", "crm.users"],
  possibleErrors: ["MISSING_PERMISSION", "EMPLOYEE_NOT_FOUND", "VALIDATION_FAILED", "CONFIRMATION_REQUIRED"],
};

// The fixed set of permission strings the system understands. Kept as
// structured data (not invented per-request) so the UI can offer exactly
// these as checkboxes and the backend can validate against exactly these.
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

// Connector Engine — source registration and lifecycle. Provider contracts
// declare capabilities separately; these actions never imply that an adapter
// is installed or that an external account has been authorised.
export const REGISTER_CONNECTOR_SOURCE_ACTION: ActionContract = {
  actionName: "register_connector_source",
  purpose: "Register a disabled external data-source configuration against a declared connector contract without storing credentials or accessing the provider.",
  requiredPermission: "connectors.manage",
  riskLevel: 2,
  confirmationRequired: false,
  dataSources: ["user_input", "connector_registry"],
  possibleErrors: ["MISSING_PERMISSION", "VALIDATION_FAILED", "CONNECTOR_DEFINITION_NOT_FOUND", "CONNECTOR_SOURCE_ALREADY_EXISTS"],
};

export const UPDATE_CONNECTOR_SOURCE_ACTION: ActionContract = {
  actionName: "update_connector_source",
  purpose: "Update connector metadata, logical scopes or an opaque secret-store reference without reading the referenced secret.",
  requiredPermission: "connectors.manage",
  riskLevel: 2,
  confirmationRequired: false,
  dataSources: ["user_input", "connector_registry", "connector_sources"],
  possibleErrors: ["MISSING_PERMISSION", "VALIDATION_FAILED", "CONNECTOR_SOURCE_NOT_FOUND", "CONNECTOR_MUST_BE_DISABLED", "UNSUPPORTED_CONNECTOR_SCOPE", "CONNECTOR_SOURCE_ALREADY_EXISTS"],
};

export const DISABLE_CONNECTOR_SOURCE_ACTION: ActionContract = {
  actionName: "disable_connector_source",
  purpose: "Disable an external data source immediately so it cannot be used by connector reads, writes or synchronisation.",
  requiredPermission: "connectors.manage",
  riskLevel: 2,
  confirmationRequired: false,
  dataSources: ["connector_sources"],
  possibleErrors: ["MISSING_PERMISSION", "CONNECTOR_SOURCE_NOT_FOUND"],
};

export const ENABLE_CONNECTOR_SOURCE_ACTION: ActionContract = {
  actionName: "enable_connector_source",
  purpose: "Enable a configured external data source only after adapter availability, provider authorization and logical-scope checks and explicit confirmation.",
  requiredPermission: "connectors.manage",
  riskLevel: 3,
  confirmationRequired: true,
  dataSources: ["connector_registry", "connector_sources", "connector_credentials"],
  possibleErrors: ["MISSING_PERMISSION", "CONNECTOR_SOURCE_NOT_FOUND", "CONNECTOR_ADAPTER_UNAVAILABLE", "CONNECTOR_AUTHORIZATION_REQUIRED", "CONNECTOR_SCOPE_REQUIRED", "CONFIRMATION_REQUIRED"],
};

export const START_GMAIL_OAUTH_ACTION: ActionContract = {
  actionName: "start_gmail_oauth",
  purpose: "Create a short-lived one-time OAuth state and return Google's authorization URL for Gmail read-only access.",
  requiredPermission: "connectors.manage",
  riskLevel: 1,
  confirmationRequired: false,
  dataSources: ["connector_sources", "server_configuration"],
  possibleErrors: ["MISSING_PERMISSION", "CONNECTOR_SOURCE_NOT_FOUND", "CONNECTOR_SCOPE_REQUIRED", "CONNECTOR_CONFIGURATION_MISSING"],
};

export const COMPLETE_GMAIL_OAUTH_ACTION: ActionContract = {
  actionName: "complete_gmail_oauth",
  purpose: "Validate one-time OAuth state, exchange Google's authorization code, verify Gmail read-only scope and store only encrypted provider tokens.",
  requiredPermission: "connectors.manage",
  riskLevel: 2,
  confirmationRequired: false,
  dataSources: ["connector_oauth_states", "google_oauth", "connector_credentials"],
  possibleErrors: ["MISSING_PERMISSION", "OAUTH_STATE_INVALID", "OAUTH_STATE_EXPIRED", "OAUTH_PROVIDER_REJECTED", "SCOPE_DENIED", "CONNECTOR_CONFIGURATION_MISSING"],
};

export const SYNC_GMAIL_MESSAGES_ACTION: ActionContract = {
  actionName: "sync_gmail_messages",
  purpose: "Read Gmail messages with the authorized read-only scope, use Gmail history cursors when available, and idempotently import them into Communication Intake with provider provenance.",
  requiredPermission: "connectors.manage",
  riskLevel: 2,
  confirmationRequired: false,
  dataSources: ["connector_sources", "connector_credentials", "gmail.messages", "crm.communication_intakes"],
  possibleErrors: ["MISSING_PERMISSION", "CONNECTOR_SOURCE_NOT_FOUND", "CONNECTOR_NOT_ENABLED", "CONNECTOR_AUTHORIZATION_REQUIRED", "HISTORY_CURSOR_EXPIRED", "SCOPE_DENIED", "RATE_LIMITED", "PROVIDER_UNAVAILABLE", "VALIDATION_FAILED"],
};

export const DISCONNECT_GMAIL_SOURCE_ACTION: ActionContract = {
  actionName: "disconnect_gmail_source",
  purpose: "After explicit confirmation, revoke the stored Google OAuth grant, remove the encrypted local credential and reset Gmail synchronisation state.",
  requiredPermission: "connectors.manage",
  riskLevel: 3,
  confirmationRequired: true,
  dataSources: ["connector_sources", "connector_credentials", "google_oauth"],
  possibleErrors: ["MISSING_PERMISSION", "CONNECTOR_SOURCE_NOT_FOUND", "CONNECTOR_AUTHORIZATION_REQUIRED", "CONFIRMATION_REQUIRED", "OAUTH_PROVIDER_REJECTED", "RATE_LIMITED", "PROVIDER_UNAVAILABLE"],
};

// Service Catalogue Module — see VCUF master documentation section 24C.
// Entries here are entered by the user, never invented ("no fake facts"
// rule). Later modules (quoting, website content) must read from this
// catalogue rather than re-typing or guessing service names/prices.
export const CREATE_SERVICE_ACTION: ActionContract = {
  actionName: "create_service_catalogue_item",
  purpose: "Add a service to the company's real service catalogue (name, description, pricing, default duration and skills).",
  requiredPermission: "crm.manage",
  riskLevel: 2,
  confirmationRequired: false,
  dataSources: ["user_input"],
  possibleErrors: ["MISSING_PERMISSION", "VALIDATION_FAILED"],
};

export const UPDATE_SERVICE_ACTION: ActionContract = {
  actionName: "update_service_catalogue_item",
  purpose: "Update or deactivate an existing service catalogue entry.",
  requiredPermission: "crm.manage",
  riskLevel: 2,
  confirmationRequired: false,
  dataSources: ["user_input", "crm.service_catalogue"],
  possibleErrors: ["MISSING_PERMISSION", "SERVICE_NOT_FOUND", "VALIDATION_FAILED"],
};

export const LIST_REFERENCE_ACTIVITIES_ACTION: ActionContract = {
  actionName: "list_reference_activities",
  purpose: "Search the supplied multi-industry activity reference catalogue without asserting that the company performs any listed activity.",
  requiredPermission: "crm.read",
  riskLevel: 0,
  confirmationRequired: false,
  dataSources: ["SECRETARY_ACTIVITIES_CATALOGUE.csv"],
  possibleErrors: ["MISSING_PERMISSION", "VALIDATION_FAILED", "REFERENCE_CATALOGUE_UNAVAILABLE"],
};

export const ACTIVATE_REFERENCE_ACTIVITY_ACTION: ActionContract = {
  actionName: "activate_reference_activity",
  purpose: "After explicit confirmation, record one reference activity as a real company service and link its industry while keeping reference pricing separate from company pricing.",
  requiredPermission: "crm.manage",
  riskLevel: 3,
  confirmationRequired: true,
  dataSources: ["user_input", "SECRETARY_ACTIVITIES_CATALOGUE.csv", "industry_model", "service_catalogue"],
  possibleErrors: ["MISSING_PERMISSION", "VALIDATION_FAILED", "REFERENCE_ACTIVITY_NOT_FOUND", "REFERENCE_ACTIVITY_ALREADY_ACTIVATED", "CONFIRMATION_REQUIRED"],
};

// Quote, Pricing and Profitability Module — turns real service-catalogue
// prices (or directly typed prices) and real entered costs into an itemised
// quote and a computed margin. The system never assumes a margin: if a line
// has no entered cost, its margin contribution is reported as unknown rather
// than zero or maximal, so profitability numbers are never fabricated.
export const QUOTE_STATUSES = ["draft", "sent", "accepted", "rejected", "expired"] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

export const CREATE_QUOTE_ACTION: ActionContract = {
  actionName: "prepare_quote",
  purpose:
    "Create a draft quote for a client (optionally linked to a job) from real, itemised line items with user-entered prices and costs, computing subtotal, cost total and margin.",
  requiredPermission: "crm.manage",
  riskLevel: 2,
  confirmationRequired: false,
  dataSources: ["user_input", "crm.clients", "crm.jobs", "crm.service_catalogue"],
  possibleErrors: ["MISSING_PERMISSION", "VALIDATION_FAILED", "CLIENT_NOT_FOUND", "JOB_NOT_FOUND"],
};

export const UPDATE_QUOTE_ACTION: ActionContract = {
  actionName: "update_quote",
  purpose: "Update a quote's line items, title, notes or validity, recomputing subtotal, cost total and margin.",
  requiredPermission: "crm.manage",
  riskLevel: 2,
  confirmationRequired: false,
  dataSources: ["user_input", "crm.quotes"],
  possibleErrors: ["MISSING_PERMISSION", "QUOTE_NOT_FOUND", "VALIDATION_FAILED", "UNSUPPORTED_ACTION"],
};

// A status change here is an internal record only — no email, message or
// document is sent to the client as part of this action (no connector
// exists for that yet). "sent" only means the owner has marked it as having
// been given to the client through some other channel.
export const CHANGE_QUOTE_STATUS_ACTION: ActionContract = {
  actionName: "change_quote_status",
  purpose: "Change a quote's status along its lifecycle (draft, sent, accepted, rejected, expired).",
  requiredPermission: "crm.manage",
  riskLevel: 2,
  confirmationRequired: false,
  dataSources: ["user_input", "crm.quotes"],
  possibleErrors: ["MISSING_PERMISSION", "QUOTE_NOT_FOUND", "VALIDATION_FAILED"],
};

// Recruitment and Workforce Expansion Module — see project instructions
// section 6. This module tracks openings and candidates and drafts content
// for the user to review; it never legally hires anyone, sets a wage, or
// confirms employment terms, per the explicit "do not legally hire anyone...
// without explicit user approval" rule.
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

export const CREATE_JOB_OPENING_ACTION: ActionContract = {
  actionName: "create_job_opening",
  purpose:
    "Record a real hiring need — role, required skills, reason, urgency, and requirements — as a structured job opening.",
  requiredPermission: "recruitment.manage",
  riskLevel: 2,
  confirmationRequired: false,
  dataSources: ["user_input"],
  possibleErrors: ["MISSING_PERMISSION", "VALIDATION_FAILED"],
};

export const UPDATE_JOB_OPENING_ACTION: ActionContract = {
  actionName: "update_job_opening",
  purpose: "Update a job opening's details or move it through its status (draft, open, closed).",
  requiredPermission: "recruitment.manage",
  riskLevel: 2,
  confirmationRequired: false,
  dataSources: ["user_input", "crm.job_openings"],
  possibleErrors: ["MISSING_PERMISSION", "JOB_OPENING_NOT_FOUND", "VALIDATION_FAILED"],
};

// Drafting only — see project instructions section 9 ("Drafting can usually
// run without confirmation"). The advert text is built exclusively from the
// job opening's own fields (title, required skills, description, experience
// and language requirements) — no wage, no invented perks, no company claims
// that were not entered elsewhere. There is no job-board connector, so this
// action never publishes anything; the result is stored for the user to
// copy or edit.
export const DRAFT_JOB_ADVERT_ACTION: ActionContract = {
  actionName: "draft_job_advert",
  purpose: "Generate a draft job advert from a job opening's real, user-entered fields only, for the user to review and place manually.",
  requiredPermission: "recruitment.manage",
  riskLevel: 1,
  confirmationRequired: false,
  dataSources: ["crm.job_openings"],
  possibleErrors: ["MISSING_PERMISSION", "JOB_OPENING_NOT_FOUND"],
};

export const CREATE_CANDIDATE_ACTION: ActionContract = {
  actionName: "create_candidate",
  purpose: "Add a candidate to a job opening's pipeline from user-entered contact details.",
  requiredPermission: "recruitment.manage",
  riskLevel: 2,
  confirmationRequired: false,
  dataSources: ["user_input", "crm.job_openings"],
  possibleErrors: ["MISSING_PERMISSION", "JOB_OPENING_NOT_FOUND", "VALIDATION_FAILED"],
};

// Moving a candidate to "hired" is still only an internal pipeline record —
// it does not create an employee account, set a wage, or confirm employment
// terms. Turning a hired candidate into a real system user (Employee and
// Permission Model) remains a separate, explicit action the user takes.
export const UPDATE_CANDIDATE_ACTION: ActionContract = {
  actionName: "update_candidate",
  purpose: "Update a candidate's stage or notes within a job opening's pipeline.",
  requiredPermission: "recruitment.manage",
  riskLevel: 2,
  confirmationRequired: false,
  dataSources: ["user_input", "crm.candidates"],
  possibleErrors: ["MISSING_PERMISSION", "CANDIDATE_NOT_FOUND", "VALIDATION_FAILED"],
};

// Playbook Engine — see project instructions section 2 ("...save the
// workflow as a reusable playbook") and the module list. A playbook is an
// ordered list of Voice/Text Command Layer templates; running one dispatches
// each resolved step through the same Action Engine a typed command uses,
// so nothing about how a step behaves is reimplemented or hidden in this
// module. Creating/editing a playbook is a normal internal-data change.
// Running one is the first action reusing the confirmationRequired preview
// pattern outside employee management: nothing executes until the caller
// has seen every resolved step and confirms.
export const CREATE_PLAYBOOK_ACTION: ActionContract = {
  actionName: "create_playbook",
  purpose: "Save an ordered sequence of Voice/Text Command Layer templates as a reusable, named playbook.",
  requiredPermission: "voice.execute",
  riskLevel: 2,
  confirmationRequired: false,
  dataSources: ["user_input"],
  possibleErrors: ["MISSING_PERMISSION", "VALIDATION_FAILED"],
};

export const UPDATE_PLAYBOOK_ACTION: ActionContract = {
  actionName: "update_playbook",
  purpose: "Update a playbook's name, description, step templates, or active status.",
  requiredPermission: "voice.execute",
  riskLevel: 2,
  confirmationRequired: false,
  dataSources: ["user_input", "crm.playbooks"],
  possibleErrors: ["MISSING_PERMISSION", "PLAYBOOK_NOT_FOUND", "VALIDATION_FAILED"],
};

// Risk level matches execute_text_command's worst case, because a playbook
// step can be any supported intent — but unlike a single typed command, a
// playbook can chain several mutating actions in one call, which is exactly
// the kind of "uncontrolled automation" the project instructions warn
// against (section 9 and the "No uncontrolled automation" standard). The
// confirmation preview is the safeguard: it resolves every {placeholder}
// and shows the exact interpreted intent for every step before anything
// runs, and execution stops at the first failing step rather than
// continuing silently.
export const RUN_PLAYBOOK_ACTION: ActionContract = {
  actionName: "run_playbook",
  purpose: "Resolve a playbook's step templates with real variables and execute them in order through the Action Engine, stopping at the first failure.",
  requiredPermission: "voice.execute",
  riskLevel: 3,
  confirmationRequired: true,
  dataSources: ["user_input", "crm.playbooks"],
  possibleErrors: ["MISSING_PERMISSION", "PLAYBOOK_NOT_FOUND", "VALIDATION_FAILED", "CONFIRMATION_REQUIRED", "MISSING_VARIABLE"],
};

// Learning Engine — see project instructions section 11. Recording a rule is
// low risk and fully reversible (archive, edit), so neither action requires
// confirmation — but every rule is only ever created from an explicit user
// statement, never inferred automatically from one weak signal.
export const LEARNING_RULE_STATUSES = ["active", "archived"] as const;
export type LearningRuleStatus = (typeof LEARNING_RULE_STATUSES)[number];

export const CREATE_LEARNING_RULE_ACTION: ActionContract = {
  actionName: "create_learning_rule",
  purpose:
    "Record an explicit, user-stated meaning or correction (e.g. 'when I say X I mean Y'), optionally as a text-substitution alias applied before commands are parsed.",
  requiredPermission: "voice.execute",
  riskLevel: 1,
  confirmationRequired: false,
  dataSources: ["user_input"],
  possibleErrors: ["MISSING_PERMISSION", "VALIDATION_FAILED"],
};

export const UPDATE_LEARNING_RULE_ACTION: ActionContract = {
  actionName: "update_learning_rule",
  purpose: "Edit or archive a previously recorded learning rule — learning must stay visible, editable and reversible.",
  requiredPermission: "voice.execute",
  riskLevel: 1,
  confirmationRequired: false,
  dataSources: ["user_input", "crm.learning_rules"],
  possibleErrors: ["MISSING_PERMISSION", "LEARNING_RULE_NOT_FOUND", "VALIDATION_FAILED"],
};

// Business Context Layer — structured company knowledge that later modules
// (Website Management, Business Growth, Communication Intelligence and
// Process Planning) can read instead of asking an LLM to invent company
// facts. This stores explicit user-entered or verified context items only:
// company profile facts, industries, activities, regions, rules, tone and
// approval/capacity policies. Existing operational facts such as clients,
// jobs, communications and photos remain in their source modules.
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

export const BUSINESS_CONTEXT_SOURCES = [
  "user_input",
  "confirmed_company_data",
  "crm_record",
  "communication_record",
  "document_reference",
  "external_reference",
] as const;
export type BusinessContextSource = (typeof BUSINESS_CONTEXT_SOURCES)[number];

export const BUSINESS_CONTEXT_VERIFICATION_STATUSES = [
  "user_entered",
  "confirmed",
  "unverified",
  "needs_review",
] as const;
export type BusinessContextVerificationStatus = (typeof BUSINESS_CONTEXT_VERIFICATION_STATUSES)[number];

export const CREATE_BUSINESS_CONTEXT_ITEM_ACTION: ActionContract = {
  actionName: "create_business_context_item",
  purpose:
    "Record an explicit company context item — such as industry, activity, region, communication tone, or business rule — with source and verification status so future workflows use real company knowledge.",
  requiredPermission: "crm.manage",
  riskLevel: 2,
  confirmationRequired: false,
  dataSources: ["user_input"],
  possibleErrors: ["MISSING_PERMISSION", "VALIDATION_FAILED"],
};

export const UPDATE_BUSINESS_CONTEXT_ITEM_ACTION: ActionContract = {
  actionName: "update_business_context_item",
  purpose:
    "Update or archive a previously recorded business context item while preserving source, verification status and audit history.",
  requiredPermission: "crm.manage",
  riskLevel: 2,
  confirmationRequired: false,
  dataSources: ["user_input", "business_context"],
  possibleErrors: ["MISSING_PERMISSION", "BUSINESS_CONTEXT_ITEM_NOT_FOUND", "VALIDATION_FAILED"],
};

// Contact Directory — explicit, traceable people records independent from a
// client's primary contact fields.
export const CONTACT_SOURCES = ["user_input", "communication", "client_record", "other"] as const;
export type ContactSource = (typeof CONTACT_SOURCES)[number];

export const CONTACT_CHANNELS = ["email", "phone_call", "whatsapp", "sms", "messenger", "other"] as const;
export type ContactChannel = (typeof CONTACT_CHANNELS)[number];

export const CONTACT_LANGUAGES = ["en", "cs", "pl", "other"] as const;
export type ContactLanguage = (typeof CONTACT_LANGUAGES)[number];

export const CREATE_CONTACT_ACTION: ActionContract = {
  actionName: "create_contact",
  purpose: "Record a person with explicit contact details, source and optional client relationship in the company contact directory.",
  requiredPermission: "crm.manage",
  riskLevel: 2,
  confirmationRequired: false,
  dataSources: ["user_input", "crm.clients", "crm.communication_records"],
  possibleErrors: ["MISSING_PERMISSION", "VALIDATION_FAILED", "CLIENT_NOT_FOUND", "DUPLICATE_CONTACT_POSSIBLE"],
};

export const UPDATE_CONTACT_ACTION: ActionContract = {
  actionName: "update_contact",
  purpose: "Update, relink or archive an existing contact while preserving source and audit history.",
  requiredPermission: "crm.manage",
  riskLevel: 2,
  confirmationRequired: false,
  dataSources: ["user_input", "crm.contacts", "crm.clients"],
  possibleErrors: ["MISSING_PERMISSION", "VALIDATION_FAILED", "CONTACT_NOT_FOUND", "CLIENT_NOT_FOUND", "DUPLICATE_CONTACT_POSSIBLE"],
};

// Document Registry — metadata only until an authorised file-storage
// connector is configured.
export const DOCUMENT_TYPES = [
  "quote", "contract", "invoice", "receipt", "photo_consent", "employment",
  "certificate", "correspondence", "other",
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const DOCUMENT_SOURCES = [
  "user_input", "client_provided", "employee_provided", "generated_internal",
  "external_storage", "other",
] as const;
export type DocumentSource = (typeof DOCUMENT_SOURCES)[number];

export const DOCUMENT_SENSITIVITIES = ["normal", "confidential", "personal_data", "financial", "legal"] as const;
export type DocumentSensitivity = (typeof DOCUMENT_SENSITIVITIES)[number];

export const DOCUMENT_VERIFICATION_STATUSES = ["user_entered", "confirmed", "unverified", "needs_review"] as const;
export type DocumentVerificationStatus = (typeof DOCUMENT_VERIFICATION_STATUSES)[number];

export const CREATE_DOCUMENT_RECORD_ACTION: ActionContract = {
  actionName: "create_document_record",
  purpose: "Register document metadata and a traceable reference without claiming that Secretary stores the underlying file.",
  requiredPermission: "crm.manage",
  riskLevel: 2,
  confirmationRequired: false,
  dataSources: ["user_input", "crm.clients", "crm.jobs", "external_storage_reference"],
  possibleErrors: ["MISSING_PERMISSION", "VALIDATION_FAILED", "CLIENT_NOT_FOUND", "JOB_NOT_FOUND", "RELATED_RECORD_MISMATCH"],
};

export const UPDATE_DOCUMENT_RECORD_ACTION: ActionContract = {
  actionName: "update_document_record",
  purpose: "Update or archive registered document metadata while preserving its source, sensitivity and audit history.",
  requiredPermission: "crm.manage",
  riskLevel: 2,
  confirmationRequired: false,
  dataSources: ["user_input", "document_registry", "crm.clients", "crm.jobs"],
  possibleErrors: ["MISSING_PERMISSION", "VALIDATION_FAILED", "DOCUMENT_RECORD_NOT_FOUND", "CLIENT_NOT_FOUND", "JOB_NOT_FOUND", "RELATED_RECORD_MISMATCH"],
};

// Basic Industry Model — structured industry records and explicit links to
// real catalogue services. No industry or relationship is inferred.
export const INDUSTRY_SOURCES = ["user_input", "confirmed_company_data", "crm_record", "external_reference"] as const;
export type IndustrySource = (typeof INDUSTRY_SOURCES)[number];

export const INDUSTRY_VERIFICATION_STATUSES = ["user_entered", "confirmed", "unverified", "needs_review"] as const;
export type IndustryVerificationStatus = (typeof INDUSTRY_VERIFICATION_STATUSES)[number];

export const CREATE_INDUSTRY_ACTION: ActionContract = {
  actionName: "create_industry",
  purpose: "Record an explicit industry in the company taxonomy with source and verification status.",
  requiredPermission: "crm.manage",
  riskLevel: 2,
  confirmationRequired: false,
  dataSources: ["user_input", "confirmed_company_data", "external_reference"],
  possibleErrors: ["MISSING_PERMISSION", "VALIDATION_FAILED", "INDUSTRY_ALREADY_EXISTS"],
};

export const UPDATE_INDUSTRY_ACTION: ActionContract = {
  actionName: "update_industry",
  purpose: "Update or archive an industry while preserving source and audit history.",
  requiredPermission: "crm.manage",
  riskLevel: 2,
  confirmationRequired: false,
  dataSources: ["user_input", "industry_model"],
  possibleErrors: ["MISSING_PERMISSION", "VALIDATION_FAILED", "INDUSTRY_NOT_FOUND", "INDUSTRY_ALREADY_EXISTS"],
};

export const LINK_INDUSTRY_SERVICE_ACTION: ActionContract = {
  actionName: "link_industry_service",
  purpose: "Link an explicit industry to an existing Service Catalogue item for structured service applicability.",
  requiredPermission: "crm.manage",
  riskLevel: 2,
  confirmationRequired: false,
  dataSources: ["user_input", "industry_model", "service_catalogue"],
  possibleErrors: ["MISSING_PERMISSION", "VALIDATION_FAILED", "INDUSTRY_NOT_FOUND", "SERVICE_NOT_FOUND"],
};

export const UPDATE_INDUSTRY_SERVICE_LINK_ACTION: ActionContract = {
  actionName: "update_industry_service_link",
  purpose: "Update, archive or restore an industry-to-service relationship with audit history.",
  requiredPermission: "crm.manage",
  riskLevel: 2,
  confirmationRequired: false,
  dataSources: ["user_input", "industry_model", "service_catalogue"],
  possibleErrors: ["MISSING_PERMISSION", "VALIDATION_FAILED", "INDUSTRY_SERVICE_LINK_NOT_FOUND"],
};

// Task Management — Secretary-owned work items linked to real CRM/job/
// communication records. A due date plus assignee also makes a task visible
// in the calendar; an entered duration contributes to capacity. No duration,
// client link or priority is inferred by a prompt.
export const TASK_STATUSES = ["open", "in_progress", "completed", "cancelled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

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

export const TASK_SOURCES = [
  "user_input",
  "communication_follow_up",
  "job_workflow",
  "website_workflow",
  "recruitment_workflow",
  "other",
] as const;
export type TaskSource = (typeof TASK_SOURCES)[number];

export const CREATE_TASK_ACTION: ActionContract = {
  actionName: "create_task",
  purpose:
    "Create a Secretary task linked to real company records, optionally assigning it to an employee with a due date and entered duration for calendar/capacity planning.",
  requiredPermission: "crm.manage",
  riskLevel: 2,
  confirmationRequired: false,
  dataSources: ["user_input", "crm.clients", "crm.jobs", "crm.communication_records", "crm.users"],
  possibleErrors: [
    "MISSING_PERMISSION",
    "VALIDATION_FAILED",
    "CLIENT_NOT_FOUND",
    "JOB_NOT_FOUND",
    "COMMUNICATION_RECORD_NOT_FOUND",
    "EMPLOYEE_NOT_FOUND",
    "RELATED_RECORD_MISMATCH",
  ],
};

export const UPDATE_TASK_ACTION: ActionContract = {
  actionName: "update_task",
  purpose:
    "Update a task's content, assignment, due date, entered duration, priority or lifecycle status while preserving audit history.",
  requiredPermission: "crm.manage",
  riskLevel: 2,
  confirmationRequired: false,
  dataSources: ["user_input", "crm.tasks", "crm.users"],
  possibleErrors: ["MISSING_PERMISSION", "VALIDATION_FAILED", "TASK_NOT_FOUND", "EMPLOYEE_NOT_FOUND"],
};

// Basic Website Audit — MVP Website Management / Business Growth slice.
// The current implementation analyses explicit manual observations and real
// Secretary data only. It does not crawl an external site because no
// authorised website connector exists yet, and it cannot publish anything.
export const WEBSITE_AUDIT_FINDING_CATEGORIES = [
  "technical",
  "content",
  "contact",
  "form",
  "service_content",
  "missing_service_page",
  "photos",
  "data_gap",
] as const;
export type WebsiteAuditFindingCategory = (typeof WEBSITE_AUDIT_FINDING_CATEGORIES)[number];

export const WEBSITE_AUDIT_SEVERITIES = ["info", "warning", "urgent"] as const;
export type WebsiteAuditSeverity = (typeof WEBSITE_AUDIT_SEVERITIES)[number];

export const CREATE_WEBSITE_AUDIT_ACTION: ActionContract = {
  actionName: "create_website_audit",
  purpose:
    "Create a basic website audit from explicit page observations and compare them with real service, business-context and reviewed-photo records to produce evidence-backed improvement findings.",
  requiredPermission: "crm.manage",
  riskLevel: 1,
  confirmationRequired: false,
  dataSources: [
    "user_input",
    "crm.service_catalogue",
    "business_context",
    "crm.portfolio_photos",
  ],
  possibleErrors: ["MISSING_PERMISSION", "VALIDATION_FAILED"],
};

// Website Content Workflow — the MVP can prepare an evidence-backed draft
// and move it through explicit human review. There is intentionally no
// publish action in this slice: public publication is risk level 4 and needs
// a future authorised connector plus its own confirmation and validation.
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

export const WEBSITE_CONTENT_PROPOSAL_STATUSES = [
  "ready_for_review",
  "approved",
  "rejected",
  "published",
  "verified",
] as const;
export type WebsiteContentProposalStatus = (typeof WEBSITE_CONTENT_PROPOSAL_STATUSES)[number];

export const PREPARE_WEBSITE_CONTENT_PROPOSAL_ACTION: ActionContract = {
  actionName: "prepare_website_content_proposal",
  purpose:
    "Store a website content proposal for review, together with an immutable snapshot of the selected verified Secretary sources used to support it.",
  requiredPermission: "crm.manage",
  riskLevel: 1,
  confirmationRequired: false,
  dataSources: [
    "user_input",
    "website_audits",
    "website_audit_findings",
    "crm.service_catalogue",
    "business_context",
    "crm.portfolio_photos",
  ],
  possibleErrors: [
    "MISSING_PERMISSION",
    "VALIDATION_FAILED",
    "WEBSITE_AUDIT_NOT_FOUND",
    "TARGET_URL_MISMATCH",
    "SOURCE_NOT_AVAILABLE",
    "SOURCE_NOT_CONFIRMED",
  ],
};

export const DECIDE_WEBSITE_CONTENT_PROPOSAL_ACTION: ActionContract = {
  actionName: "decide_website_content_proposal",
  purpose:
    "Explicitly approve or reject a website content proposal after presenting the exact proposed status change for confirmation; this does not publish anything.",
  requiredPermission: "crm.manage",
  riskLevel: 2,
  confirmationRequired: true,
  dataSources: ["user_input", "website_content_proposals"],
  possibleErrors: [
    "MISSING_PERMISSION",
    "VALIDATION_FAILED",
    "WEBSITE_CONTENT_PROPOSAL_NOT_FOUND",
    "WEBSITE_CONTENT_PROPOSAL_ALREADY_DECIDED",
    "CONFIRMATION_REQUIRED",
  ],
};

// Communication Log Module — the manual-entry foundation of the
// Communication Intelligence Module (project instructions section 3). A
// communication record is a real CRM fact (what was discussed/promised,
// when, with whom) — same class of action as create_lead/create_job: an
// internal data change to a structured CRM record, not merely a draft or
// suggestion, so it matches those actions' risk level (2) rather than the
// lower "draft only" level used for advert drafting. It never sends,
// publishes, or contacts anyone by itself (no connector exists yet) — it
// only logs a communication that already happened, always from user-entered
// data, never invented.
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

export const COMMUNICATION_DIRECTIONS = ["inbound", "outbound"] as const;
export type CommunicationDirection = (typeof COMMUNICATION_DIRECTIONS)[number];

export const CREATE_COMMUNICATION_RECORD_ACTION: ActionContract = {
  actionName: "log_communication",
  purpose:
    "Record a real communication (email, WhatsApp, SMS, phone call, messenger, in-person or other) with a client, optionally linked to a job, from user-entered details only.",
  requiredPermission: "crm.manage",
  riskLevel: 2,
  confirmationRequired: false,
  dataSources: ["user_input", "crm.clients", "crm.jobs"],
  possibleErrors: ["MISSING_PERMISSION", "MISSING_DATA", "VALIDATION_FAILED", "CLIENT_NOT_FOUND", "JOB_NOT_FOUND"],
};

export const UPDATE_COMMUNICATION_RECORD_ACTION: ActionContract = {
  actionName: "update_communication_record",
  purpose: "Update a previously logged communication record, including marking follow-up as needed or done.",
  requiredPermission: "crm.manage",
  riskLevel: 2,
  confirmationRequired: false,
  dataSources: ["user_input", "crm.communication_records"],
  possibleErrors: ["MISSING_PERMISSION", "COMMUNICATION_RECORD_NOT_FOUND", "VALIDATION_FAILED"],
};

export const LOG_COMMUNICATION_INTAKE_ACTION: ActionContract = {
  actionName: "log_communication_intake",
  purpose:
    "Preserve an original inbound enquiry and its real sender/source metadata before the sender has been linked to a CRM client.",
  requiredPermission: "crm.manage",
  riskLevel: 2,
  confirmationRequired: false,
  dataSources: ["user_input", "authorised_communication_source"],
  possibleErrors: ["MISSING_PERMISSION", "VALIDATION_FAILED"],
};

export const EXTRACT_COMMUNICATION_INTAKE_ACTION: ActionContract = {
  actionName: "extract_communication_intake",
  purpose:
    "Deterministically extract contact, address and service evidence from a preserved inbound communication and compare it with the company's CRM.",
  requiredPermission: "crm.manage",
  riskLevel: 1,
  confirmationRequired: false,
  dataSources: ["crm.communication_intakes", "crm.clients", "crm.service_catalogue"],
  possibleErrors: ["MISSING_PERMISSION", "COMMUNICATION_INTAKE_NOT_FOUND", "UNSUPPORTED_ACTION"],
};

export const CREATE_CLIENT_FROM_COMMUNICATION_ACTION: ActionContract = {
  actionName: "create_client_from_communication",
  purpose:
    "After a human preview, create or reuse a CRM client and link it to the preserved original communication and a communication log record.",
  requiredPermission: "crm.manage",
  riskLevel: 2,
  confirmationRequired: true,
  dataSources: ["user_input", "crm.communication_intakes", "crm.clients"],
  possibleErrors: [
    "MISSING_PERMISSION",
    "COMMUNICATION_INTAKE_NOT_FOUND",
    "EXTRACTION_REQUIRED",
    "MISSING_DATA",
    "CLIENT_SELECTION_REQUIRED",
    "CLIENT_NOT_FOUND",
    "CONFIRMATION_REQUIRED",
    "UNSUPPORTED_ACTION",
  ],
};

export const PREPARE_COMMUNICATION_REPLY_ACTION: ActionContract = {
  actionName: "prepare_communication_reply",
  purpose:
    "Prepare an internal reply draft from preserved communication evidence and real company/service data without sending it.",
  requiredPermission: "crm.manage",
  riskLevel: 1,
  confirmationRequired: false,
  dataSources: ["crm.communication_intakes", "crm.service_catalogue", "crm.companies"],
  possibleErrors: ["MISSING_PERMISSION", "COMMUNICATION_INTAKE_NOT_FOUND", "EXTRACTION_REQUIRED"],
};

export const FIND_UNRESOLVED_ENQUIRIES_ACTION: ActionContract = {
  actionName: "find_unresolved_enquiries",
  purpose:
    "List enquiries whose stored intake resolution or inbound Communication Log follow-up state explicitly says they still need attention.",
  requiredPermission: "crm.read",
  riskLevel: 0,
  confirmationRequired: false,
  dataSources: ["crm.communication_intakes", "crm.communication_records", "crm.clients"],
  possibleErrors: ["MISSING_PERMISSION", "VALIDATION_FAILED"],
};

export const SET_COMMUNICATION_INTAKE_RESOLUTION_ACTION: ActionContract = {
  actionName: "set_communication_intake_resolution",
  purpose:
    "Mark a preserved inbound communication as resolved or reopen it, synchronising its linked Communication Log follow-up when present.",
  requiredPermission: "crm.manage",
  riskLevel: 2,
  confirmationRequired: false,
  dataSources: ["user_input", "crm.communication_intakes", "crm.communication_records"],
  possibleErrors: ["MISSING_PERMISSION", "VALIDATION_FAILED", "COMMUNICATION_INTAKE_NOT_FOUND"],
};

// Notification and Escalation Module — a unified, read-only "things needing
// attention" feed computed from real data already owned by other modules:
// overdue Communication Log follow-ups (log_communication /
// listFollowUpsDue), Job Allocation/Capacity Management overload weeks
// (detect_overload), and quotes approaching or past their valid_until date.
// It never invents an item and never fabricates urgency — severity is
// derived directly from real dates/percentages already stored elsewhere.
// See notificationService.ts.
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

export const NOTIFICATION_SEVERITIES = ["info", "warning", "urgent"] as const;
export type NotificationSeverity = (typeof NOTIFICATION_SEVERITIES)[number];

export const GET_ATTENTION_FEED_ACTION: ActionContract = {
  actionName: "get_attention_feed",
  purpose:
    "Aggregate unresolved communication intakes, overdue communication follow-ups and tasks, capacity overload weeks, expiring quotes, data quality findings, completed jobs missing portfolio photos, stale open leads, and jobs stuck in one status too long into a single, real, unified feed of things needing attention.",
  requiredPermission: "crm.read",
  riskLevel: 0,
  confirmationRequired: false,
  dataSources: [
    "crm.communication_records",
    "crm.communication_intakes",
    "crm.jobs",
    "crm.users",
    "crm.quotes",
    "crm.clients",
    "crm.portfolio_photos",
    "crm.leads",
    "crm.tasks",
    "audit_log",
  ],
  possibleErrors: ["MISSING_PERMISSION"],
};

// Acknowledging only records that a user has seen/handled a computed
// notification item (by its deterministic key) — it never deletes or
// changes the underlying business record (the communication record, the
// overload finding, or the quote) that the notification points to, and it
// is fully reversible via unacknowledge_notification. Low risk (1): it is a
// personal/company "seen" marker, not a business data change, so it does
// not require confirmation.
export const ACKNOWLEDGE_NOTIFICATION_ACTION: ActionContract = {
  actionName: "acknowledge_notification",
  purpose: "Mark a surfaced attention-feed item as seen/handled so it stops resurfacing, without altering the underlying record it points to.",
  requiredPermission: "crm.manage",
  riskLevel: 1,
  confirmationRequired: false,
  dataSources: ["user_input"],
  possibleErrors: ["MISSING_PERMISSION", "VALIDATION_FAILED"],
};

export const UNACKNOWLEDGE_NOTIFICATION_ACTION: ActionContract = {
  actionName: "unacknowledge_notification",
  purpose: "Reverse a previous acknowledgement so an attention-feed item resurfaces again.",
  requiredPermission: "crm.manage",
  riskLevel: 1,
  confirmationRequired: false,
  dataSources: ["user_input"],
  possibleErrors: ["MISSING_PERMISSION", "VALIDATION_FAILED"],
};
// Data Quality Engine — read-only, structural analysis over real CRM Core
// Client data already entered by the user (email, phone, display name). It
// never invents an identity match: duplicates are surfaced as *possible*
// matches for a human to confirm (per the CRM rule — "uncertain identity
// matches must be presented for confirmation"), and this module never
// merges, deletes, or edits a client record itself. Findings are additive
// into the same unified Notification feed (see dataQualityService.ts /
// buildDataQualityItems), reusing the existing acknowledge/unacknowledge
// mechanism rather than inventing a second "dismiss" concept.
export const ANALYZE_DATA_QUALITY_ACTION: ActionContract = {
  actionName: "analyze_data_quality",
  purpose:
    "Scan real CRM Core client records for possible duplicate clients (matching email, phone, or name) and clients missing a contact method, without merging or changing any record.",
  requiredPermission: "crm.read",
  riskLevel: 0,
  confirmationRequired: false,
  dataSources: ["crm.clients"],
  possibleErrors: ["MISSING_PERMISSION"],
};

// merge_clients — the confirmation-gated action closing the "no merge these
// clients action yet" gap documented in README.md. This is deliberately the
// highest-risk action in the Data Quality Engine so far: it re-links real,
// already-linked business records (Job, Quote, CommunicationRecord,
// CommunicationIntake, PortfolioPhoto) from a duplicate client onto a primary client, and
// archives (never hard-deletes) the duplicate. Follows the exact same
// confirmationRequired: true / 409 CONFIRMATION_REQUIRED preview pattern as
// create_employee / update_employee / run_playbook — see employeeService.ts
// and dataQualityService.mergeClients. requiredPermission matches the
// permission already used for every other client-management action
// (crm.manage), since this is fundamentally a CRM Core write, not an
// access-control change like the employee actions (which is why those use
// users.manage instead). risk 3, same as create_employee/update_employee/
// run_playbook: an internal data change with real, multi-record
// consequences, but not external communication (4) or a financial/legal/
// irreversible action (5) — the merge is reversible in the sense that the
// duplicate client is archived, not deleted, and its own record (and its
// own audit history) still exists and can be manually un-archived by a
// human; there is no automatic "undo merge" action that reverses the FK
// re-linking itself.
export const MERGE_CLIENTS_ACTION: ActionContract = {
  actionName: "merge_clients",
  purpose:
    "Re-link a duplicate client's Job, Quote, CommunicationRecord, CommunicationIntake, and PortfolioPhoto records onto a primary client, then archive (never delete) the duplicate — always previewed before anything changes.",
  requiredPermission: "crm.manage",
  riskLevel: 3,
  confirmationRequired: true,
  dataSources: ["user_input", "crm.clients", "crm.jobs", "crm.quotes", "crm.communication_records", "crm.communication_intakes", "crm.portfolio_photos"],
  possibleErrors: [
    "MISSING_PERMISSION",
    "VALIDATION_FAILED",
    "CLIENT_NOT_FOUND",
    "SAME_CLIENT",
    "CONFIRMATION_REQUIRED",
  ],
};

// Portfolio and Photo Intelligence Module — the manual-entry foundation of a
// future automated photo-selection/website-publishing workflow (see
// prisma/schema.prisma PortfolioPhoto and the vcubf-programmer-skill "Photo
// and portfolio rule"). Logging a photo record is a real CRM-adjacent fact
// (a real photo reference, optionally linked to a client/job) but nothing
// here stores, moves, or publishes an actual image file, and there is no
// upload/storage or website/social connector yet — so this is deliberately
// kept at risk level 1 (draft/internal-tag only), the same level used for
// draft_job_advert, not the level 2 used for CRM record creation like
// log_communication/create_job. Flipping usableForMarketing to true is
// still only an internal review tag reviewed by a human before any future
// separate, connector-dependent publishing action — it does not publish
// anything itself, so it does not warrant a higher risk level than a normal
// update.
export const PORTFOLIO_PHOTO_SOURCES = [
  "employee_upload",
  "client_provided",
  "before_after",
  "other",
] as const;
export type PortfolioPhotoSource = (typeof PORTFOLIO_PHOTO_SOURCES)[number];

export const PHOTO_QUALITY_REVIEW_STATUSES = ["unreviewed", "approved", "rejected"] as const;
export const PHOTO_DUPLICATE_REVIEW_STATUSES = ["unreviewed", "unique", "duplicate"] as const;
export const PHOTO_SENSITIVE_DATA_REVIEW_STATUSES = [
  "unreviewed",
  "clear",
  "contains_sensitive_data",
] as const;
export const PHOTO_USAGE_PERMISSION_STATUSES = ["unknown", "not_required", "confirmed", "denied"] as const;

export const LOG_PORTFOLIO_PHOTO_ACTION: ActionContract = {
  actionName: "log_portfolio_photo",
  purpose:
    "Record a real photograph reference (filename, caption, tags, source) optionally linked to a client and/or job, from user-entered details only — no image file is stored or uploaded by this action.",
  requiredPermission: "crm.manage",
  riskLevel: 1,
  confirmationRequired: false,
  dataSources: ["user_input", "crm.clients", "crm.jobs"],
  possibleErrors: ["MISSING_PERMISSION", "MISSING_DATA", "VALIDATION_FAILED", "CLIENT_NOT_FOUND", "JOB_NOT_FOUND"],
};

export const UPDATE_PORTFOLIO_PHOTO_ACTION: ActionContract = {
  actionName: "update_portfolio_photo",
  purpose:
    "Update a previously logged photo record's metadata and explicit human review states for quality, duplicates, sensitive data, usage permission and marketing suitability.",
  requiredPermission: "crm.manage",
  riskLevel: 1,
  confirmationRequired: false,
  dataSources: ["user_input", "crm.portfolio_photos"],
  possibleErrors: ["MISSING_PERMISSION", "PORTFOLIO_PHOTO_NOT_FOUND", "VALIDATION_FAILED"],
};

export const FIND_PHOTOS_FOR_SERVICE_ACTION: ActionContract = {
  actionName: "find_photos_for_service",
  purpose:
    "Return photo candidates for one real Service Catalogue item using only an explicit job/service link or an exact user-entered tag, together with blockers from human review metadata; never inspect, move or publish an image.",
  requiredPermission: "crm.read",
  riskLevel: 0,
  confirmationRequired: false,
  dataSources: ["crm.portfolio_photos", "crm.jobs", "service_catalogue"],
  possibleErrors: ["MISSING_PERMISSION", "SERVICE_NOT_FOUND", "VALIDATION_FAILED"],
};

export const SELECT_PHOTOS_FOR_SERVICE_ACTION: ActionContract = {
  actionName: "select_photos_for_service",
  purpose:
    "Confirm the exact internal set of reviewed company photographs selected for one Service Catalogue item, preserving the evidence snapshot; this does not publish or move any image.",
  requiredPermission: "crm.manage",
  riskLevel: 2,
  confirmationRequired: true,
  dataSources: ["user_input", "crm.portfolio_photos", "crm.jobs", "service_catalogue"],
  possibleErrors: [
    "MISSING_PERMISSION",
    "VALIDATION_FAILED",
    "SERVICE_NOT_FOUND",
    "PORTFOLIO_PHOTO_NOT_FOUND",
    "PHOTO_SELECTION_BLOCKED",
    "CONFIRMATION_REQUIRED",
  ],
};

// Memory Model — Pattern Detection. See memoryModelService.ts for the full
// rationale: this is a strictly read-only analysis over the company's own
// AuditLog, looking for repeated manual action sequences. It is explicitly
// NOT the Learning Engine (which only ever acts on an explicit user
// correction) and it never creates a Playbook, a LearningRule, or any other
// record — candidate patterns are returned for human review only. Gated by
// "audit.read" (the same permission class as reading raw audit data,
// because that is exactly what this analysis is derived from) rather than
// a general CRM permission.
export const DETECT_ACTION_PATTERNS_ACTION: ActionContract = {
  actionName: "detect_action_patterns",
  purpose:
    "Analyse the company's own AuditLog for repeated consecutive action sequences performed by the same user, as candidate patterns for a human to optionally turn into a real Playbook. Never creates a Playbook or any other record itself.",
  requiredPermission: "audit.read",
  riskLevel: 0,
  confirmationRequired: false,
  dataSources: ["audit.log"],
  possibleErrors: ["MISSING_PERMISSION"],
};
