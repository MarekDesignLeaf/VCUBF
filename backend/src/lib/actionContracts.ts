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
  "naplanovano",
  "v_realizaci",
  "ceka_na_material",
  "ceka_na_klienta",
  "dokonceno",
  "zruseno",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

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
  purpose: "Interpret a natural-language text command and dispatch it to the matching Action Contract.",
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
    "EMPLOYEE_NOT_FOUND",
    "VALIDATION_FAILED",
  ],
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
] as const;
export type KnownPermission = (typeof KNOWN_PERMISSIONS)[number];

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
