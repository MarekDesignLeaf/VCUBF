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
export const KNOWN_PERMISSIONS = ["crm.read", "crm.manage", "users.manage", "audit.read", "voice.execute"] as const;
export type KnownPermission = (typeof KNOWN_PERMISSIONS)[number];
