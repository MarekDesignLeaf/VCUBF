import { z } from "zod";
import {
  BUSINESS_CONTEXT_CATEGORIES,
  CANDIDATE_STAGES,
  COMMUNICATION_CHANNELS,
  CONTACT_CHANNELS,
  CONTACT_LANGUAGES,
  DOCUMENT_SENSITIVITIES,
  DOCUMENT_SOURCES,
  DOCUMENT_TYPES,
  JOB_OPENING_STATUSES,
  JOB_OPENING_URGENCY_LEVELS,
  QUOTE_STATUSES,
  TASK_STATUSES,
} from "./actionContracts.js";

// This catalogue is the explicit bridge between natural language and the
// application's real, permission-checked workflows. It deliberately uses a
// small canonical JSON envelope rather than letting a model construct routes
// or SQL. Every action below is validated again by its owning service.

const nonEmpty = z.string().trim().min(1);
const optionalText = z.string().trim().min(1).optional();
const isoDateTime = z.string().datetime();
const nonNegative = z.number().finite().min(0);
const positive = z.number().finite().positive();

const priceLineSchema = z
  .object({
    description: nonEmpty,
    quantity: positive.default(1),
    unit_price: nonNegative,
    unit_cost: nonNegative.optional(),
  })
  .strict();

const invoiceLineSchema = z
  .object({
    description: nonEmpty,
    quantity: positive.default(1),
    unit_price: nonNegative,
  })
  .strict();

export const voiceActionSchemas = {
  create_contact: z
    .object({
      display_name: nonEmpty,
      email: z.string().trim().email().optional(),
      phone: optionalText,
      client_name: optionalText,
      job_title: optionalText,
      department: optionalText,
      preferred_channel: z.enum(CONTACT_CHANNELS).optional(),
      preferred_language: z.enum(CONTACT_LANGUAGES).optional(),
      notes: optionalText,
    })
    .strict(),
  archive_contact: z.object({ contact_name: nonEmpty }).strict(),

  create_document: z
    .object({
      title: nonEmpty,
      document_type: z.enum(DOCUMENT_TYPES),
      document_reference: nonEmpty,
      source: z.enum(DOCUMENT_SOURCES).optional(),
      sensitivity: z.enum(DOCUMENT_SENSITIVITIES).optional(),
      client_name: optionalText,
      job_title: optionalText,
      issued_at: isoDateTime.optional(),
      expires_at: isoDateTime.optional(),
      notes: optionalText,
    })
    .strict(),
  archive_document: z.object({ document_title: nonEmpty }).strict(),

  set_task_status: z.object({ task_title: nonEmpty, task_status: z.enum(TASK_STATUSES) }).strict(),

  create_business_context: z
    .object({
      category: z.enum(BUSINESS_CONTEXT_CATEGORIES),
      label: nonEmpty,
      value: nonEmpty,
      notes: optionalText,
    })
    .strict(),
  archive_business_context: z.object({ label: nonEmpty }).strict(),

  create_industry: z.object({ name: nonEmpty, description: optionalText, notes: optionalText }).strict(),
  archive_industry: z.object({ name: nonEmpty }).strict(),
  link_industry_service: z.object({ industry_name: nonEmpty, service_name: nonEmpty, notes: optionalText }).strict(),
  archive_industry_service_link: z.object({ industry_name: nonEmpty, service_name: nonEmpty }).strict(),
  set_service_active: z.object({ service_name: nonEmpty, is_active: z.boolean() }).strict(),

  // Who she is, said out loud. The name and the hotword are separate: she can
  // be called Petra and answer to "hej sekretarko".
  set_assistant_name: z.object({ name: z.string().trim().min(1).max(40) }).strict(),
  set_hotword: z.object({ hotword: z.string().trim().min(2).max(30) }).strict(),
  // Either an exact multiplier or a direction, because "speak faster" is how
  // this gets asked and the speaker does not know the current value.
  set_speech_rate: z
    .object({
      rate: z.number().finite().min(0.5).max(2).optional(),
      change: z.enum(["faster", "slower", "normal"]).optional(),
    })
    .strict()
    .refine((value) => value.rate !== undefined || value.change !== undefined, {
      message: "provide rate or change",
    }),

  create_quote: z
    .object({
      client_name: nonEmpty,
      title: nonEmpty,
      items: z.array(priceLineSchema).min(1),
      job_title: optionalText,
      notes: optionalText,
      valid_until: isoDateTime.optional(),
    })
    .strict(),
  set_quote_status: z.object({ quote_title: nonEmpty, quote_status: z.enum(QUOTE_STATUSES) }).strict(),

  create_invoice: z
    .object({
      client_name: nonEmpty,
      invoice_number: nonEmpty,
      title: nonEmpty,
      items: z.array(invoiceLineSchema).min(1),
      issue_date: isoDateTime.optional(),
      due_date: isoDateTime.optional(),
      notes: optionalText,
    })
    .strict(),
  issue_invoice: z.object({ invoice_number: nonEmpty }).strict(),
  record_invoice_payment: z
    .object({
      invoice_number: nonEmpty,
      amount: positive,
      paid_at: isoDateTime.optional(),
      method: optionalText,
      reference: optionalText,
    })
    .strict(),

  add_job_resource: z
    .object({
      job_title: nonEmpty,
      resource_type: z.enum(["material", "equipment", "vehicle", "hire", "waste"]),
      name: nonEmpty,
      quantity: positive.optional(),
      unit: optionalText,
      estimated_cost: nonNegative.optional(),
      notes: optionalText,
    })
    .strict(),
  set_job_resource_status: z
    .object({
      job_title: nonEmpty,
      resource_name: nonEmpty,
      requirement_status: z.enum(["needed", "ordered", "ready", "unavailable"]),
    })
    .strict(),
  set_job_resource_cost: z
    .object({
      job_title: nonEmpty,
      resource_name: nonEmpty,
      actual_cost: nonNegative.optional(),
      estimated_cost: nonNegative.optional(),
    })
    .strict()
    .refine((value) => value.actual_cost !== undefined || value.estimated_cost !== undefined, {
      message: "actual_cost or estimated_cost is required",
    }),

  create_job_opening: z
    .object({
      title: nonEmpty,
      reason: optionalText,
      urgency: z.enum(JOB_OPENING_URGENCY_LEVELS).optional(),
      skills_required: z.array(nonEmpty).optional(),
      expected_tasks: optionalText,
      min_experience_years: nonNegative.optional(),
      preferred_experience_years: nonNegative.optional(),
      language_requirements: z.array(nonEmpty).optional(),
      availability_requirements: optionalText,
      description: optionalText,
    })
    .strict(),
  set_job_opening_status: z.object({ title: nonEmpty, opening_status: z.enum(JOB_OPENING_STATUSES) }).strict(),
  draft_job_advert: z.object({ title: nonEmpty }).strict(),
  create_candidate: z
    .object({
      job_opening_title: nonEmpty,
      name: nonEmpty,
      email: z.string().trim().email().optional(),
      phone: optionalText,
      notes: optionalText,
    })
    .strict(),
  set_candidate_stage: z.object({ candidate_name: nonEmpty, stage: z.enum(CANDIDATE_STAGES) }).strict(),

  create_communication_intake: z
    .object({
      channel: z.enum(COMMUNICATION_CHANNELS),
      message_text: nonEmpty,
      sender_name: optionalText,
      sender_email: z.string().trim().email().optional(),
      sender_phone: optionalText,
      received_at: isoDateTime.optional(),
      source_reference: optionalText,
    })
    .strict(),
  extract_communication_intake: z.object({ sender_or_message: nonEmpty }).strict(),
  draft_communication_reply: z.object({ sender_or_message: nonEmpty }).strict(),
  set_communication_intake_resolution: z
    .object({ sender_or_message: nonEmpty, resolution_needed: z.boolean() })
    .strict(),
  convert_communication_intake: z
    .object({ sender_or_message: nonEmpty, client_name: optionalText })
    .strict(),

  acknowledge_notification: z.object({ notification_key: nonEmpty }).strict(),
  unacknowledge_notification: z.object({ notification_key: nonEmpty }).strict(),
  archive_learning_rule: z.object({ term: nonEmpty }).strict(),
  reactivate_learning_rule: z.object({ term: nonEmpty }).strict(),
  archive_memory: z.object({ content: nonEmpty }).strict(),

  get_unpaid_invoices: z.object({}).strict(),
  get_metrics: z.object({ from: isoDateTime.optional(), to: isoDateTime.optional() }).strict(),
  suggest_schedule: z
    .object({
      estimated_duration_hours: positive.optional(),
      required_skills: z.array(nonEmpty).optional(),
      weeks_ahead: z.number().int().min(1).max(26).optional(),
    })
    .strict(),
  get_recruitment_recommendation: z
    .object({
      weeks_ahead: z.number().int().min(1).max(26).optional(),
      minimum_repeated_weeks: z.number().int().min(1).max(26).optional(),
    })
    .strict(),

  merge_clients: z.object({ primary_client_name: nonEmpty, duplicate_client_name: nonEmpty }).strict(),
} as const;

export type VoiceActionName = keyof typeof voiceActionSchemas;
export type VoiceActionRequest = {
  [Name in VoiceActionName]: {
    action: Name;
    parameters: z.infer<(typeof voiceActionSchemas)[Name]>;
  };
}[VoiceActionName];

export function isVoiceActionName(value: string): value is VoiceActionName {
  return Object.prototype.hasOwnProperty.call(voiceActionSchemas, value);
}

export function parseVoiceActionRequest(action: string, parameters: unknown): VoiceActionRequest | undefined {
  if (!isVoiceActionName(action)) return undefined;
  const parsed = voiceActionSchemas[action].safeParse(parameters);
  return parsed.success ? ({ action, parameters: parsed.data } as VoiceActionRequest) : undefined;
}

export function validateVoiceActionParameters(action: string, parameters: unknown):
  | { success: true; data: Record<string, unknown> }
  | { success: false; message: string; issues: z.ZodIssue[] } {
  if (!isVoiceActionName(action)) {
    return parameters && typeof parameters === "object" && !Array.isArray(parameters)
      ? { success: true, data: parameters as Record<string, unknown> }
      : { success: false, message: "Action parameters must be an object.", issues: [] };
  }
  const parsed = (voiceActionSchemas[action] as z.ZodTypeAny).safeParse(parameters);
  return parsed.success
    ? { success: true, data: parsed.data as Record<string, unknown> }
    : { success: false, message: parsed.error.issues.map((issue) => issue.message).join("; "), issues: parsed.error.issues };
}

// Canonical format used only between the language model and this deterministic
// parser. Users can speak naturally; the assistant must emit exact JSON here.
export function parseVoiceActionCommand(rawText: string): VoiceActionRequest | undefined {
  const match = rawText.trim().match(/^voice\s+action\s+([a-z_]+)\s*:?\s*(\{[\s\S]*\})$/i);
  if (!match) return undefined;
  try {
    return parseVoiceActionRequest(match[1].toLowerCase(), JSON.parse(match[2]));
  } catch {
    return undefined;
  }
}

export const VOICE_ACTION_GUIDE = `
Additional executable Secretary voice actions use exactly this canonical form:
voice action ACTION_NAME JSON_OBJECT
The JSON must be valid, contain only the documented fields and preserve every user-provided value exactly. Use one action only when every required value is explicit; otherwise ask a short clarification. Do not invent data, IDs, dates, prices, status, or a source.

- create_contact {"display_name","email?","phone?","client_name?","job_title?","department?","preferred_channel?","preferred_language?","notes?"}
- archive_contact {"contact_name"}
- create_document {"title","document_type","document_reference","source?","sensitivity?","client_name?","job_title?","issued_at?","expires_at?","notes?"}
- archive_document {"document_title"}
- set_task_status {"task_title","task_status"}; task_status is open, in_progress, completed or cancelled
- create_business_context {"category","label","value","notes?"}; category is company_profile, industry, activity, region, pricing_rule, work_rule, communication_tone, approval_rule, capacity_rule, website, social_profile, external_profile, marketing_text, document or other
- archive_business_context {"label"}
- create_industry {"name","description?","notes?"}; archive_industry {"name"}
- link_industry_service {"industry_name","service_name","notes?"}; archive_industry_service_link {"industry_name","service_name"}
- set_assistant_name {"name"}; what to call the assistant, separate from the hotword
- set_hotword {"hotword"}; the word or phrase that wakes her
- set_speech_rate {"rate?"|"change?"}; rate is 0.5 to 2.0, change is faster, slower or normal
- set_service_active {"service_name","is_active"}
- create_quote {"client_name","title","items":[{"description","quantity?","unit_price","unit_cost?"}],"job_title?","notes?","valid_until?"}
- set_quote_status {"quote_title","quote_status"}; quote_status is draft, sent, accepted, rejected or expired
- create_invoice {"client_name","invoice_number","title","items":[{"description","quantity?","unit_price"}],"issue_date?","due_date?","notes?"}
- issue_invoice {"invoice_number"}; record_invoice_payment {"invoice_number","amount","paid_at?","method?","reference?"}. A payment is always previewed and needs a separate confirmation.
- add_job_resource {"job_title","resource_type","name","quantity?","unit?","estimated_cost?","notes?"}; resource_type is material, equipment, vehicle, hire or waste
- set_job_resource_status {"job_title","resource_name","requirement_status"}; status is needed, ordered, ready or unavailable
- set_job_resource_cost {"job_title","resource_name","actual_cost?","estimated_cost?"}
- create_job_opening {"title","reason?","urgency?","skills_required?","expected_tasks?","min_experience_years?","preferred_experience_years?","language_requirements?","availability_requirements?","description?"}
- set_job_opening_status {"title","opening_status"}; status is draft, open or closed
- draft_job_advert {"title"}; create_candidate {"job_opening_title","name","email?","phone?","notes?"}; set_candidate_stage {"candidate_name","stage"}
- create_communication_intake {"channel","message_text","sender_name?","sender_email?","sender_phone?","received_at?","source_reference?"}
- extract_communication_intake {"sender_or_message"}; draft_communication_reply {"sender_or_message"}; set_communication_intake_resolution {"sender_or_message","resolution_needed"}
- convert_communication_intake {"sender_or_message","client_name?"}. Conversion is previewed and needs a separate confirmation.
- acknowledge_notification {"notification_key"}; unacknowledge_notification {"notification_key"}
- archive_learning_rule {"term"}; reactivate_learning_rule {"term"}; archive_memory {"content"}
- get_metrics {"from?","to?"}; suggest_schedule {"estimated_duration_hours?","required_skills?","weeks_ahead?"}; get_recruitment_recommendation {"weeks_ahead?","minimum_repeated_weeks?"}
- merge_clients {"primary_client_name","duplicate_client_name"}. This is always previewed and needs a separate confirmation.

For a pending voice action, use exactly "confirm action" only after an explicit yes, or "cancel action" after an explicit no. Never claim a previewed action has happened before confirmation.
`.trim();
