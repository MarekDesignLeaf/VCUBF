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
  riskLevel: 2, // internal data change
  confirmationRequired: false, // manual entry by a permitted user; duplicate check still enforced
  dataSources: ["user_input"],
  possibleErrors: ["MISSING_PERMISSION", "MISSING_DATA", "DUPLICATE_CLIENT_POSSIBLE", "VALIDATION_FAILED"],
};
