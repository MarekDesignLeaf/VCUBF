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
 * - Review. Destructive (archiving), irreversible (lead conversion) and
 *   financial (invoice issue or void) tools never act on the first call: it
 *   returns the exact preview and a confirmation_id. Only confirm_action with
 *   that id, from the same user and the same OAuth client, within ten minutes,
 *   runs it, and only if the preview computed again at that moment is still
 *   identical. Nothing here sends, publishes or deletes.
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
import { assertNotInSafeMode } from "../../lib/safeMode.js";
import { evaluateEmmaCapabilities } from "../../services/emmaPolicyService.js";
import { fail, ok, type ServiceResult } from "../../services/result.js";
import * as clientService from "../../services/clientService.js";
import * as contactService from "../../services/contactService.js";
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

interface WriteToolDefinition {
  name: string;
  title: string;
  description: string;
  contract: ActionContract;
  kind: Kind;
  /** Why a reviewed tool waits for a yes. */
  reviewReason?: "destructive" | "irreversible" | "financial";
  /** Ids and other envelope fields, checked here. */
  fields: Record<string, z.ZodTypeAny>;
  /** The record itself, checked by the owning service. */
  body?: Body;
  /** Direct: the change. Reviewed: the change, run only after the yes. */
  run: (user: AuthedUser, args: Record<string, any>) => Promise<ServiceResult<unknown>>;
  /** Reviewed only: exactly what the change will do, without doing any of it. */
  preview?: (user: AuthedUser, args: Record<string, any>) => Promise<ServiceResult<unknown>>;
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
  });
}

// The transitions changeInvoiceStatus allows. The service checks them again
// when the change runs; this copy only refuses a preview that could not run.
function invoiceTransitionAllowed(from: string, to: string) {
  return (from === "draft" && (to === "issued" || to === "void")) || (from === "issued" && to === "void");
}

async function invoiceStatusPreview(user: AuthedUser, args: Record<string, any>): Promise<ServiceResult<unknown>> {
  const invoice = await invoiceService.getInvoice(user, args.invoice_id);
  if (!invoice) return fail(404, "INVOICE_NOT_FOUND");
  if (invoice.invoiceStatus === args.invoice_status) return fail(409, "NO_CHANGE", `The invoice is already ${args.invoice_status}.`);
  if (!invoiceTransitionAllowed(invoice.invoiceStatus, args.invoice_status)) return fail(409, "INVALID_INVOICE_STATUS_TRANSITION");
  return ok(200, {
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
    title: invoice.title,
    client: invoice.client.displayName,
    statusBefore: invoice.invoiceStatus,
    statusAfter: args.invoice_status,
    totals: invoice.totals,
    issueDateAfter: args.invoice_status === "issued" ? (invoice.issueDate?.toISOString() ?? "the moment of confirmation") : invoice.issueDate?.toISOString() ?? null,
    note: args.invoice_status === "void"
      ? "A void invoice cannot be issued or edited again."
      : "An issued invoice can no longer be edited; it can only be voided. Nothing is sent to the client.",
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
    kind: "reviewed",
    reviewReason: "destructive",
    fields: { client_id: id("client_id") },
    preview: (user, a) => servicePreview(clientService.archiveClient(user, a.client_id, {})),
    run: (user, a) => clientService.archiveClient(user, a.client_id, { confirmed: true }),
  },
  {
    name: "create_contact",
    title: "Create a contact",
    description: "Record a person with an e-mail or phone, optionally linked to a client by client_id.",
    contract: CREATE_CONTACT_ACTION,
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
    kind: "reviewed",
    reviewReason: "destructive",
    fields: { contact_id: id("contact_id") },
    preview: (user, a) => servicePreview(contactService.archiveContact(user, a.contact_id, {})),
    run: (user, a) => contactService.archiveContact(user, a.contact_id, { confirmed: true }),
  },
  {
    name: "create_lead",
    title: "Create a lead",
    description: "Record a new enquiry (lead) with the details the user gave.",
    contract: CREATE_LEAD_ACTION,
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
    kind: "reviewed",
    reviewReason: "irreversible",
    fields: { lead_id: id("lead_id") },
    preview: convertLeadPreview,
    run: (user, a) => leadService.convertLead(user, a.lead_id),
  },
  {
    name: "create_job",
    title: "Create a job",
    description: "Create a job (zakázka) for an existing client, named by client_id.",
    contract: CREATE_JOB_ACTION,
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
    kind: "reviewed",
    reviewReason: "financial",
    fields: { invoice_id: id("invoice_id"), invoice_status: z.enum(["issued", "void"]).describe("issued: a draft becomes a final invoice. void: an invoice is cancelled for good.") },
    preview: invoiceStatusPreview,
    run: (user, a) => invoiceService.changeInvoiceStatus(user, a.invoice_id, { invoice_status: a.invoice_status }),
  },
];

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

function jsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = zodToJsonSchema(schema, { $refStrategy: "none" }) as Record<string, unknown>;
  return { type: "object", ...rest };
}

export interface McpWriteToolListing {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: false; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: false };
}

/** The write tools this person may use: only those whose permission the account has. */
export function writeToolListings(user: AuthedUser): McpWriteToolListing[] {
  const offered = WRITE_TOOLS.filter((tool) => user.permissions.includes(tool.contract.requiredPermission));
  const listings: McpWriteToolListing[] = offered.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description:
      tool.description +
      (tool.kind === "direct"
        ? " Requires an idempotency_key."
        : " Show the returned preview to the user word for word and call confirm_action only after the user explicitly says yes."),
    inputSchema: jsonSchema(envelopeSchema(tool, true)),
    annotations: {
      readOnlyHint: false,
      destructiveHint: tool.reviewReason === "destructive" || tool.reviewReason === "irreversible" || tool.reviewReason === "financial",
      idempotentHint: true,
      openWorldHint: false,
    },
  }));
  if (offered.some((tool) => tool.kind === "reviewed")) {
    listings.push(
      {
        name: MCP_CONFIRM_TOOL,
        title: "Confirm a previewed change",
        description:
          "Carry out a change that was previewed (archive, lead conversion, invoice issue or void). Call this only after showing the preview to the user and receiving their explicit yes in this conversation. Each confirmation_id works once, for ten minutes, and only for the newest preview.",
        inputSchema: jsonSchema(confirmationArguments),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      },
      {
        name: MCP_CANCEL_TOOL,
        title: "Cancel a previewed change",
        description: "Withdraw a previewed change the user does not want. Nothing is changed.",
        inputSchema: jsonSchema(confirmationArguments),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
    );
  }
  return listings;
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
 * Runs work at most once per key within the company. A later call with the
 * same key and fingerprint gets the stored answer; with another fingerprint it
 * is refused. A thrown error leaves nothing stored, so the call can be retried.
 */
async function onceOnly(
  user: AuthedUser,
  phase: WriteOutcome["phase"],
  key: string,
  fingerprint: string,
  work: () => Promise<WriteOutcome>,
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
      if (existing.expiresAt <= new Date()) {
        await prisma.idempotencyRecord.deleteMany({ where: { id: existing.id, expiresAt: { lte: new Date() } } });
        continue;
      }
      if (existing.fingerprint !== fingerprint) return mismatch();
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
    let outcome: WriteOutcome;
    try {
      outcome = await work();
    } catch (error) {
      await prisma.idempotencyRecord.deleteMany({ where: { companyId: user.companyId, key, status: "in_progress" } });
      throw error;
    }
    const { contract: _contract, ...storable } = outcome;
    await prisma.idempotencyRecord.updateMany({
      where: { companyId: user.companyId, key },
      data: { status: "completed", responseStatus: outcome.ok ? 200 : 409, responseBody: { outcome: storable } as unknown as Prisma.InputJsonValue },
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
    `mcp:${caller.clientId}:${caller.user.id}:${key}`,
    fingerprint,
    async () => {
      await assertNotInSafeMode(caller.user.companyId);
      return asOutcome(await tool.run(caller.user, operation), "direct", tool.contract);
    },
    () => ({
      ok: false, phase: "direct", contract: tool.contract,
      payload: { ok: false, error: "IDEMPOTENCY_KEY_REUSED", message: "This idempotency_key was already used for a different change. Use a new key for a new change." },
    }),
  );
}

async function prepare(caller: McpCaller, tool: WriteToolDefinition, args: Record<string, any>): Promise<WriteOutcome> {
  await assertNotInSafeMode(caller.user.companyId);
  const preview = await tool.preview!(caller.user, args);
  if (!preview.ok) return asOutcome(preview, "prepare", tool.contract);
  const review = await prepareReviewedAction(caller.user, MCP_REVIEW, {
    tool: tool.name,
    arguments: args,
    clientId: caller.clientId,
    previewDigest: sha256(canonical(preview.data)),
  });
  return {
    ok: true,
    phase: "prepare",
    contract: tool.contract,
    confirmationId: review.id,
    payload: {
      ok: true,
      status: "confirmation_required",
      confirmation_id: review.id,
      expires_at: review.expiresAt.toISOString(),
      action: tool.name,
      reason: tool.reviewReason,
      preview: preview.data,
      instruction: "Nothing has changed yet. Show this preview to the user exactly as given and call confirm_action with this confirmation_id only after the user explicitly agrees. Otherwise call cancel_action.",
    },
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

async function confirm(caller: McpCaller, confirmationId: string): Promise<WriteOutcome> {
  const fingerprint = sha256(canonical({ user: caller.user.id, client: caller.clientId, confirmationId }));
  // Keyed by connection and person as well: an attempt from anyone else is
  // stored under its own key and can neither block nor answer the real yes.
  return onceOnly(caller.user, "confirm", `mcp-confirm:${caller.clientId}:${caller.user.id}:${confirmationId}`, fingerprint, async () => {
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
    const permitted = await allowed(caller.user, tool.contract);
    if (!permitted.ok) {
      await claimed.complete(false);
      return { ...asOutcome(permitted, "confirm", tool.contract), confirmationId };
    }
    const now = await tool.preview!(caller.user, claimed.payload.arguments);
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
    const result = await tool.run(caller.user, claimed.payload.arguments);
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
    const parsed = confirmationArguments.safeParse(rawArgs ?? {});
    if (!parsed.success) return validationFailure(`${name} takes exactly one confirmation_id.`, phase);
    return phase === "confirm" ? confirm(caller, parsed.data.confirmation_id) : cancel(caller, parsed.data.confirmation_id);
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
