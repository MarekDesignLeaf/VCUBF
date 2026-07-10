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
