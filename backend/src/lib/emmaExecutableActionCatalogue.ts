// Canonical bridge between Emma's natural-language interpretation and the
// application's permission-checked services. The language model may choose
// only an action listed here and must provide JSON; the owning service still
// validates every value and tenant-scopes every lookup.

export interface EmmaExecutableActionDefinition {
  capabilityAction: string;
  fields: string;
  confirmation: "none" | "service_preview";
}

export const EMMA_EXECUTABLE_ACTIONS = {
  create_document: { capabilityAction: "create_document_record", fields: "title, document_type, document_reference, source?, sensitivity?, client_name?, job_title?, issued_at?, expires_at?, notes?", confirmation: "none" },
  archive_document: { capabilityAction: "update_document_record", fields: "document_title", confirmation: "none" },
  set_task_status: { capabilityAction: "update_task", fields: "task_title, task_status", confirmation: "none" },
  create_business_context: { capabilityAction: "create_business_context_item", fields: "category, label, value, notes?", confirmation: "none" },
  archive_business_context: { capabilityAction: "update_business_context_item", fields: "label", confirmation: "none" },
  create_industry: { capabilityAction: "create_industry", fields: "name, description?, notes?", confirmation: "none" },
  archive_industry: { capabilityAction: "update_industry", fields: "name", confirmation: "none" },
  link_industry_service: { capabilityAction: "link_industry_service", fields: "industry_name, service_name, notes?", confirmation: "none" },
  archive_industry_service_link: { capabilityAction: "update_industry_service_link", fields: "industry_name, service_name", confirmation: "none" },
  set_service_active: { capabilityAction: "update_service_catalogue_item", fields: "service_name, is_active", confirmation: "none" },
  create_quote: { capabilityAction: "prepare_quote", fields: "client_name, title, items[{description, quantity?, unit_price, unit_cost?}], job_title?, notes?, valid_until?", confirmation: "none" },
  set_quote_status: { capabilityAction: "change_quote_status", fields: "quote_title, quote_status", confirmation: "none" },
  update_quote: { capabilityAction: "update_quote", fields: "quote_title, title?, notes?, valid_until?, items?", confirmation: "none" },
  export_quote_pdf: { capabilityAction: "export_quote_pdf", fields: "quote_title", confirmation: "none" },
  prepare_invoice_for_client: { capabilityAction: "create_invoice", fields: "client_name", confirmation: "none" },
  create_invoice: { capabilityAction: "create_invoice", fields: "client_name, invoice_number, title, items[{description, quantity?, unit_price}], issue_date?, due_date?, notes?", confirmation: "none" },
  issue_invoice: { capabilityAction: "change_invoice_status", fields: "invoice_number", confirmation: "none" },
  record_invoice_payment: { capabilityAction: "record_invoice_payment", fields: "invoice_number, amount, paid_at?, method?, reference?", confirmation: "service_preview" },
  export_invoice_pdf: { capabilityAction: "export_invoice_pdf", fields: "invoice_number", confirmation: "none" },
  add_job_resource: { capabilityAction: "add_job_resource", fields: "job_title, resource_type, name, quantity?, unit?, estimated_cost?, notes?", confirmation: "none" },
  set_job_resource_status: { capabilityAction: "update_job_resource", fields: "job_title, resource_name, requirement_status", confirmation: "none" },
  set_job_resource_cost: { capabilityAction: "update_job_resource", fields: "job_title, resource_name, actual_cost?, estimated_cost?", confirmation: "none" },
  create_job_opening: { capabilityAction: "create_job_opening", fields: "title, reason?, urgency?, skills_required?, expected_tasks?, min_experience_years?, preferred_experience_years?, language_requirements?, availability_requirements?, description?", confirmation: "none" },
  set_job_opening_status: { capabilityAction: "update_job_opening", fields: "title, opening_status", confirmation: "none" },
  draft_job_advert: { capabilityAction: "draft_job_advert", fields: "title", confirmation: "none" },
  create_candidate: { capabilityAction: "create_candidate", fields: "job_opening_title, name, email?, phone?, notes?", confirmation: "none" },
  set_candidate_stage: { capabilityAction: "update_candidate", fields: "candidate_name, stage", confirmation: "none" },
  create_communication_intake: { capabilityAction: "log_communication_intake", fields: "channel, message_text, sender_name?, sender_email?, sender_phone?, received_at?, source_reference?", confirmation: "none" },
  extract_communication_intake: { capabilityAction: "extract_communication_intake", fields: "sender_or_message", confirmation: "none" },
  draft_communication_reply: { capabilityAction: "prepare_communication_reply", fields: "sender_or_message", confirmation: "none" },
  set_communication_intake_resolution: { capabilityAction: "set_communication_intake_resolution", fields: "sender_or_message, resolution_needed", confirmation: "none" },
  convert_communication_intake: { capabilityAction: "create_client_from_communication", fields: "sender_or_message, client_name?", confirmation: "service_preview" },
  acknowledge_notification: { capabilityAction: "acknowledge_notification", fields: "notification_key", confirmation: "none" },
  unacknowledge_notification: { capabilityAction: "unacknowledge_notification", fields: "notification_key", confirmation: "none" },
  archive_learning_rule: { capabilityAction: "update_learning_rule", fields: "term", confirmation: "none" },
  reactivate_learning_rule: { capabilityAction: "update_learning_rule", fields: "term", confirmation: "none" },
  archive_memory: { capabilityAction: "archive_assistant_memory", fields: "content", confirmation: "none" },
  get_metrics: { capabilityAction: "get_metrics_overview", fields: "from?, to?", confirmation: "none" },
  suggest_schedule: { capabilityAction: "suggest_schedule", fields: "estimated_duration_hours?, required_skills?, weeks_ahead?", confirmation: "none" },
  get_recruitment_recommendation: { capabilityAction: "get_recruitment_recommendation", fields: "weeks_ahead?, minimum_repeated_weeks?", confirmation: "none" },
  check_capacity: { capabilityAction: "check_capacity", fields: "employee_name, reference_date?", confirmation: "none" },
  update_communication: { capabilityAction: "update_communication_record", fields: "communication_summary, channel?, direction?, summary?, full_text?, occurred_at?, follow_up_needed?, follow_up_due_at?", confirmation: "none" },
  update_portfolio_photo: { capabilityAction: "update_portfolio_photo", fields: "filename, caption?, tags?, taken_at?, usable_for_marketing?, usable_for_marketing_notes?, quality_review_status?, duplicate_review_status?, sensitive_data_review_status?, usage_permission_status?", confirmation: "none" },
  create_playbook: { capabilityAction: "create_playbook", fields: "name, description?, step_templates[]", confirmation: "none" },
  update_playbook: { capabilityAction: "update_playbook", fields: "playbook_name, name?, description?, step_templates?, is_active?", confirmation: "none" },
  run_playbook: { capabilityAction: "run_playbook", fields: "playbook_name, variables?", confirmation: "service_preview" },
  create_website_audit: { capabilityAction: "create_website_audit", fields: "website_url, notes?, pages[]", confirmation: "none" },
  prepare_website_content: { capabilityAction: "prepare_website_content_proposal", fields: "proposal_type, target_page_url, content_body, headline?, notes?, website_audit_id?, business_context_ids[], service_catalogue_item_ids[], portfolio_photo_ids[], website_audit_finding_ids[]", confirmation: "none" },
  decide_website_content: { capabilityAction: "decide_website_content_proposal", fields: "proposal_id, decision, decision_notes?", confirmation: "service_preview" },
  list_reference_activities: { capabilityAction: "list_reference_activities", fields: "search?, industry_code?, subtype_code?, limit?, offset?", confirmation: "none" },
  activate_reference_activity: { capabilityAction: "activate_reference_activity", fields: "activity_code, description?, base_price_min?, base_price_max?, price_unit?, default_duration_hours?, default_required_skills?", confirmation: "service_preview" },
  start_gmail_oauth: { capabilityAction: "start_gmail_oauth", fields: "", confirmation: "none" },
  start_google_contacts_oauth: { capabilityAction: "start_google_contacts_oauth", fields: "", confirmation: "none" },
  start_google_calendar_oauth: { capabilityAction: "start_google_calendar_oauth", fields: "", confirmation: "none" },
  start_google_drive_oauth: { capabilityAction: "start_google_drive_oauth", fields: "", confirmation: "none" },
  start_google_photos_oauth: { capabilityAction: "start_google_photos_oauth", fields: "", confirmation: "none" },
  sync_gmail: { capabilityAction: "sync_gmail_messages", fields: "max_results?", confirmation: "none" },
  sync_google_contacts: { capabilityAction: "sync_google_contacts", fields: "", confirmation: "none" },
  sync_google_calendar: { capabilityAction: "sync_google_calendar", fields: "", confirmation: "none" },
  disconnect_gmail: { capabilityAction: "disconnect_gmail_source", fields: "", confirmation: "service_preview" },
  disconnect_google_contacts: { capabilityAction: "disconnect_google_contacts_source", fields: "", confirmation: "service_preview" },
  disconnect_google_calendar: { capabilityAction: "disconnect_google_calendar_source", fields: "", confirmation: "service_preview" },
  disconnect_google_drive: { capabilityAction: "disconnect_google_drive_source", fields: "", confirmation: "service_preview" },
  disconnect_google_photos: { capabilityAction: "disconnect_google_photos_source", fields: "", confirmation: "service_preview" },
  disconnect_whatsapp: { capabilityAction: "disconnect_whatsapp_source", fields: "", confirmation: "service_preview" },
  update_connector_source: { capabilityAction: "update_connector_source", fields: "connector_key, display_name?, configured_scopes?, is_active?", confirmation: "none" },
  disable_connector_source: { capabilityAction: "disable_connector_source", fields: "connector_key", confirmation: "none" },
  enable_connector_source: { capabilityAction: "enable_connector_source", fields: "connector_key", confirmation: "service_preview" },
  create_gmail_draft: { capabilityAction: "create_gmail_draft", fields: "to[], cc?, bcc?, subject, body", confirmation: "none" },
  delete_gmail_message: { capabilityAction: "delete_gmail_intake", fields: "sender_or_message", confirmation: "service_preview" },
  import_google_contact: { capabilityAction: "import_google_contact", fields: "external_contact_id", confirmation: "service_preview" },
  create_google_photos_picker: { capabilityAction: "create_google_photos_picker_session", fields: "", confirmation: "none" },
  stage_google_photos: { capabilityAction: "stage_google_photos_items", fields: "session_id", confirmation: "none" },
  register_google_photos_photo: { capabilityAction: "register_google_photos_portfolio_photo", fields: "photo_id, caption?, tags?", confirmation: "service_preview" },
  stage_google_drive_images: { capabilityAction: "stage_google_drive_images", fields: "file_ids[]", confirmation: "none" },
  register_google_drive_photo: { capabilityAction: "register_google_drive_portfolio_photo", fields: "image_id, caption?, tags?", confirmation: "service_preview" },
  find_photos_for_service: { capabilityAction: "find_photos_for_service", fields: "service_name, own_production_only?", confirmation: "none" },
  select_photos_for_service: { capabilityAction: "select_photos_for_service", fields: "service_name, photo_filenames[], own_production_only?, review_notes?", confirmation: "service_preview" },
  update_employee: { capabilityAction: "update_employee", fields: "employee_name, display_name?, role?, permissions?, skills?, weekly_capacity_hours?, is_active?", confirmation: "service_preview" },
  update_emma_behavior: { capabilityAction: "update_emma_behavior_scenario", fields: "enabled, scenario", confirmation: "none" },
  update_emma_permissions: { capabilityAction: "update_emma_company_policy", fields: "disabled_capabilities[]", confirmation: "none" },
  merge_clients: { capabilityAction: "merge_clients", fields: "primary_client_name, duplicate_client_name", confirmation: "service_preview" },
} as const satisfies Record<string, EmmaExecutableActionDefinition>;

export type EmmaExecutableActionName = keyof typeof EMMA_EXECUTABLE_ACTIONS;

export interface EmmaExecutableActionRequest {
  action: EmmaExecutableActionName;
  parameters: Record<string, unknown>;
}

export function isEmmaExecutableActionName(value: string): value is EmmaExecutableActionName {
  return Object.prototype.hasOwnProperty.call(EMMA_EXECUTABLE_ACTIONS, value);
}

export function parseEmmaExecutableActionCommand(rawText: string): EmmaExecutableActionRequest | undefined {
  const match = rawText.trim().match(/^voice\s+action\s+([a-z_]+)\s*:?\s*(\{[\s\S]*\})$/i);
  if (!match) return undefined;
  const action = match[1].toLowerCase();
  if (!isEmmaExecutableActionName(action)) return undefined;
  try {
    const parameters = JSON.parse(match[2]);
    if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) return undefined;
    return { action, parameters };
  } catch {
    return undefined;
  }
}

export function capabilityActionForExecutableAction(action: EmmaExecutableActionName) {
  return EMMA_EXECUTABLE_ACTIONS[action].capabilityAction;
}

export const EMMA_EXECUTABLE_ACTION_PAGES: Record<EmmaExecutableActionName, string> = {
  create_document: "documents", archive_document: "documents", set_task_status: "tasks",
  create_business_context: "business_context", archive_business_context: "business_context",
  create_industry: "industries", archive_industry: "industries", link_industry_service: "industries",
  archive_industry_service_link: "industries", set_service_active: "services", create_quote: "quotes",
  set_quote_status: "quotes", update_quote: "quotes", export_quote_pdf: "quotes", prepare_invoice_for_client: "invoices", create_invoice: "invoices", issue_invoice: "invoices", record_invoice_payment: "invoices", export_invoice_pdf: "invoices",
  add_job_resource: "jobs", set_job_resource_status: "jobs", set_job_resource_cost: "jobs",
  create_job_opening: "recruitment", set_job_opening_status: "recruitment", draft_job_advert: "recruitment",
  create_candidate: "recruitment", set_candidate_stage: "recruitment", create_communication_intake: "communication_intake",
  extract_communication_intake: "communication_intake", draft_communication_reply: "communication_intake",
  set_communication_intake_resolution: "communication_intake", convert_communication_intake: "communication_intake",
  acknowledge_notification: "notifications", unacknowledge_notification: "notifications", archive_learning_rule: "learning",
  reactivate_learning_rule: "learning", archive_memory: "memory_model", get_metrics: "metrics", suggest_schedule: "calendar",
  get_recruitment_recommendation: "recruitment", merge_clients: "data_quality",
  check_capacity: "employees", update_communication: "communications", update_portfolio_photo: "photos",
  create_playbook: "playbooks", update_playbook: "playbooks", run_playbook: "playbooks", create_website_audit: "website_audit",
  prepare_website_content: "website_content", decide_website_content: "website_content", list_reference_activities: "services",
  activate_reference_activity: "services",
  start_gmail_oauth: "connectors", start_google_contacts_oauth: "connectors", start_google_calendar_oauth: "connectors",
  start_google_drive_oauth: "connectors", start_google_photos_oauth: "connectors", sync_gmail: "connectors",
  sync_google_contacts: "connectors", sync_google_calendar: "connectors", disconnect_gmail: "connectors",
  disconnect_google_contacts: "connectors", disconnect_google_calendar: "connectors", disconnect_google_drive: "connectors",
  disconnect_google_photos: "connectors", disconnect_whatsapp: "connectors",
  update_connector_source: "connectors", disable_connector_source: "connectors", enable_connector_source: "connectors",
  create_gmail_draft: "connectors", delete_gmail_message: "connectors", import_google_contact: "connectors",
  create_google_photos_picker: "photo_selection", stage_google_photos: "photo_selection", register_google_photos_photo: "photos",
  stage_google_drive_images: "photo_selection", register_google_drive_photo: "photos", find_photos_for_service: "photo_selection",
  select_photos_for_service: "photo_selection", update_employee: "employees",
  update_emma_behavior: "learning", update_emma_permissions: "emma_permissions",
};

export const EMMA_EXECUTABLE_ACTION_GUIDE = Object.entries(EMMA_EXECUTABLE_ACTIONS)
  .map(([name, definition]) => `- ${name} {${definition.fields}}${definition.confirmation === "service_preview" ? "; preview only, explicit confirmation remains required" : ""}`)
  .join("\n");

// These contracts are still mirrored in administrator settings, but are not
// exposed as arbitrary spoken commands. Secret-entry and provider-callback
// flows must stay in their owning UI/system boundary.
export const EMMA_NON_DIRECT_ACTIONS = {
  approve_device_pairing: { executionClass: "interactive", note: "Requires the one-time pairing token in the authenticated browser." },
  change_own_password: { executionClass: "interactive", note: "Passwords are entered in the account form and are never spoken or stored in transcripts." },
  create_employee: { executionClass: "interactive", note: "Initial employee passwords remain in the administrator form and are never spoken." },
  reset_employee_password: { executionClass: "interactive", note: "Temporary passwords remain in the administrator form and are never spoken." },
  complete_gmail_oauth: { executionClass: "system", note: "Provider callback completed by Google after authorization." },
  complete_google_contacts_oauth: { executionClass: "system", note: "Provider callback completed by Google after authorization." },
  complete_google_calendar_oauth: { executionClass: "system", note: "Provider callback completed by Google after authorization." },
  complete_google_drive_oauth: { executionClass: "system", note: "Provider callback completed by Google after authorization." },
  complete_google_photos_oauth: { executionClass: "system", note: "Provider callback completed by Google after authorization." },
  receive_whatsapp_message: { executionClass: "system", note: "Executed only from a verified Meta webhook." },
  sync_whatsapp_sender_contacts: { executionClass: "system", note: "Runs inside the verified WhatsApp webhook transaction." },
  execute_text_command: { executionClass: "system", note: "Audit wrapper around every Emma command, not a separate user operation." },
  prepare_voice_email_deletion: { executionClass: "superseded", note: "Handled by the generic delete_gmail_message reviewed action." },
  confirm_voice_email_deletion: { executionClass: "superseded", note: "Handled by confirm action for delete_gmail_message." },
  cancel_voice_email_deletion: { executionClass: "superseded", note: "Handled by cancel action for delete_gmail_message." },
} as const;

export const EMMA_DYNAMIC_COMMAND_ACTIONS = [
  "register_connector_source",
  "sync_gmail_messages",
  "sync_google_contacts",
  "sync_google_calendar",
  "send_gmail_message",
  "delete_all_notifications",
] as const;
