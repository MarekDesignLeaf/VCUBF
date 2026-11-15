/**
 * MCP gateway, write tools (voice assistant master document 1.1a, step P2c).
 *
 * What an external AI client may change in Secretary, written down once as
 * structured data: each tool names the Action Contract it carries out, the
 * owning service that carries it out, and whether it runs at once or only
 * after an exact preview and an explicit yes. There is no general "write"
 * tool: a change the list below does not name cannot be made from here.
 *
 * The rules every write keeps, whatever the tool:
 *
 * - Scope. Only an OAuth access token the person approved for secretary.write,
 *   and only while MCP_WRITE_ENABLED is on (routes.ts checks both before any
 *   tool here is reached). The owner's own Secretary token stays read only.
 * - Permission and switches. The contract's requiredPermission must be on the
 *   account, a temporary password must have been replaced, and the
 *   administrator's capability switch for that contract must be on
 *   (evaluateEmmaCapabilities, the same decision voice commands get).
 * - Tenant. Records are named by id only, never matched by name, and every
 *   owning service looks them up inside the caller's company.
 * - Validation. The arguments the tool takes are checked here only for their
 *   envelope (ids, keys); the record itself is passed unchanged to the owning
 *   service, whose own Zod schema is the single source of truth.
 * - Repeats. A direct write needs an idempotency_key: the first call with it
 *   runs, every later call with the same key and arguments gets the first
 *   answer back, and the same key with different arguments is refused. A
 *   confirmation runs once; repeating it gets the first answer back.
 * - Review. Destructive (archiving), irreversible (lead conversion),
 *   financial (invoice issue or void), classification (approving, rejecting,
 *   reopening or deferring a WhatsApp sender) and permanent (deleting a contact) tools never act on
 *   the first call: it returns the exact preview and a confirmation_id. Only
 *   confirm_action with that id, from the same user and the same OAuth client,
 *   within ten minutes, runs it, and only if the preview computed again at that
 *   moment is still identical. Permanent deletion also needs the record's exact
 *   name, typed by the user, passed to confirm_action; a wrong name consumes
 *   nothing. Nothing here e-mails or publishes; the messages it sends are the
 *   phone and WhatsApp Business tools (deviceTools.ts, each previewed and sent
 *   once). The only deletion of a CRM record is the guarded
 *   delete_contact_permanently; PC file deletions are previewed PC steps the
 *   PC backs up and approves again.
 * - Emergency stop. The gateway refuses every POST during a stop; the engine
 *   refuses to claim a review; and every write here checks it once more.
 */

import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { prisma } from "../../db.js";
import type { AuthedUser } from "../../middleware/auth.js";
import {
  ARCHIVE_CLIENT_ACTION,
  ARCHIVE_CONTACT_ACTION,
  ASSIGN_JOB_ACTION,
  CHANGE_INVOICE_STATUS_ACTION,
  CHANGE_JOB_STATUS_ACTION,
  CHANGE_QUOTE_STATUS_ACTION,
  CONVERT_LEAD_ACTION,
  CREATE_CLIENT_ACTION,
  CREATE_CONTACT_ACTION,
  CREATE_INVOICE_ACTION,
  CREATE_JOB_ACTION,
  CREATE_LEAD_ACTION,
  CREATE_QUOTE_ACTION,
  CREATE_TASK_ACTION,
  DELETE_CONTACT_PERMANENTLY_ACTION,
  REVIEW_WHATSAPP_SENDER_ACTION,
  UPDATE_CLIENT_ACTION,
  UPDATE_CONTACT_ACTION,
  UPDATE_INVOICE_ACTION,
  UPDATE_LEAD_ACTION,
  UPDATE_QUOTE_ACTION,
  UPDATE_TASK_ACTION,
  type ActionContract,
} from "../../lib/actionContracts.js";
import {
  cancelReviewedActionById,
  claimReviewedAction,
  prepareReviewedAction,
  reviewedActionById,
  runWithApprovalBinding,
  type ReviewedActionDefinition,
} from "../../lib/executionEngine.js";
import { assertNotInSafeMode, SafeModeActiveError, whileNotInSafeMode } from "../../lib/safeMode.js";
import { RESERVED_IDEMPOTENCY_PREFIX } from "../../middleware/idempotency.js";
import { EMMA_CAPABILITIES, evaluateEmmaCapabilities } from "../../services/emmaPolicyService.js";
import { fail, ok, type ServiceResult } from "../../services/result.js";
import { MCP_RESULT_CHARS } from "./gate.js";
import { deviceWriteTools } from "./deviceTools.js";
import { availability, schemaFields, type McpAvailabilityReason, type McpCapability, type McpCatalogueEntry } from "./capabilities.js";
import * as clientService from "../../services/clientService.js";
import * as contactService from "../../services/contactService.js";
import * as permanentDeletion from "../../services/crmPermanentDeletionService.js";
import * as senderReview from "../../services/whatsappSenderReviewService.js";
import * as invoiceService from "../../services/invoiceService.js";
import * as jobService from "../../services/jobService.js";
import * as leadService from "../../services/leadService.js";
import * as quoteService from "../../services/quoteService.js";
import * as taskService from "../../services/taskService.js";

export const MCP_CONFIRM_TOOL = "confirm_action";
export const MCP_CANCEL_TOOL = "cancel_action";
/** How long a previewed change waits for its confirmation. */
export const MCP_REVIEW_LIFETIME_MS = 10 * 60 * 1000;
/** How long an idempotency key keeps the first answer. */
export const MCP_IDEMPOTENCY_HOURS = 24;
/** Longest a direct write's transaction may stay open (MCP_WRITE_TRANSACTION_MS overrides). */
export function mcpWriteTransactionMs(): number {
  const configured = Number(process.env.MCP_WRITE_TRANSACTION_MS);
  // Short: an emergency stop waits for changes already under way, at most this long.
  return Number.isFinite(configured) && configured > 0 ? configured : 15_000;
}

/** Who is calling: the person, and the OAuth client the person approved. */
export interface McpCaller {
  user: AuthedUser;
  clientId: string;
}

/** What a write call produced, as the client and the audit see it. */
export interface WriteOutcome {
  ok: boolean;
  payload: unknown;
  /** direct: ran at once; prepare: preview put up; confirm/cancel: a preview answered. */
  phase: "direct" | "prepare" | "confirm" | "cancel";
  /** The answer is the stored first answer to the same key or confirmation. */
  replayed?: boolean;
  /** The preview this call put up or answered. */
  confirmationId?: string;
  contract?: ActionContract;
}

// ---------------------------------------------------------------------------
// Argument envelopes.

const id = (what: string) => z.string().uuid(`${what} must be the record's id`).describe(`The ${what} exactly as a Secretary read returned it.`);

export const idempotencyKeySchema = z
  .string()
  .trim()
  .min(8)
  .max(120)
  .regex(/^[A-Za-z0-9._:-]+$/, "idempotency_key may contain letters, digits and . _ : - only")
  .describe(
    "A new unique value (for example a UUID) for each distinct change. Send the same value again only when retrying this exact call; the change is then not made twice.",
  );

/** The record a tool passes to its owning service, described for the client. */
interface Body {
  key: string;
  schema: z.ZodTypeAny;
  description: string;
}

type Kind = "direct" | "reviewed";
type ReviewReason = "destructive" | "irreversible" | "financial" | "classification" | "permanent";

/** What a confirmed change knows about its own confirmation. */
export interface WriteRunContext {
  /** The confirmation_id a reviewed change runs under (stable across a retry of the same yes). */
  confirmationId?: string;
}

export interface WriteToolDefinition {
  name: string;
  title: string;
  description: string;
  contract: ActionContract;
  /**
   * What a successful call changes, for describe_capabilities. Required: a
   * new tool cannot compile without saying what it does to Secretary.
   */
  sideEffects: string;
  kind: Kind;
  /** Why a reviewed tool waits for a yes. */
  reviewReason?: ReviewReason;
  /** Ids and other envelope fields, checked here. */
  fields: Record<string, z.ZodTypeAny>;
  /** The record itself, checked by the owning service. */
  body?: Body;
  /**
   * Direct: the change. Reviewed: the change, run only after the yes, with the
   * preview just verified against the one the person approved.
   */
  run: (user: AuthedUser, args: Record<string, any>, verifiedPreview?: any, context?: WriteRunContext) => Promise<ServiceResult<unknown>>;
  /** Reviewed only: exactly what the change will do, without doing any of it. */
  preview?: (user: AuthedUser, args: Record<string, any>) => Promise<ServiceResult<unknown>>;
  /**
   * Reviewed only: text the user must type back, taken from the preview (the
   * record's exact name). confirm_action must carry it as confirm_display_name.
   */
  typedConfirmation?: (preview: any) => string;
  /**
   * A tool backed by an external system that may not be set up for this
   * company (the owner's phone or PC): false makes it unavailable here, with
   * the reason connector_not_configured.
   */
  available?: (user: AuthedUser) => boolean;
  /** Contacts someone outside the company (sends a message): replaces "nothing is messaged". */
  external?: boolean;
  /** What a client must know beyond the description. */
  limitations?: string[];
}

const record = (key: string, schema: z.ZodTypeAny, description: string): Body => ({ key, schema, description });

// ---------------------------------------------------------------------------
// Previews for the reviewed tools.

/** A service that answers an unconfirmed call with 409 CONFIRMATION_REQUIRED and a preview: that preview. */
async function servicePreview(result: Promise<ServiceResult<unknown>>): Promise<ServiceResult<unknown>> {
  const answer = await result;
  if (answer.ok) return fail(500, "PREVIEW_EXECUTED", "The owning service acted without confirmation.");
  if (answer.error !== "CONFIRMATION_REQUIRED") return answer;
  return ok(200, answer.extra?.preview ?? {});
}

async function convertLeadPreview(user: AuthedUser, args: Record<string, any>): Promise<ServiceResult<unknown>> {
  const lead = await prisma.lead.findFirst({ where: { id: args.lead_id, companyId: user.companyId } });
  if (!lead) return fail(404, "LEAD_NOT_FOUND");
  if (lead.leadStatus === "converted" && lead.convertedClientId) {
    return fail(409, "UNSUPPORTED_ACTION", "This lead has already been converted.", { clientId: lead.convertedClientId });
  }
  // The same lookup convertLead makes: a client with the lead's e-mail is linked, not duplicated.
  const existing = lead.email
    ? await prisma.client.findFirst({ where: { companyId: user.companyId, emailPrimary: lead.email }, select: { id: true, displayName: true } })
    : null;
  return ok(200, {
    lead: { id: lead.id, name: lead.name, email: lead.email, phone: lead.phone, status: lead.leadStatus },
    outcome: existing ? "link_existing_client" : "create_new_client",
    client: existing ?? { displayName: lead.name, email: lead.email, phone: lead.phone },
    leadStatusAfter: "converted",
    irreversible: "A converted lead cannot be turned back into an open lead.",
    revision: lead.updatedAt.toISOString(),
  });
}

// The transitions changeInvoiceStatus allows. The service checks them again
// when the change runs; this copy only refuses a preview that could not run.
function invoiceTransitionAllowed(from: string, to: string) {
  return (from === "draft" && (to === "issued" || to === "void")) || (from === "issued" && to === "void");
}

/**
 * The preview of an invoice status change is the whole financial document as
 * it stands: number, client, title, every line with its description, quantity
 * and unit price in order, dates, payment terms in the notes, payments and
 * totals, and the record's revision. The confirmation is bound to a hash of
 * exactly this, so any change to the document after it was shown (lines
 * swapped for others with the same total, a new due date, an edited note)
 * makes confirm_action refuse with PREVIEW_CHANGED instead of issuing or
 * voiding a document the person did not see.
 */
async function invoiceStatusPreview(user: AuthedUser, args: Record<string, any>): Promise<ServiceResult<unknown>> {
  const invoice = await invoiceService.getInvoice(user, args.invoice_id);
  if (!invoice) return fail(404, "INVOICE_NOT_FOUND");
  if (invoice.invoiceStatus === args.invoice_status) return fail(409, "NO_CHANGE", `The invoice is already ${args.invoice_status}.`);
  if (!invoiceTransitionAllowed(invoice.invoiceStatus, args.invoice_status)) return fail(409, "INVALID_INVOICE_STATUS_TRANSITION");
  const day = (value: Date | null) => value?.toISOString() ?? null;
  return ok(200, {
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
    title: invoice.title,
    client: { id: invoice.client.id, displayName: invoice.client.displayName },
    statusBefore: invoice.invoiceStatus,
    statusAfter: args.invoice_status,
    items: invoice.items.map((item) => ({
      position: item.sortOrder,
      description: item.description,
      quantity: item.quantity,
      unitPrice: Number(item.unitPrice),
      lineTotal: Math.round((item.quantity * Number(item.unitPrice) + Number.EPSILON) * 100) / 100,
    })),
    totals: invoice.totals,
    issueDate: day(invoice.issueDate),
    issueDateAfter: args.invoice_status === "issued" ? (day(invoice.issueDate) ?? "the moment of confirmation") : day(invoice.issueDate),
    dueDate: day(invoice.dueDate),
    notes: invoice.notes,
    payments: invoice.payments.map((payment) => ({
      amount: Number(payment.amount), paidAt: day(payment.paidAt), method: payment.method, reference: payment.reference,
    })),
    revision: day(invoice.updatedAt),
    note: args.invoice_status === "void"
      ? "A void invoice cannot be issued or edited again."
      : "An issued invoice can no longer be edited; it can only be voided. Nothing is sent to the client.",
  });
}

// WhatsApp sender review (PR #73 workflow). The sender is named by id; its
// source is the one it was staged from, inside the caller's company.

async function senderSourceId(user: AuthedUser, senderId: string): Promise<ServiceResult<string>> {
  const sender = await senderReview.findWhatsAppSender(user, senderId);
  return sender ? ok(200, sender.connectorSourceId) : fail(404, "WHATSAPP_SENDER_NOT_FOUND", "That WhatsApp sender was not found.");
}

function approvalInput(args: Record<string, any>) {
  return {
    decision: "approve_customer" as const,
    ...(args.import_as ? { import_as: args.import_as } : {}),
    ...(args.client_id ? { client_id: args.client_id } : {}),
    ...(args.display_name ? { display_name: args.display_name } : {}),
    ...(args.note ? { note: args.note } : {}),
  };
}

async function approveSenderPreview(user: AuthedUser, args: Record<string, any>): Promise<ServiceResult<unknown>> {
  const sourceId = await senderSourceId(user, args.sender_id);
  if (!sourceId.ok) return sourceId;
  const answer = await senderReview.reviewWhatsAppSender(user, sourceId.data, args.sender_id, approvalInput(args));
  // Already approved with a live contact: the service answers without changing anything.
  if (answer.ok) return fail(409, "ALREADY_APPROVED", "This sender is already in CRM as a customer contact.", { result: answer.data });
  if (answer.error !== "CONFIRMATION_REQUIRED") return answer;
  const plan = answer.extra?.preview as Record<string, unknown>;
  return ok(200, {
    ...plan,
    importAs: args.import_as ?? "contact",
    note: args.note ?? null,
    effect: "The sender is classified as a customer and the CRM contact (and client, if shown) above is created or linked. Existing CRM data is never overwritten. WhatsApp messages are kept unchanged and nothing is sent.",
  });
}

async function senderDecisionPreview(user: AuthedUser, args: Record<string, any>, decision: "reject" | "reopen" | "mark_review_needed") {
  return senderReview.previewWhatsAppSenderDecision(user, args.sender_id, {
    decision,
    ...(decision === "reject" ? { classification: args.classification } : {}),
    ...(args.note ? { note: args.note } : {}),
  });
}

async function runSenderDecision(user: AuthedUser, args: Record<string, any>, decision: "reject" | "reopen" | "mark_review_needed", expectedRevision?: string) {
  const sourceId = await senderSourceId(user, args.sender_id);
  if (!sourceId.ok) return sourceId;
  return senderReview.reviewWhatsAppSender(user, sourceId.data, args.sender_id, {
    decision,
    ...(decision === "reject" ? { classification: args.classification } : {}),
    ...(args.note ? { note: args.note } : {}),
    ...(expectedRevision ? { expected_revision: expectedRevision } : {}),
  });
}

/**
 * The permanent-deletion preview of crmPermanentDeletionService, whole: the
 * exact identity, client and connector links, what is kept, and its digest.
 */
async function deleteContactPreview(user: AuthedUser, args: Record<string, any>): Promise<ServiceResult<unknown>> {
  const preview = await permanentDeletion.previewContactPermanentDeletion(user, args.contact_id);
  if (!preview.ok) return preview;
  const data = preview.data as { canDelete: boolean; displayName: string };
  if (!data.canDelete) return fail(409, "DELETION_BLOCKED", `${data.displayName} cannot be deleted permanently because other records depend on it. Archive it instead.`, { preview: data });
  return ok(200, {
    ...data,
    warning: "Permanent deletion cannot be undone. archive_contact is the reversible alternative. The contact's client, staged connector records, WhatsApp and other messages and the audit history are kept.",
  });
}

// ---------------------------------------------------------------------------
// The tools.

const WRITE_TOOLS: WriteToolDefinition[] = [
  {
    name: "create_client",
    title: "Create a client",
    description: "Create a new client in Secretary from details the user gave. Use only real details; never invent an e-mail, phone or address. A likely duplicate is refused with the matching client.",
    contract: CREATE_CLIENT_ACTION,
    sideEffects: "Creates one active client record in the caller's company.",
    kind: "direct",
    fields: {},
    body: record("client", clientService.createClientSchema, "The client as the user described it."),
    run: (user, a) => clientService.createClient(user, a.client),
  },
  {
    name: "update_client",
    title: "Update a client",
    description: "Change details of an existing active client. Send only the fields that change.",
    contract: UPDATE_CLIENT_ACTION,
    sideEffects: "Changes the named fields of one active client.",
    kind: "direct",
    fields: { client_id: id("client_id") },
    body: record("changes", clientService.updateClientSchema, "Only the fields to change."),
    run: (user, a) => clientService.updateClient(user, a.client_id, a.changes),
  },
  {
    name: "archive_client",
    title: "Archive a client (preview first)",
    description: "Prepare archiving a client. Returns a preview and a confirmation_id; nothing changes until confirm_action is called after the user explicitly agrees. Jobs, quotes, invoices and history are kept.",
    contract: ARCHIVE_CLIENT_ACTION,
    sideEffects: "After confirmation, marks one client archived (inactive); its jobs, quotes, invoices and history are kept and it can be restored in Secretary.",
    kind: "reviewed",
    reviewReason: "destructive",
    fields: { client_id: id("client_id") },
    preview: (user, a) => servicePreview(clientService.archiveClient(user, a.client_id, {})),
    // Archived only as the client that was approved, compared under the row
    // lock of the archive, and never once the emergency stop has committed.
    run: (user, a, verified) => clientService.archiveClient(user, a.client_id, {
      confirmed: true,
      ...(verified ? { expected_revision: verified.revision, expected_display_name: verified.displayName } : {}),
    }, { safeModeLocked: true }),
  },
  {
    name: "create_contact",
    title: "Create a contact",
    description: "Record a person with an e-mail or phone, optionally linked to a client by client_id.",
    contract: CREATE_CONTACT_ACTION,
    sideEffects: "Creates one CRM contact, optionally linked to an existing client.",
    kind: "direct",
    fields: {},
    body: record("contact", contactService.createContactSchema, "The contact as the user described it."),
    run: (user, a) => contactService.createContact(user, a.contact),
  },
  {
    name: "update_contact",
    title: "Update a contact",
    description: "Change details of an existing contact, or relink it to another client. Send only the fields that change.",
    contract: UPDATE_CONTACT_ACTION,
    sideEffects: "Changes the named fields of one contact or its client link.",
    kind: "direct",
    fields: { contact_id: id("contact_id") },
    body: record("changes", contactService.updateContactSchema, "Only the fields to change."),
    run: (user, a) => contactService.updateContact(user, a.contact_id, a.changes),
  },
  {
    name: "archive_contact",
    title: "Archive a contact (preview first)",
    description: "Prepare archiving a contact. Returns a preview and a confirmation_id; nothing changes until confirm_action is called after the user explicitly agrees.",
    contract: ARCHIVE_CONTACT_ACTION,
    sideEffects: "After confirmation, marks one contact archived (inactive); it can be restored in Secretary.",
    kind: "reviewed",
    reviewReason: "destructive",
    fields: { contact_id: id("contact_id") },
    preview: (user, a) => servicePreview(contactService.archiveContact(user, a.contact_id, {})),
    // Archived only as the contact that was approved (name, client link,
    // revision), compared under the row lock of the archive.
    run: (user, a, verified) => contactService.archiveContact(user, a.contact_id, {
      confirmed: true,
      ...(verified ? { expected_revision: verified.revision, expected_display_name: verified.displayName, expected_client_id: verified.client?.id ?? null } : {}),
    }, { safeModeLocked: true }),
  },
  {
    name: "create_lead",
    title: "Create a lead",
    description: "Record a new enquiry (lead) with the details the user gave.",
    contract: CREATE_LEAD_ACTION,
    sideEffects: "Creates one lead (enquiry) record.",
    kind: "direct",
    fields: {},
    body: record("lead", leadService.createLeadSchema, "The lead as the user described it."),
    run: (user, a) => leadService.createLead(user, a.lead),
  },
  {
    name: "update_lead",
    title: "Update a lead or its status",
    description: "Correct a lead's details or set its status (new, contacted, qualified, lost). Converting is a separate tool.",
    contract: UPDATE_LEAD_ACTION,
    sideEffects: "Changes one lead's details or status.",
    kind: "direct",
    fields: { lead_id: id("lead_id") },
    body: record("changes", leadService.updateLeadSchema, "Only the fields to change."),
    run: (user, a) => leadService.updateLead(user, a.lead_id, a.changes),
  },
  {
    name: "convert_lead",
    title: "Convert a lead to a client (preview first)",
    description: "Prepare converting a lead into a client. Returns a preview (new client, or the existing client with the same e-mail) and a confirmation_id; nothing changes until confirm_action is called after the user explicitly agrees.",
    contract: CONVERT_LEAD_ACTION,
    sideEffects: "After confirmation, marks the lead converted and creates a new client or links the existing client with the same e-mail. Cannot be undone.",
    kind: "reviewed",
    reviewReason: "irreversible",
    fields: { lead_id: id("lead_id") },
    preview: convertLeadPreview,
    // Converted only as the revision the person approved, under the lead's row lock.
    // The outcome is bound as well: the same existing client, or a new one.
    run: (user, a, verified) => leadService.convertLead(user, a.lead_id, verified
      ? {
          expectedRevision: verified.revision,
          expectedClient: verified.outcome === "link_existing_client" ? { id: verified.client.id, displayName: verified.client.displayName } : null,
          safeModeLocked: true,
        }
      : { safeModeLocked: true }),
  },
  {
    name: "create_job",
    title: "Create a job",
    description: "Create a job (zakázka) for an existing client, named by client_id.",
    contract: CREATE_JOB_ACTION,
    sideEffects: "Creates one job for an existing client.",
    kind: "direct",
    fields: {},
    body: record("job", jobService.createJobSchema, "The job as the user described it."),
    run: (user, a) => jobService.createJob(user, a.job),
  },
  {
    name: "change_job_status",
    title: "Change a job's status",
    description: "Set a job's lifecycle status.",
    contract: CHANGE_JOB_STATUS_ACTION,
    sideEffects: "Changes one job's lifecycle status.",
    kind: "direct",
    fields: { job_id: id("job_id") },
    body: record("change", jobService.changeStatusSchema, "The new status."),
    run: (user, a) => jobService.changeJobStatus(user, a.job_id, a.change),
  },
  {
    name: "assign_job",
    title: "Assign a job to an employee",
    description: "Assign a job to an employee by user id. The answer reports real workload against capacity, skill gaps and overload.",
    contract: ASSIGN_JOB_ACTION,
    sideEffects: "Assigns one job to an employee; reports workload against capacity.",
    kind: "direct",
    fields: { job_id: id("job_id") },
    body: record("assignment", jobService.assignJobSchema, "Who the job goes to."),
    run: (user, a) => jobService.assignJob(user, a.job_id, a.assignment),
  },
  {
    name: "create_task",
    title: "Create a task",
    description: "Create a task, optionally linked to a client, job or employee by id, with a due date.",
    contract: CREATE_TASK_ACTION,
    sideEffects: "Creates one task, optionally linked to a client, job or employee, with a due date.",
    kind: "direct",
    fields: {},
    body: record("task", taskService.createTaskSchema, "The task as the user described it."),
    run: (user, a) => taskService.createTask(user, a.task),
  },
  {
    name: "update_task",
    title: "Update a task or its status",
    description: "Change a task's content, assignment, due date, priority or status. Send only the fields that change.",
    contract: UPDATE_TASK_ACTION,
    sideEffects: "Changes one task's content, assignment, due date, priority or status.",
    kind: "direct",
    fields: { task_id: id("task_id") },
    body: record("changes", taskService.updateTaskSchema, "Only the fields to change."),
    run: (user, a) => taskService.updateTask(user, a.task_id, a.changes),
  },
  {
    name: "create_quote",
    title: "Create a draft quote",
    description: "Create a draft quote for a client from line items with prices the user gave. Never invent a price. Nothing is sent.",
    contract: CREATE_QUOTE_ACTION,
    sideEffects: "Creates one draft quote with the line items and prices given. Nothing is sent.",
    kind: "direct",
    fields: {},
    body: record("quote", quoteService.createQuoteSchema, "The quote as the user described it."),
    run: (user, a) => quoteService.createQuote(user, a.quote),
  },
  {
    name: "update_quote",
    title: "Update a quote",
    description: "Change a quote's title, notes, validity or line items (items replace the whole list).",
    contract: UPDATE_QUOTE_ACTION,
    sideEffects: "Changes one quote's title, notes, validity or its whole list of line items.",
    kind: "direct",
    fields: { quote_id: id("quote_id") },
    body: record("changes", quoteService.updateQuoteSchema, "Only the fields to change."),
    run: (user, a) => quoteService.updateQuote(user, a.quote_id, a.changes),
  },
  {
    name: "change_quote_status",
    title: "Change a quote's status",
    description: "Record a quote's status (draft, sent, accepted, rejected, expired). This only records it; nothing is sent to anyone.",
    contract: CHANGE_QUOTE_STATUS_ACTION,
    sideEffects: "Records a quote's status; nothing is sent to anyone.",
    kind: "direct",
    fields: { quote_id: id("quote_id") },
    body: record("change", quoteService.changeQuoteStatusSchema, "The new status."),
    run: (user, a) => quoteService.changeQuoteStatus(user, a.quote_id, a.change),
  },
  {
    name: "create_invoice_draft",
    title: "Create a draft invoice",
    description: "Create a draft invoice for a client from line items and an invoice number the user gave. It stays a draft; issuing is a separate, confirmed step. Nothing is sent.",
    contract: CREATE_INVOICE_ACTION,
    sideEffects: "Creates one draft invoice with the number and line items given. Nothing is sent.",
    kind: "direct",
    fields: {},
    body: record("invoice", invoiceService.createInvoiceSchema, "The invoice as the user described it."),
    run: (user, a) => invoiceService.createInvoice(user, a.invoice),
  },
  {
    name: "update_invoice_draft",
    title: "Update a draft invoice",
    description: "Change a draft invoice's number, title, dates, notes or line items (items replace the whole list). An issued invoice cannot be edited.",
    contract: UPDATE_INVOICE_ACTION,
    sideEffects: "Changes one draft invoice's number, title, dates, notes or its whole list of line items.",
    kind: "direct",
    fields: { invoice_id: id("invoice_id") },
    body: record("changes", invoiceService.updateInvoiceSchema, "Only the fields to change."),
    run: (user, a) => invoiceService.updateInvoice(user, a.invoice_id, a.changes),
  },
  {
    name: "change_invoice_status",
    title: "Issue or void an invoice (preview first)",
    description: "Prepare issuing a draft invoice or voiding an invoice. Returns a preview and a confirmation_id; nothing changes until confirm_action is called after the user explicitly agrees. Nothing is sent to the client.",
    contract: CHANGE_INVOICE_STATUS_ACTION,
    sideEffects: "After confirmation, issues a draft invoice (it can then only be voided) or voids an invoice for good. Nothing is sent to the client.",
    kind: "reviewed",
    reviewReason: "financial",
    fields: { invoice_id: id("invoice_id"), invoice_status: z.enum(["issued", "void"]).describe("issued: a draft becomes a final invoice. void: an invoice is cancelled for good.") },
    preview: invoiceStatusPreview,
    // The revision of the approved document goes with the change, and the
    // service makes it under a row lock only if the invoice is still that
    // revision: nothing edited between the check and the change gets issued.
    run: (user, a, verified) => invoiceService.changeInvoiceStatus(user, a.invoice_id, {
      invoice_status: a.invoice_status,
      ...(verified?.revision ? { expected_revision: verified.revision } : {}),
    }, { safeModeLocked: true }),
  },
];

WRITE_TOOLS.push(
  {
    name: "approve_whatsapp_sender",
    title: "Approve a WhatsApp sender as a customer (preview first)",
    description: "Prepare classifying a WhatsApp sender (from list_whatsapp_senders) as a real customer. Returns a preview of exactly which CRM contact (and optionally client) would be created or linked, and a confirmation_id; nothing changes until confirm_action is called after the user explicitly agrees. Only approve a sender the user has identified as a customer; never decide from the work signal alone. WhatsApp messages are kept unchanged and nothing is sent.",
    contract: REVIEW_WHATSAPP_SENDER_ACTION,
    sideEffects: "After confirmation, classifies the WhatsApp sender as a customer and creates or links the CRM contact (and client, if asked) shown in the preview. Existing CRM data and WhatsApp messages are not changed; nothing is sent.",
    kind: "reviewed",
    reviewReason: "classification",
    fields: {
      sender_id: id("sender_id"),
      import_as: z.enum(["contact", "contact_and_client"]).optional().describe("contact (default): a CRM contact only. contact_and_client: also create a client, unless client_id names an existing one."),
      client_id: id("client_id").optional().describe("Link the contact to this existing active client instead of creating one."),
      display_name: z.string().trim().min(1).max(200).optional().describe("The name to use in CRM, only if the user gave one; the WhatsApp profile name otherwise."),
      note: z.string().trim().max(1000).optional().describe("A short reason the user gave."),
    },
    preview: approveSenderPreview,
    // Approved only for the sender revision the person saw, re-planned under
    // the sender's row lock and the emergency-stop lock by the service.
    run: async (user, a, verified) => {
      const sourceId = await senderSourceId(user, a.sender_id);
      if (!sourceId.ok) return sourceId;
      return senderReview.reviewWhatsAppSender(user, sourceId.data, a.sender_id, {
        ...approvalInput(a),
        confirmed: true,
        ...(verified?.revision ? { expected_revision: verified.revision } : {}),
      });
    },
  },
  {
    name: "reject_whatsapp_sender",
    title: "Mark a WhatsApp sender as not a customer (preview first)",
    description: "Prepare classifying a WhatsApp sender as not a customer: personal, employee, subcontractor, supplier or other, as the user said. Returns a preview and a confirmation_id; nothing changes until confirm_action is called after the user explicitly agrees. Their messages are kept; they will not be added to CRM unless reopened. An existing CRM contact is kept (archive or delete it separately).",
    contract: REVIEW_WHATSAPP_SENDER_ACTION,
    sideEffects: "After confirmation, classifies the sender as not a customer with the given classification. Messages and any existing CRM contact are kept; nothing is sent.",
    kind: "reviewed",
    reviewReason: "classification",
    fields: {
      sender_id: id("sender_id"),
      classification: z.enum(senderReview.NOT_CUSTOMER_CLASSIFICATIONS).describe("Why the sender is not a customer, as the user said."),
      note: z.string().trim().max(1000).optional().describe("A short reason the user gave."),
    },
    preview: (user, a) => senderDecisionPreview(user, a, "reject"),
    run: (user, a, verified) => runSenderDecision(user, a, "reject", verified?.revision),
  },
  {
    name: "reopen_whatsapp_sender",
    title: "Reopen a WhatsApp sender's review (preview first)",
    description: "Prepare putting a sender that was rejected (or whose CRM contact was deleted permanently, or left for later) back into the review queue as pending, when the user says the earlier classification was wrong. Returns a preview and a confirmation_id; nothing changes until confirm_action is called after the user explicitly agrees. Nothing is added to CRM.",
    contract: REVIEW_WHATSAPP_SENDER_ACTION,
    sideEffects: "After confirmation, puts the sender back into the review queue as pending. Nothing is added to CRM.",
    kind: "reviewed",
    reviewReason: "classification",
    fields: { sender_id: id("sender_id"), note: z.string().trim().max(1000).optional().describe("A short reason the user gave.") },
    preview: (user, a) => senderDecisionPreview(user, a, "reopen"),
    run: (user, a, verified) => runSenderDecision(user, a, "reopen", verified?.revision),
  },
  {
    name: "defer_whatsapp_sender",
    title: "Leave a WhatsApp sender for later review (preview first)",
    description: "Prepare marking a pending sender as looked at but not decidable yet. Returns a preview and a confirmation_id; nothing changes until confirm_action is called after the user agrees. Nothing is added to CRM.",
    contract: REVIEW_WHATSAPP_SENDER_ACTION,
    sideEffects: "After confirmation, marks a pending sender as needing review later. Nothing is added to CRM.",
    kind: "reviewed",
    reviewReason: "classification",
    fields: { sender_id: id("sender_id"), note: z.string().trim().max(1000).optional().describe("A short reason the user gave.") },
    preview: (user, a) => senderDecisionPreview(user, a, "mark_review_needed"),
    run: (user, a, verified) => runSenderDecision(user, a, "mark_review_needed", verified?.revision),
  },
  {
    name: "delete_contact_permanently",
    title: "Delete a CRM contact permanently (preview, yes and typed name)",
    description: "Prepare removing a CRM contact for good. Use only when the user explicitly asks for permanent deletion, not archiving; archive_contact is the reversible default. Returns the exact contact, its client and connector links, what is kept, and a confirmation_id. Nothing changes until confirm_action is called with that confirmation_id and confirm_display_name set to the contact's exact name as the user typed it, after the user explicitly agrees. Never infer this from conversation alone.",
    contract: DELETE_CONTACT_PERMANENTLY_ACTION,
    sideEffects: "After confirmation with the typed name, deletes one CRM contact for good. Its client, staged connector records, messages and audit history are kept.",
    kind: "reviewed",
    reviewReason: "permanent",
    fields: { contact_id: id("contact_id") },
    preview: deleteContactPreview,
    typedConfirmation: (preview) => String(preview.displayName),
    // The service computes the preview again under the contact's row lock and
    // the emergency-stop lock; any difference from the approved digest refuses.
    run: (user, a, verified) => permanentDeletion.deleteContactPermanently(user, a.contact_id, verified
      ? { confirmed: true, preview_digest: verified.digest, confirm_display_name: verified.displayName }
      : {}),
  },
);

// The owner's phone (SMS Bridge) and PC (PC Control Plus): reviewed sends and PC steps.
WRITE_TOOLS.push(...deviceWriteTools(id));

export const MCP_WRITE_TOOLS: readonly WriteToolDefinition[] = WRITE_TOOLS;
const toolsByName = new Map(WRITE_TOOLS.map((tool) => [tool.name, tool]));

export function isWriteToolName(name: string): boolean {
  return toolsByName.has(name) || name === MCP_CONFIRM_TOOL || name === MCP_CANCEL_TOOL;
}

// ---------------------------------------------------------------------------
// What tools/list shows.

function envelopeSchema(tool: WriteToolDefinition, forDocumentation: boolean) {
  const shape: Record<string, z.ZodTypeAny> = { ...tool.fields };
  if (tool.body) shape[tool.body.key] = forDocumentation ? tool.body.schema.describe(tool.body.description) : z.record(z.unknown());
  if (tool.kind === "direct") shape.idempotency_key = idempotencyKeySchema;
  return z.object(shape).strict();
}

const confirmationArguments = z.object({
  confirmation_id: z.string().uuid().describe("The confirmation_id returned with the preview."),
}).strict();

const confirmArguments = confirmationArguments.extend({
  confirm_display_name: z.string().max(200).optional().describe(
    "Only for a permanent deletion: the record's exact name exactly as the user typed it. Never fill it in yourself.",
  ),
}).strict();

function jsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = zodToJsonSchema(schema, { $refStrategy: "none" }) as Record<string, unknown>;
  return { type: "object", ...rest };
}

export interface McpWriteToolListing {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: false; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
}

/** What the connection allows, decided by routes.ts from the server switch and the token's scopes. */
export interface McpWriteAccess {
  writeEnabled: boolean;
  writeScope: boolean;
}

/** The risk flags of a write tool, from its contract and its review reason. */
function classification(tool: WriteToolDefinition) {
  const reason = tool.reviewReason;
  const permanent = reason === "permanent";
  const financial = reason === "financial" || /invoice|quote/.test(tool.contract.actionName);
  const irreversible = reason === "irreversible" || reason === "financial" || permanent;
  // The tools/list destructiveHint, unchanged: anything a client should treat with care.
  const destructive = reason === "destructive" || irreversible;
  return { permanent, financial, irreversible, destructive };
}

const WRITE_LIMITATIONS = [
  "Records are named by id only, inside the caller's company; read the record first to get its id.",
  "Refused during the company's emergency stop, without the account permission, or when the administrator has switched the capability off.",
];
const NOTHING_SENT = "Nothing is e-mailed, messaged or published.";

/**
 * The administrator's switch for a contract, only if the assistant policy page
 * can actually turn it off; a capability marked not available to the assistant
 * (the WhatsApp sender review, permanent deletion) has none.
 */
function administratorSwitch(contract: ActionContract): string | null {
  const id = `action.${contract.actionName}`;
  const governed = EMMA_CAPABILITIES.find((capability) => capability.id === id);
  return governed && governed.availableToEmma !== false ? id : null;
}

function writeCapability(tool: WriteToolDefinition, listing: McpWriteToolListing): McpCapability {
  const flags = classification(tool);
  const typed = Boolean(tool.typedConfirmation);
  const capabilitySwitch = administratorSwitch(tool.contract);
  return {
    name: tool.name,
    title: tool.title,
    purpose: tool.description,
    access: "write",
    readOnly: false,
    oauthScope: "secretary.write",
    requiredPermission: tool.contract.requiredPermission,
    capabilitySwitch,
    actionContract: tool.contract.actionName,
    riskLevel: tool.contract.riskLevel,
    riskClass: tool.kind === "direct" ? "routine_write" : tool.reviewReason!,
    ...flags,
    confirmation: tool.kind === "direct" ? "none" : typed ? "preview_confirm_and_typed_name" : "preview_then_confirm",
    idempotency: tool.kind === "direct" ? "idempotency_key_required" : "once_per_confirmation_id",
    readsCompanyRecords: true,
    sideEffects: tool.sideEffects,
    limitations: [
      ...WRITE_LIMITATIONS,
      ...(tool.external ? ["This contacts someone outside the company; it is sent only after the preview and the user's explicit yes, and cannot be recalled."] : [NOTHING_SENT]),
      ...(tool.limitations ?? []),
      ...(capabilitySwitch ? [] : [
        `No separate administrator switch: governed by the server's write switch, this connection's secretary.write approval and the ${tool.contract.requiredPermission} permission.`,
      ]),
      ...(tool.kind === "direct"
        ? ["Needs a new idempotency_key for each distinct change; the same key repeats only the first answer."]
        : [
            `The first call changes nothing: it returns a preview and a confirmation_id that ${MCP_CONFIRM_TOOL} accepts once, within ten minutes, from the same user and connection.`,
            "Refused at confirmation if the record changed after the preview was shown (PREVIEW_CHANGED).",
            ...(typed ? [`${MCP_CONFIRM_TOOL} must carry confirm_display_name, the exact name typed by the user; a wrong name consumes nothing.`] : []),
          ]),
    ],
    audit: "mcp_write_tool",
    ...schemaFields(listing.inputSchema),
  };
}

function hasPermission(user: AuthedUser | undefined, permission: string) {
  return Boolean(user) && (permission === "authenticated" || user!.permissions.includes(permission));
}

/** Why this connection may or may not use a tool needing this permission. */
function writeReason(user: AuthedUser | undefined, access: McpWriteAccess, permission: string, tool?: WriteToolDefinition): McpAvailabilityReason {
  if (tool?.available && !(user && tool.available(user))) return "connector_not_configured";
  if (!access.writeEnabled) return "write_disabled_on_server";
  if (!access.writeScope) return "requires_write_scope";
  if (!hasPermission(user, permission)) return "missing_permission";
  return "available";
}

function confirmListings(): McpWriteToolListing[] {
  return [
    {
      name: MCP_CONFIRM_TOOL,
      title: "Confirm a previewed change",
      description:
        "Carry out a change that was previewed (archive, lead conversion, invoice issue or void, WhatsApp sender approval or rejection, permanent contact deletion). Call this only after showing the preview to the user and receiving their explicit yes in this conversation. A permanent deletion also needs confirm_display_name: the exact name, typed by the user. Each confirmation_id works once, for ten minutes, and only for the newest preview.",
      inputSchema: jsonSchema(confirmArguments),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    {
      name: MCP_CANCEL_TOOL,
      title: "Cancel a previewed change",
      description: "Withdraw a previewed change the user does not want. Nothing is changed.",
      inputSchema: jsonSchema(confirmationArguments),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
  ];
}

function answerCapability(listing: McpWriteToolListing): McpCapability {
  const confirming = listing.name === MCP_CONFIRM_TOOL;
  return {
    name: listing.name,
    title: listing.title,
    purpose: listing.description,
    access: "write",
    readOnly: false,
    oauthScope: "secretary.write",
    requiredPermission: "authenticated",
    // The previewed tool's own permission and switch are decided again at the moment of the yes.
    capabilitySwitch: null,
    actionContract: null,
    riskLevel: null,
    riskClass: "confirmation",
    destructive: confirming,
    irreversible: false,
    financial: false,
    permanent: false,
    confirmation: confirming ? "confirms_preview" : "withdraws_preview",
    idempotency: "once_per_confirmation_id",
    readsCompanyRecords: true,
    sideEffects: confirming
      ? "Carries out exactly the previewed change named by confirmation_id, with that tool's own side effects."
      : "Withdraws the previewed change; nothing in Secretary changes.",
    limitations: confirming
      ? [
          "Only a confirmation_id from this user and this connection, within ten minutes, once, and only the newest preview.",
          "The previewed tool's permission, administrator switch and emergency stop are checked again, and the preview is recomputed; any difference refuses it.",
          "Never call it without the user's explicit yes to the preview shown word for word.",
        ]
      : ["Only a confirmation_id from this user and this connection that is still waiting."],
    audit: "mcp_write_tool",
    ...schemaFields(listing.inputSchema),
  };
}

function toolListing(tool: WriteToolDefinition): McpWriteToolListing {
  return {
    name: tool.name,
    title: tool.title,
    description:
      tool.description +
      (tool.kind === "direct"
        ? " Requires an idempotency_key."
        : " Show the returned preview to the user word for word and call confirm_action only after the user explicitly says yes."),
    inputSchema: jsonSchema(envelopeSchema(tool, true)),
    annotations: { readOnlyHint: false, destructiveHint: classification(tool).destructive, idempotentHint: true, openWorldHint: Boolean(tool.external) },
  };
}

/**
 * Every write tool the gateway has, with its tools/list entry, its capability
 * metadata and whether this connection may use it. The single source for both
 * tools/list (the entries whose availability is listed) and
 * describe_capabilities (all of them): one cannot name a tool the other lacks.
 */
export function writeToolCatalogue(user: AuthedUser | undefined, access: McpWriteAccess): Array<McpCatalogueEntry & { listing: McpWriteToolListing }> {
  const entries = WRITE_TOOLS.map((tool) => {
    const listing = toolListing(tool);
    const reason = writeReason(user, access, tool.contract.requiredPermission, tool);
    return { listing, capability: writeCapability(tool, listing), availability: availability(reason, reason === "available"), reviewed: tool.kind === "reviewed" };
  });
  const anyReviewed = entries.some((entry) => entry.reviewed && entry.availability.listed);
  const answerReason: McpAvailabilityReason = anyReviewed ? "available" : writeReason(user, access, "authenticated") === "available" ? "no_previewed_tool_available" : writeReason(user, access, "authenticated");
  const answers = confirmListings().map((listing) => ({
    listing, capability: answerCapability(listing), availability: availability(answerReason, answerReason === "available"),
  }));
  return [...entries.map(({ reviewed: _reviewed, ...entry }) => entry), ...answers];
}

/** The write tools this person may use: only those whose permission the account has. */
export function writeToolListings(user: AuthedUser): McpWriteToolListing[] {
  return writeToolCatalogue(user, { writeEnabled: true, writeScope: true })
    .filter((entry) => entry.availability.listed)
    .map((entry) => entry.listing);
}

// ---------------------------------------------------------------------------
// Running a tool.

/** The canonical JSON of a value: keys sorted, so equal arguments fingerprint equally. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function failurePayload(result: Extract<ServiceResult<unknown>, { ok: false }>) {
  return { ok: false, error: result.error, message: result.message, ...(result.extra ? { details: result.extra } : {}) };
}

function asOutcome(result: ServiceResult<unknown>, phase: WriteOutcome["phase"], contract?: ActionContract): WriteOutcome {
  return result.ok
    ? { ok: true, phase, contract, payload: { ok: true, data: result.data } }
    : { ok: false, phase, contract, payload: failurePayload(result) };
}

/** The person may carry out this contract now: permission, password, switch. */
async function allowed(user: AuthedUser, contract: ActionContract): Promise<ServiceResult<true>> {
  if (user.mustChangePassword) return fail(403, "PASSWORD_CHANGE_REQUIRED", "Change the temporary password in Secretary first.");
  if (contract.requiredPermission !== "authenticated" && !user.permissions.includes(contract.requiredPermission)) {
    return fail(403, "MISSING_PERMISSION", `Missing required permission: ${contract.requiredPermission}`);
  }
  const decision = await evaluateEmmaCapabilities(user, [`action.${contract.actionName}`]);
  if (!decision.allowed) return fail(403, "NOT_ALLOWED", decision.message);
  return ok(200, true);
}

function isUniqueViolation(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

/**
 * Thrown by work after begin() when it is certain that nothing was changed:
 * the change ran in one transaction that rolled back (a direct write's
 * ambient transaction, or a reviewed service refusing under its emergency-stop
 * lock). The claim is released as if the change had never started.
 */
class NothingChanged extends Error {
  constructor(readonly original: unknown) {
    super("nothing changed");
  }
}

/** The answer kept for a key whose change may or may not have been made. */
const OUTCOME_UNKNOWN_MESSAGE =
  "The change may or may not have been saved: it failed after Secretary had started making it. It will not be repeated " +
  "with this key. Check the records with a reading tool before deciding whether to make it again with a new key.";

/**
 * Runs work at most once per key within the company. A later call with the
 * same key and fingerprint gets the stored answer; with another fingerprint it
 * is refused.
 *
 * work receives begin(), which it calls immediately before the first step
 * that can change anything. A failure before begin() changed nothing, so the
 * claim is released and the call may be retried. A failure after begin() has
 * an unknown outcome: an owning service may have saved its record and then
 * failed on its audit entry or a later step, outside any transaction. That
 * claim is kept as "unknown" and every retry with the key is told so; it is
 * never run again (master documentation section 44: an unknown outcome is
 * reconciled, never repeated). Neither an unknown nor an unfinished claim is
 * freed when its retention ends; only a finished answer expires.
 */
/** What an external send did, kept in its confirmation's idempotency record. */
export interface StoredOperation {
  tool: string;
  arguments: Record<string, unknown>;
}

async function onceOnly(
  user: AuthedUser,
  phase: WriteOutcome["phase"],
  key: string,
  fingerprint: string,
  work: (begin: (operation?: StoredOperation) => void) => Promise<WriteOutcome>,
  mismatch: () => WriteOutcome,
): Promise<WriteOutcome> {
  const expiresAt = new Date(Date.now() + MCP_IDEMPOTENCY_HOURS * 60 * 60 * 1000);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await prisma.idempotencyRecord.create({
        data: { companyId: user.companyId, userId: user.id, key, fingerprint, status: "in_progress", expiresAt },
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const existing = await prisma.idempotencyRecord.findUnique({ where: { companyId_key: { companyId: user.companyId, key } } });
      if (!existing) continue;
      if (existing.status === "completed" && existing.expiresAt <= new Date()) {
        await prisma.idempotencyRecord.deleteMany({ where: { id: existing.id, status: "completed", expiresAt: { lte: new Date() } } });
        continue;
      }
      if (existing.fingerprint !== fingerprint) return mismatch();
      if (existing.status === "unknown") {
        return { ok: false, phase, replayed: true, payload: { ok: false, error: "OUTCOME_UNKNOWN", message: OUTCOME_UNKNOWN_MESSAGE } };
      }
      if (existing.status !== "completed") {
        return {
          ok: false, phase,
          payload: { ok: false, error: "IDEMPOTENCY_IN_PROGRESS", message: "The first call with this key has not finished. Its outcome is unknown; do not repeat it with a new key." },
        };
      }
      const stored = existing.responseBody as { outcome?: WriteOutcome } | null;
      const outcome = stored?.outcome;
      if (!outcome) return { ok: false, phase, payload: { ok: false, error: "IDEMPOTENCY_RECORD_UNREADABLE" } };
      return { ...outcome, replayed: true };
    }
    let started = false;
    let operation: StoredOperation | undefined;
    let outcome: WriteOutcome;
    try {
      outcome = await work((what) => { started = true; operation = what; });
    } catch (error) {
      if (!started || error instanceof NothingChanged) {
        await prisma.idempotencyRecord.deleteMany({ where: { companyId: user.companyId, key, status: "in_progress" } });
        const original = error instanceof NothingChanged ? error.original : error;
        // A failure that rolled everything back is answered, not thrown: the
        // caller learns that nothing was saved and that retrying is safe.
        if (error instanceof NothingChanged && !(original instanceof SafeModeActiveError)) {
          console.error(`MCP write ${phase} failed and was rolled back; nothing was saved.`, original);
          return { ok: false, phase, payload: { ok: false, error: "WRITE_FAILED", message: "The change failed and nothing was saved. The same call may be retried with the same idempotency_key." } };
        }
        throw original;
      }
      console.error(`MCP write ${phase} failed after it started; its outcome is unknown and kept as such.`, error);
      const unknown: WriteOutcome = { ok: false, phase, payload: { ok: false, error: "OUTCOME_UNKNOWN", message: OUTCOME_UNKNOWN_MESSAGE } };
      await prisma.idempotencyRecord.updateMany({
        where: { companyId: user.companyId, key },
        data: { status: "unknown", responseStatus: 500, responseBody: { outcome: unknown, ...(operation ? { operation } : {}) } as unknown as Prisma.InputJsonValue },
      });
      return unknown;
    }
    const { contract: _contract, ...storable } = outcome;
    await prisma.idempotencyRecord.updateMany({
      where: { companyId: user.companyId, key },
      data: { status: "completed", responseStatus: outcome.ok ? 200 : 409, responseBody: { outcome: storable, ...(operation ? { operation } : {}) } as unknown as Prisma.InputJsonValue },
    });
    return outcome;
  }
  return { ok: false, phase, payload: { ok: false, error: "IDEMPOTENCY_IN_PROGRESS", message: "This key is busy; try again shortly." } };
}

// The review queue of the MCP gateway: its own action type, so a spoken "yes"
// for Alfonzo can never confirm a change previewed to an external client.
const reviewPayloadSchema = z.object({
  tool: z.string(),
  arguments: z.record(z.unknown()),
  clientId: z.string(),
  previewDigest: z.string(),
  /** The text the user must type back to confirm, when the tool asks for one. */
  typedConfirmation: z.string().optional(),
});
type ReviewPayload = z.infer<typeof reviewPayloadSchema>;

export const MCP_REVIEW: ReviewedActionDefinition<ReviewPayload> = {
  actionType: "mcp_write_review",
  lifetimeMs: MCP_REVIEW_LIFETIME_MS,
  payloadSchema: reviewPayloadSchema,
  replacedStatus: "replaced",
};

function validationFailure(message: string, phase: WriteOutcome["phase"], contract?: ActionContract): WriteOutcome {
  return { ok: false, phase, contract, payload: { ok: false, error: "VALIDATION_FAILED", message } };
}

async function runDirect(caller: McpCaller, tool: WriteToolDefinition, args: Record<string, any>): Promise<WriteOutcome> {
  const { idempotency_key: key, ...operation } = args;
  const fingerprint = sha256(canonical({ user: caller.user.id, client: caller.clientId, tool: tool.name, operation }));
  return onceOnly(
    caller.user,
    "direct",
    // Scoped to this person and this connection, so nobody else's key can block or answer theirs.
    // In the gateway's own namespace, which no Idempotency-Key header can reach.
    `${RESERVED_IDEMPOTENCY_PREFIX}direct:${caller.clientId}:${caller.user.id}:${key}`,
    fingerprint,
    async (begin) => {
      await assertNotInSafeMode(caller.user.companyId);
      // One transaction for the whole change, holding the company's stop
      // lock shared: the owning service's writes and its audit entry commit
      // with the emergency-stop check, or not at all. A stop committed first
      // is refused before anything starts; a stop requested meanwhile waits
      // for this change, and changes after it wait for the stop. A failure
      // inside rolls everything back, so nothing was saved and the same key
      // may be tried again.
      let rolledBack = false;
      try {
        return await whileNotInSafeMode(caller.user.companyId, async () => {
          begin();
          try {
            return asOutcome(await tool.run(caller.user, operation), "direct", tool.contract);
          } catch (error) {
            rolledBack = true;
            throw error;
          }
        }, mcpWriteTransactionMs());
      } catch (error) {
        throw rolledBack ? new NothingChanged(error) : error;
      }
    },
    () => ({
      ok: false, phase: "direct", contract: tool.contract,
      payload: { ok: false, error: "IDEMPOTENCY_KEY_REUSED", message: "This idempotency_key was already used for a different change. Use a new key for a new change." },
    }),
  );
}

function preparedPayload(tool: WriteToolDefinition, preview: unknown, confirmationId: string, expiresAt: Date) {
  const typed = tool.typedConfirmation?.(preview);
  return {
    ok: true,
    status: "confirmation_required",
    confirmation_id: confirmationId,
    expires_at: expiresAt.toISOString(),
    action: tool.name,
    reason: tool.reviewReason,
    preview,
    ...(typed !== undefined ? { confirm_display_name_required: typed } : {}),
    instruction: typed !== undefined
      ? "Nothing has changed yet. This cannot be undone. Show this preview to the user exactly as given, ask whether they want it deleted permanently, and ask them to type the exact name shown in confirm_display_name_required. Call confirm_action with this confirmation_id and confirm_display_name set to what the user typed only after their explicit yes. Otherwise call cancel_action."
      : "Nothing has changed yet. Show this preview to the user exactly as given and call confirm_action with this confirmation_id only after the user explicitly agrees. Otherwise call cancel_action.",
  };
}

async function prepare(caller: McpCaller, tool: WriteToolDefinition, args: Record<string, any>): Promise<WriteOutcome> {
  await assertNotInSafeMode(caller.user.companyId);
  const preview = await tool.preview!(caller.user, args);
  if (!preview.ok) return asOutcome(preview, "prepare", tool.contract);
  // The person approves what they were shown, so the preview must reach them
  // whole. A result longer than the gateway hands back would be cut, and the
  // cut-off part (later lines, totals, terms) would still be carried out on
  // confirmation. Such a change is refused before any review exists: it has
  // no confirmation_id, and it is made in Secretary itself.
  const measured = JSON.stringify(preparedPayload(tool, preview.data, "00000000-0000-0000-0000-000000000000", new Date()));
  if (measured.length > MCP_RESULT_CHARS) {
    return {
      ok: false,
      phase: "prepare",
      contract: tool.contract,
      payload: {
        ok: false,
        error: "PREVIEW_TOO_LARGE",
        message: "The record is too large to show in full here, so it cannot be approved through this connection. Nothing was changed and nothing waits for confirmation. Make this change in Secretary.",
        previewCharacters: measured.length,
        limit: MCP_RESULT_CHARS,
      },
    };
  }
  const review = await prepareReviewedAction(caller.user, MCP_REVIEW, {
    tool: tool.name,
    arguments: args,
    clientId: caller.clientId,
    previewDigest: sha256(canonical(preview.data)),
    ...(tool.typedConfirmation ? { typedConfirmation: tool.typedConfirmation(preview.data) } : {}),
  });
  return {
    ok: true,
    phase: "prepare",
    contract: tool.contract,
    confirmationId: review.id,
    payload: preparedPayload(tool, preview.data, review.id, review.expiresAt),
  };
}

/** The waiting review behind a confirmation id, if it is this caller's own. */
async function ownReview(caller: McpCaller, confirmationId: string) {
  const review = await reviewedActionById(caller.user, MCP_REVIEW.actionType, confirmationId);
  if (!review) return { state: "missing" as const };
  if (review.status !== "pending") return { state: "resolved" as const, status: review.status };
  const payload = reviewPayloadSchema.safeParse(review.payload);
  if (!payload.success || payload.data.clientId !== caller.clientId) return { state: "missing" as const };
  return { state: "pending" as const, payload: payload.data };
}

const notFound = (phase: WriteOutcome["phase"]): WriteOutcome => ({
  ok: false, phase, payload: { ok: false, error: "CONFIRMATION_NOT_FOUND", message: "There is no previewed change with this confirmation_id for this connection." },
});

async function confirm(caller: McpCaller, confirmationId: string, typedText?: string): Promise<WriteOutcome> {
  // A tool that needs the name typed back checks it before anything else, and
  // a wrong or missing name consumes nothing: the review keeps waiting, and no
  // answer is stored under the confirmation's key.
  const waiting = await ownReview(caller, confirmationId);
  if (waiting.state === "pending" && waiting.payload.typedConfirmation !== undefined
    && (typedText ?? "").trim() !== waiting.payload.typedConfirmation.trim()) {
    return {
      ok: false, phase: "confirm", confirmationId, contract: toolsByName.get(waiting.payload.tool)?.contract,
      payload: {
        ok: false, error: "CONFIRMATION_TEXT_MISMATCH",
        message: `Nothing was changed. Ask the user to type the exact name "${waiting.payload.typedConfirmation}" and pass it as confirm_display_name.`,
      },
    };
  }
  const fingerprint = sha256(canonical({ user: caller.user.id, client: caller.clientId, confirmationId }));
  // Keyed by connection and person as well: an attempt from anyone else is
  // stored under its own key and can neither block nor answer the real yes.
  return onceOnly(caller.user, "confirm", `${RESERVED_IDEMPOTENCY_PREFIX}confirm:${caller.clientId}:${caller.user.id}:${confirmationId}`, fingerprint, async (begin) => {
    const review = await ownReview(caller, confirmationId);
    if (review.state === "missing") return { ...notFound("confirm"), confirmationId };
    if (review.state === "resolved") {
      return {
        ok: false, phase: "confirm", confirmationId,
        payload: { ok: false, error: "CONFIRMATION_ALREADY_USED", message: `This preview is no longer waiting (${review.status}). Prepare the change again.` },
      };
    }
    const tool = toolsByName.get(review.payload.tool);
    // Exactly this review and nothing newer: the approval binding refuses a claim of any other.
    const bound = await runWithApprovalBinding(confirmationId, () => claimReviewedAction(caller.user, MCP_REVIEW));
    const claimed = bound.result;
    if (!claimed.ok) {
      return {
        ok: false, phase: "confirm", confirmationId, contract: tool?.contract,
        payload: { ok: false, error: "CONFIRMATION_ALREADY_USED", message: "This preview was replaced, used or cancelled. Prepare the change again." },
      };
    }
    if (!tool || tool.kind !== "reviewed") {
      await claimed.complete(false);
      return { ok: false, phase: "confirm", confirmationId, payload: { ok: false, error: "PENDING_ACTION_INVALID" } };
    }
    // Everything is decided again at the moment of the yes: the permission and
    // switch may have changed, and the record may have moved since the preview.
    // A failure here, before the change starts, still resolves the claim, so a
    // review never stays "executing" for a change that was never attempted.
    let now: ServiceResult<unknown>;
    try {
      const permitted = await allowed(caller.user, tool.contract);
      if (!permitted.ok) {
        await claimed.complete(false);
        return { ...asOutcome(permitted, "confirm", tool.contract), confirmationId };
      }
      now = await tool.preview!(caller.user, claimed.payload.arguments);
    } catch (error) {
      await claimed.complete(false).catch(() => undefined);
      throw error;
    }
    if (!now.ok || sha256(canonical(now.data)) !== claimed.payload.previewDigest) {
      await claimed.complete(false);
      return {
        ok: false, phase: "confirm", confirmationId, contract: tool.contract,
        payload: {
          ok: false, error: "PREVIEW_CHANGED",
          message: "The record changed after the preview was shown, so nothing was done. Prepare the change again and show the new preview.",
          ...(now.ok ? { preview: now.data } : { details: failurePayload(now) }),
        },
      };
    }
    // The emergency stop may have been switched on while the permission and
    // the preview were checked. Checked once more here, and again inside the
    // owning service's transaction, serialised with the switch. A refusal
    // closes this review: it is never left waiting or executing, and the
    // change has to be prepared and approved again after the stop.
    try {
      await assertNotInSafeMode(caller.user.companyId);
    } catch (error) {
      await claimed.complete(false).catch(() => undefined);
      throw error;
    }
    // An external send keeps what it sent next to its outcome (the review's
    // payload is cleared once it resolves), so its state can be looked up and
    // an unknown outcome reconciled later. It expires with the record.
    begin(tool.external ? { tool: tool.name, arguments: claimed.payload.arguments } : undefined);
    let result: ServiceResult<unknown>;
    try {
      result = await tool.run(caller.user, claimed.payload.arguments, now.data, { confirmationId });
    } catch (error) {
      if (error instanceof SafeModeActiveError) {
        await claimed.complete(false).catch(() => undefined);
        throw new NothingChanged(error);
      }
      throw error;
    }
    await claimed.complete(result.ok);
    return { ...asOutcome(result, "confirm", tool.contract), confirmationId };
  }, () => ({ ...notFound("confirm"), confirmationId }));
}

async function cancel(caller: McpCaller, confirmationId: string): Promise<WriteOutcome> {
  const review = await ownReview(caller, confirmationId);
  if (review.state !== "pending") return { ...notFound("cancel"), confirmationId };
  const cancelled = await cancelReviewedActionById(caller.user, MCP_REVIEW.actionType, confirmationId);
  return cancelled
    ? { ok: true, phase: "cancel", confirmationId, payload: { ok: true, cancelled: true, message: "The previewed change was withdrawn. Nothing was changed." } }
    : { ...notFound("cancel"), confirmationId };
}

/** One write tool call, after routes.ts has checked the scope and the switch. */
export async function runWriteTool(caller: McpCaller, name: string, rawArgs: unknown): Promise<WriteOutcome> {
  if (name === MCP_CONFIRM_TOOL || name === MCP_CANCEL_TOOL) {
    const phase = name === MCP_CONFIRM_TOOL ? "confirm" : "cancel";
    if (phase === "confirm") {
      const parsed = confirmArguments.safeParse(rawArgs ?? {});
      if (!parsed.success) return validationFailure(`${name} takes a confirmation_id and, for a permanent deletion, confirm_display_name.`, phase);
      return confirm(caller, parsed.data.confirmation_id, parsed.data.confirm_display_name);
    }
    const parsed = confirmationArguments.safeParse(rawArgs ?? {});
    if (!parsed.success) return validationFailure(`${name} takes exactly one confirmation_id.`, phase);
    return cancel(caller, parsed.data.confirmation_id);
  }
  const tool = toolsByName.get(name);
  if (!tool) return validationFailure(`Unknown write tool: ${name}`, "direct");
  const phase = tool.kind === "direct" ? "direct" : "prepare";
  const parsed = envelopeSchema(tool, false).safeParse(rawArgs ?? {});
  if (!parsed.success) {
    return validationFailure(parsed.error.issues.map((issue) => `${issue.path.join(".") || "arguments"}: ${issue.message}`).join("; "), phase, tool.contract);
  }
  const permitted = await allowed(caller.user, tool.contract);
  if (!permitted.ok) return asOutcome(permitted, phase, tool.contract);
  return tool.kind === "direct" ? runDirect(caller, tool, parsed.data) : prepare(caller, tool, parsed.data);
}
