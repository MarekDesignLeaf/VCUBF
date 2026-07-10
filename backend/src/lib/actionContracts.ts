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
