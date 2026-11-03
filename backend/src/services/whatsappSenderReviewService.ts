/**
 * WhatsApp sender review: who of the people writing to the business is a
 * customer.
 *
 * Inbound WhatsApp messages are always kept (Communication Intake) and every
 * sender is staged as an ExternalContact, but a sender no longer becomes a CRM
 * contact by itself. A person reads what the sender wrote and decides:
 *
 *   - approve_customer: after a preview and an explicit confirmation, the
 *     sender becomes a CRM contact (or is linked to the one existing contact
 *     with the same number) and, if asked, a client (new, or an existing one
 *     chosen by id). Existing CRM data is never overwritten.
 *   - reject: not a customer, with the reason (personal, employee,
 *     subcontractor, supplier, other). The sender stays out of CRM; new
 *     messages from them are still stored but never import them.
 *   - mark_review_needed: looked at, not decidable yet.
 *   - reopen: a rejected sender, or one whose CRM contact was permanently
 *     deleted, goes back to the review. Nothing re-imports them otherwise.
 *
 * The work-related signal shown with each sender (lib/whatsappCustomerSignal)
 * is an inference from message text only, for sorting; it never decides.
 */
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../db.js";
import { REVIEW_WHATSAPP_SENDER_ACTION } from "../lib/actionContracts.js";
import { recordAudit } from "../lib/audit.js";
import { isValidPhoneNumberFormat, normalizePhone } from "../lib/contactNormalization.js";
import { whileNotInSafeMode } from "../lib/safeMode.js";
import { workSignal, type WorkSignal } from "../lib/whatsappCustomerSignal.js";
import type { AuthedUser } from "../middleware/auth.js";
import { fail, ok, type ServiceResult } from "./result.js";
import { SUPPRESSED_SENDER_STATUSES, whatsappContactSourceReference } from "./whatsappBusinessConnectorService.js";

export const SENDER_REVIEW_STATUSES = ["pending", "review_needed", "approved", "rejected", "deleted_from_crm"] as const;
export type SenderReviewStatus = (typeof SENDER_REVIEW_STATUSES)[number];
export const NOT_CUSTOMER_CLASSIFICATIONS = ["personal", "employee", "subcontractor", "supplier", "other"] as const;

const listQuerySchema = z.object({
  /** open = pending and review_needed: everything still waiting for a person. */
  status: z.enum(["open", "all", ...SENDER_REVIEW_STATUSES]).default("open"),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();

const note = z.string().trim().max(1000).optional();
export const reviewSenderSchema = z.discriminatedUnion("decision", [
  z.object({
    decision: z.literal("approve_customer"),
    /** contact: a CRM contact only. contact_and_client: also a client (new, or client_id). */
    import_as: z.enum(["contact", "contact_and_client"]).default("contact"),
    /** Link the contact to this existing client instead of creating one. */
    client_id: z.string().uuid().optional(),
    /** The name to use in CRM; the WhatsApp profile name otherwise. */
    display_name: z.string().trim().min(1).max(200).optional(),
    note,
    confirmed: z.boolean().optional(),
    /** The sender's revision from the preview; required to confirm. */
    expected_revision: z.string().datetime().optional(),
  }).strict(),
  // expected_revision (optional): the sender's revision a person was shown.
  // When given, the decision is made only if the sender is still exactly that
  // revision; the MCP gateway always sends it with a confirmed rejection.
  z.object({ decision: z.literal("reject"), classification: z.enum(NOT_CUSTOMER_CLASSIFICATIONS), note, expected_revision: z.string().datetime().optional() }).strict(),
  z.object({ decision: z.literal("mark_review_needed"), note, expected_revision: z.string().datetime().optional() }).strict(),
  z.object({ decision: z.literal("reopen"), note, expected_revision: z.string().datetime().optional() }).strict(),
]);
type DecisionInput = Exclude<z.infer<typeof reviewSenderSchema>, { decision: "approve_customer" }>;

/** From which review statuses each decision without import may be taken. */
const ALLOWED_FROM: Record<DecisionInput["decision"], readonly SenderReviewStatus[]> = {
  reject: ["pending", "review_needed", "approved"],
  mark_review_needed: ["pending", "review_needed"],
  reopen: ["rejected", "deleted_from_crm", "review_needed"],
};

function decisionOutcome(input: DecisionInput) {
  return input.decision === "reject"
    ? { reviewStatus: "rejected", reviewClassification: input.classification as string | null }
    : input.decision === "mark_review_needed"
      ? { reviewStatus: "review_needed", reviewClassification: null as string | null }
      : { reviewStatus: "pending", reviewClassification: null as string | null };
}
type ApproveInput = Extract<z.infer<typeof reviewSenderSchema>, { decision: "approve_customer" }>;

const SIGNAL_RANK: Record<WorkSignal["level"], number> = { work_related_candidate: 0, weak_signal: 1, no_work_terms: 2, no_messages: 3 };
const RECENT_MESSAGES = 3;
const MESSAGE_PREVIEW_CHARS = 280;

async function whatsappSource(user: AuthedUser, sourceId: string) {
  return prisma.connectorSource.findFirst({
    where: { id: sourceId, companyId: user.companyId, connectorKey: "whatsapp_business", isActive: true },
    select: { id: true, displayName: true },
  });
}

export async function listWhatsAppSenders(user: AuthedUser, sourceId: string, rawQuery: unknown): Promise<ServiceResult<unknown>> {
  if (!user.permissions.includes("crm.read")) return fail(403, "MISSING_PERMISSION", "CRM read permission is required to review WhatsApp senders.");
  const parsed = listQuerySchema.safeParse(rawQuery ?? {});
  if (!parsed.success) return fail(400, "VALIDATION_FAILED", parsed.error.message);
  const source = await whatsappSource(user, sourceId);
  if (!source) return fail(404, "CONNECTOR_SOURCE_NOT_FOUND");
  const { status, offset, limit } = parsed.data;
  const statusFilter = status === "all" ? undefined : status === "open" ? { in: ["pending", "review_needed"] } : status;

  const [senders, grouped] = await Promise.all([
    prisma.externalContact.findMany({
      where: { companyId: user.companyId, connectorSourceId: source.id, ...(statusFilter ? { reviewStatus: statusFilter } : {}) },
      include: { importedContact: { select: { id: true, displayName: true, isActive: true, client: { select: { id: true, displayName: true } } } } },
      orderBy: { createdAt: "asc" },
      take: 1000,
    }),
    prisma.externalContact.groupBy({
      by: ["reviewStatus"],
      where: { companyId: user.companyId, connectorSourceId: source.id },
      _count: { _all: true },
    }),
  ]);
  const phones = [...new Set(senders.map((sender) => normalizePhone(sender.phone)).filter((phone): phone is string => Boolean(phone)))];
  const messages = phones.length
    ? await prisma.communicationIntake.findMany({
        where: { companyId: user.companyId, connectorSourceId: source.id, channel: "whatsapp", senderPhone: { in: phones } },
        select: { senderPhone: true, messageText: true, receivedAt: true },
        orderBy: { receivedAt: "desc" },
      })
    : [];
  const byPhone = new Map<string, typeof messages>();
  for (const message of messages) {
    const list = byPhone.get(message.senderPhone!) ?? [];
    list.push(message);
    byPhone.set(message.senderPhone!, list);
  }

  const items = senders.map((sender) => {
    const phone = normalizePhone(sender.phone);
    const own = phone ? byPhone.get(phone) ?? [] : [];
    return {
      id: sender.id,
      displayName: sender.displayName,
      phone: sender.phone,
      phoneValid: Boolean(phone) && isValidPhoneNumberFormat(sender.phone ?? ""),
      externalResourceName: sender.externalResourceName,
      reviewStatus: sender.reviewStatus,
      reviewClassification: sender.reviewClassification,
      reviewNote: sender.reviewNote,
      reviewedAt: sender.reviewedAt,
      revision: sender.updatedAt.toISOString(),
      linkedContact: sender.importedContact,
      messageCount: own.length,
      firstMessageAt: own.length ? own[own.length - 1].receivedAt : null,
      lastMessageAt: own.length ? own[0].receivedAt : null,
      recentMessages: own.slice(0, RECENT_MESSAGES).map((message) => ({
        receivedAt: message.receivedAt,
        text: message.messageText.length > MESSAGE_PREVIEW_CHARS ? message.messageText.slice(0, MESSAGE_PREVIEW_CHARS) + "…" : message.messageText,
      })),
      signal: workSignal(own.map((message) => message.messageText)),
    };
  });
  // Likely customers first, then the most recently active.
  items.sort((left, right) => SIGNAL_RANK[left.signal.level] - SIGNAL_RANK[right.signal.level]
    || (right.lastMessageAt?.getTime() ?? 0) - (left.lastMessageAt?.getTime() ?? 0));
  const counts = Object.fromEntries(SENDER_REVIEW_STATUSES.map((value) => [value, 0])) as Record<SenderReviewStatus, number>;
  for (const row of grouped) if (row.reviewStatus in counts) counts[row.reviewStatus as SenderReviewStatus] = row._count._all;
  return ok(200, { items: items.slice(offset, offset + limit), total: items.length, offset, limit, counts });
}

// ---------------------------------------------------------------------------
// Approval plan: exactly what approving would do, computed the same way for
// the preview and again under the sender's row lock when it is confirmed.

type ContactPlan =
  | { action: "keep_linked"; contact: { id: string; displayName: string; clientId: string | null } }
  | { action: "link_existing"; contact: { id: string; displayName: string; clientId: string | null } }
  | { action: "create"; displayName: string };
type ClientPlan =
  | { action: "none" }
  | { action: "keep_existing"; client: { id: string; displayName: string } }
  | { action: "link_existing"; client: { id: string; displayName: string } }
  | { action: "create"; displayName: string };

interface ApprovalPlan {
  sender: { id: string; displayName: string | null; phone: string; externalResourceName: string };
  revision: string;
  contact: ContactPlan;
  client: ClientPlan;
}

type Sender = NonNullable<Awaited<ReturnType<typeof prisma.externalContact.findFirst>>>;

async function approvalPlan(user: AuthedUser, sourceId: string, sender: Sender, input: ApproveInput): Promise<ServiceResult<ApprovalPlan>> {
  const phone = normalizePhone(sender.phone);
  if (!phone || !isValidPhoneNumberFormat(sender.phone ?? "")) {
    return fail(409, "WHATSAPP_SENDER_INVALID_NUMBER", "This sender's WhatsApp number is not a valid phone number, so it cannot become a CRM contact.");
  }
  const sourceReference = whatsappContactSourceReference(sourceId, sender.externalResourceName);
  const displayName = input.display_name ?? sender.displayName ?? `WhatsApp ${phone}`;

  let contact: ContactPlan;
  const linked = sender.importedContactId
    ? await prisma.contact.findFirst({
        where: { id: sender.importedContactId, companyId: user.companyId, isActive: true },
        select: { id: true, displayName: true, clientId: true },
      })
    : null;
  if (linked) {
    contact = { action: "keep_linked", contact: linked };
  } else {
    const candidates = await prisma.contact.findMany({
      where: { companyId: user.companyId, isActive: true, OR: [{ sourceReference }, { phone: { not: null } }] },
      select: { id: true, displayName: true, clientId: true, phone: true, sourceReference: true },
    });
    const matches = candidates.filter((candidate) => candidate.sourceReference === sourceReference || normalizePhone(candidate.phone) === phone);
    if (matches.length > 1) {
      return fail(409, "DUPLICATE_CONTACT_AMBIGUOUS", "More than one active CRM contact already uses this number. Resolve the duplicates on the Contacts page first.", {
        candidates: matches.map(({ id, displayName: name }) => ({ id, displayName: name })),
      });
    }
    contact = matches.length === 1
      ? { action: "link_existing", contact: { id: matches[0].id, displayName: matches[0].displayName, clientId: matches[0].clientId } }
      : { action: "create", displayName };
  }

  const existingClientId = contact.action === "create" ? null : contact.contact.clientId;
  let client: ClientPlan = { action: "none" };
  if (input.client_id) {
    const chosen = await prisma.client.findFirst({
      where: { id: input.client_id, companyId: user.companyId, isActive: true },
      select: { id: true, displayName: true },
    });
    if (!chosen) return fail(404, "CLIENT_NOT_FOUND", "The chosen client was not found among active clients.");
    if (existingClientId && existingClientId !== chosen.id) {
      return fail(409, "CONTACT_LINKED_TO_OTHER_CLIENT", "The existing CRM contact for this number belongs to another client. Change it on the Contacts page if that is wrong.");
    }
    client = existingClientId ? { action: "keep_existing", client: chosen } : { action: "link_existing", client: chosen };
  } else if (existingClientId) {
    const current = await prisma.client.findFirst({ where: { id: existingClientId, companyId: user.companyId }, select: { id: true, displayName: true } });
    client = current ? { action: "keep_existing", client: current } : { action: "none" };
  } else if (input.import_as === "contact_and_client") {
    const sameNumber = (await prisma.client.findMany({
      where: { companyId: user.companyId, isActive: true, phonePrimary: { not: null } },
      select: { id: true, displayName: true, phonePrimary: true },
    })).filter((candidate) => normalizePhone(candidate.phonePrimary) === phone);
    if (sameNumber.length) {
      return fail(409, "DUPLICATE_CLIENT_POSSIBLE", "An active client already uses this number. Choose that client instead of creating another.", {
        candidates: sameNumber.map(({ id, displayName: name }) => ({ id, displayName: name })),
      });
    }
    client = { action: "create", displayName };
  }
  return ok(200, {
    sender: { id: sender.id, displayName: sender.displayName, phone, externalResourceName: sender.externalResourceName },
    revision: sender.updatedAt.toISOString(),
    contact,
    client,
  });
}

class SenderChanged extends Error {}
class PlanRefused extends Error {
  constructor(readonly result: Extract<ServiceResult<never>, { ok: false }>) {
    super(result.error);
  }
}

async function auditReview(user: AuthedUser, input: unknown, result: "success" | "error" | "rejected", extra: {
  errorMessage?: string; dataBefore?: unknown; dataAfter?: unknown; confirmed?: boolean;
} = {}) {
  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: REVIEW_WHATSAPP_SENDER_ACTION.actionName,
    inputPayload: input,
    dataBefore: extra.dataBefore,
    dataAfter: extra.dataAfter,
    riskLevel: REVIEW_WHATSAPP_SENDER_ACTION.riskLevel,
    confirmationRequired: (input as { decision?: string })?.decision === "approve_customer",
    confirmed: extra.confirmed ?? false,
    result,
    errorMessage: extra.errorMessage,
  });
}

function senderSnapshot(sender: Sender) {
  return {
    id: sender.id, externalResourceName: sender.externalResourceName, displayName: sender.displayName,
    reviewStatus: sender.reviewStatus, reviewClassification: sender.reviewClassification, importedContactId: sender.importedContactId,
  };
}

export async function reviewWhatsAppSender(
  user: AuthedUser,
  sourceId: string,
  senderId: string,
  rawInput: unknown,
): Promise<ServiceResult<unknown>> {
  if (!user.permissions.includes(REVIEW_WHATSAPP_SENDER_ACTION.requiredPermission)) {
    await auditReview(user, { sourceId, senderId }, "error", { errorMessage: "MISSING_PERMISSION" });
    return fail(403, "MISSING_PERMISSION", "CRM management permission is required to review WhatsApp senders.");
  }
  const parsed = reviewSenderSchema.safeParse(rawInput ?? {});
  if (!parsed.success) {
    await auditReview(user, { sourceId, senderId }, "error", { errorMessage: "VALIDATION_FAILED" });
    return fail(400, "VALIDATION_FAILED", parsed.error.message);
  }
  const input = parsed.data;
  const auditInput = { sourceId, senderId, ...input };
  const source = await whatsappSource(user, sourceId);
  if (!source) return fail(404, "CONNECTOR_SOURCE_NOT_FOUND");
  const sender = await prisma.externalContact.findFirst({ where: { id: senderId, companyId: user.companyId, connectorSourceId: source.id } });
  if (!sender) return fail(404, "WHATSAPP_SENDER_NOT_FOUND", "That WhatsApp sender was not found.");

  if (input.decision !== "approve_customer") return decideWithoutImport(user, sender, input, auditInput);

  if ((SUPPRESSED_SENDER_STATUSES as readonly string[]).includes(sender.reviewStatus)) {
    await auditReview(user, auditInput, "rejected", { errorMessage: "WHATSAPP_SENDER_SUPPRESSED" });
    return fail(409, "WHATSAPP_SENDER_SUPPRESSED", sender.reviewStatus === "rejected"
      ? "This sender was marked as not a customer. Reopen it first if that was wrong."
      : "This sender's CRM contact was deleted permanently. Reopen it first to import it again.");
  }
  if (sender.reviewStatus === "approved" && sender.importedContactId) {
    const contact = await prisma.contact.findFirst({ where: { id: sender.importedContactId, companyId: user.companyId, isActive: true }, select: { id: true, displayName: true, clientId: true } });
    if (contact) return ok(200, { alreadyApproved: true, contact, message: `${contact.displayName} is already in CRM as a customer contact.` });
  }

  const plan = await approvalPlan(user, source.id, sender, input);
  if (!plan.ok) {
    await auditReview(user, auditInput, "rejected", { errorMessage: plan.error });
    return plan;
  }
  if (!input.confirmed) {
    return fail(409, "CONFIRMATION_REQUIRED", "Review what will be added to CRM for this sender, then confirm.", { preview: plan.data });
  }
  if (!input.expected_revision) {
    return fail(400, "VALIDATION_FAILED", "expected_revision from the reviewed preview is required to confirm.", { preview: plan.data });
  }

  let outcome: { contactId: string; clientId: string | null; plan: ApprovalPlan };
  try {
    outcome = await whileNotInSafeMode(user.companyId, async () => {
      await prisma.$queryRaw(Prisma.sql`SELECT id FROM external_contacts WHERE id = ${sender.id} AND company_id = ${user.companyId} FOR UPDATE`);
      const current = await prisma.externalContact.findFirst({ where: { id: sender.id, companyId: user.companyId, connectorSourceId: source.id } });
      if (!current || current.updatedAt.toISOString() !== input.expected_revision) throw new SenderChanged();
      if ((SUPPRESSED_SENDER_STATUSES as readonly string[]).includes(current.reviewStatus)) throw new SenderChanged();
      const fresh = await approvalPlan(user, source.id, current, input);
      if (!fresh.ok) throw new PlanRefused(fresh);
      const { contact: contactPlan, client: clientPlan } = fresh.data;

      let clientId: string | null = null;
      if (clientPlan.action === "create") {
        const created = await prisma.client.create({
          data: {
            companyId: user.companyId,
            displayName: clientPlan.displayName,
            phonePrimary: fresh.data.sender.phone,
            source: "whatsapp_business",
            notes: input.note,
            createdBy: user.id,
          },
        });
        clientId = created.id;
      } else if (clientPlan.action !== "none") {
        clientId = clientPlan.client.id;
      }

      let contactId: string;
      if (contactPlan.action === "create") {
        const created = await prisma.contact.create({
          data: {
            companyId: user.companyId,
            clientId,
            displayName: contactPlan.displayName,
            phone: fresh.data.sender.phone,
            preferredChannel: "whatsapp",
            source: "whatsapp_business",
            sourceReference: whatsappContactSourceReference(source.id, current.externalResourceName),
            createdBy: user.id,
          },
        });
        contactId = created.id;
      } else {
        contactId = contactPlan.contact.id;
        // Only an empty client link is filled in; nothing existing is overwritten.
        if (clientPlan.action === "create" || clientPlan.action === "link_existing") {
          await prisma.contact.update({ where: { id: contactId }, data: { clientId } });
        }
      }
      await prisma.externalContact.update({
        where: { id: current.id },
        data: {
          importedContactId: contactId,
          reviewStatus: "approved",
          reviewClassification: "customer",
          reviewNote: input.note ?? null,
          reviewedBy: user.id,
          reviewedAt: new Date(),
        },
      });
      await auditReview(user, auditInput, "success", {
        confirmed: true,
        dataBefore: senderSnapshot(current),
        dataAfter: { reviewStatus: "approved", contactId, clientId, contactAction: contactPlan.action, clientAction: clientPlan.action },
      });
      return { contactId, clientId, plan: fresh.data };
    });
  } catch (error) {
    if (error instanceof SenderChanged) {
      await auditReview(user, auditInput, "rejected", { errorMessage: "WHATSAPP_SENDER_CHANGED" });
      return fail(409, "WHATSAPP_SENDER_CHANGED", "This sender changed after it was shown (a new message or another decision). Review it again.");
    }
    if (error instanceof PlanRefused) {
      await auditReview(user, auditInput, "rejected", { errorMessage: error.result.error });
      return error.result;
    }
    throw error;
  }
  const name = outcome.plan.contact.action === "create" ? outcome.plan.contact.displayName : outcome.plan.contact.contact.displayName;
  return ok(200, {
    reviewStatus: "approved",
    contactId: outcome.contactId,
    clientId: outcome.clientId,
    contactAction: outcome.plan.contact.action,
    clientAction: outcome.plan.client.action,
    message: `${name} was added to CRM as a customer.`,
  });
}

async function decideWithoutImport(
  user: AuthedUser,
  sender: Sender,
  input: DecisionInput,
  auditInput: unknown,
): Promise<ServiceResult<unknown>> {
  if (!(ALLOWED_FROM[input.decision] as readonly string[]).includes(sender.reviewStatus)) {
    await auditReview(user, auditInput, "rejected", { errorMessage: "INVALID_REVIEW_TRANSITION" });
    return fail(409, "INVALID_REVIEW_TRANSITION", `A sender that is ${sender.reviewStatus.replaceAll("_", " ")} cannot be changed with ${input.decision.replaceAll("_", " ")}.`);
  }
  if (input.expected_revision && sender.updatedAt.toISOString() !== input.expected_revision) {
    await auditReview(user, auditInput, "rejected", { errorMessage: "WHATSAPP_SENDER_CHANGED" });
    return fail(409, "WHATSAPP_SENDER_CHANGED", "This sender changed after it was shown (a new message or another decision). Review it again.");
  }
  const next = decisionOutcome(input);
  // Conditional on the status (and, when given, the exact revision) just
  // read, so two people deciding at once do not silently overwrite each
  // other. The change and its audit entry commit together, with the
  // emergency-stop lock held.
  const changed = await whileNotInSafeMode(user.companyId, async () => {
    const updated = await prisma.externalContact.updateMany({
      where: {
        id: sender.id, companyId: user.companyId, reviewStatus: sender.reviewStatus,
        ...(input.expected_revision ? { updatedAt: new Date(input.expected_revision) } : {}),
      },
      data: { ...next, reviewNote: input.note ?? null, reviewedBy: user.id, reviewedAt: new Date() },
    });
    if (updated.count !== 1) return false;
    await auditReview(user, auditInput, "success", { dataBefore: senderSnapshot(sender), dataAfter: next });
    return true;
  });
  if (!changed) {
    await auditReview(user, auditInput, "rejected", { errorMessage: "WHATSAPP_SENDER_CHANGED" });
    return fail(409, "WHATSAPP_SENDER_CHANGED", "Someone else changed this sender's review. Reload and try again.");
  }
  // Rejecting decides about the sender only. A CRM contact that already
  // exists for them (for example one created automatically before this
  // review existed) is kept; archiving or deleting it is a separate action.
  const linked = sender.importedContactId
    ? await prisma.contact.findFirst({ where: { id: sender.importedContactId, companyId: user.companyId }, select: { id: true, displayName: true, isActive: true } })
    : null;
  return ok(200, {
    reviewStatus: next.reviewStatus,
    reviewClassification: next.reviewClassification,
    linkedContact: linked,
    message: input.decision === "reject"
      ? linked?.isActive
        ? `Marked as not a customer. The existing CRM contact ${linked.displayName} was kept; archive or delete it separately on the Contacts page if it should go.`
        : "Marked as not a customer. Their messages are kept, and they will not be added to CRM."
      : input.decision === "mark_review_needed"
        ? "Left for later review."
        : "Reopened for review.",
  });
}

// ---------------------------------------------------------------------------
// Lookups and previews for callers that name a sender by id only (the MCP
// gateway). Every lookup is scoped to the caller's company.

/**
 * The WhatsApp source to list: the one named, or the company's only active
 * WhatsApp Business source. With several and none named, the caller must
 * choose; the sources are listed so it can.
 */
export async function resolveWhatsAppSource(user: AuthedUser, sourceId?: string): Promise<ServiceResult<{ id: string; displayName: string }>> {
  if (sourceId) {
    const source = await whatsappSource(user, sourceId);
    return source ? ok(200, source) : fail(404, "CONNECTOR_SOURCE_NOT_FOUND", "That WhatsApp source was not found in this company.");
  }
  const sources = await prisma.connectorSource.findMany({
    where: { companyId: user.companyId, connectorKey: "whatsapp_business", isActive: true },
    select: { id: true, displayName: true },
    orderBy: { createdAt: "asc" },
  });
  if (sources.length === 1) return ok(200, sources[0]);
  if (!sources.length) return fail(404, "CONNECTOR_SOURCE_NOT_FOUND", "This company has no active WhatsApp Business source.");
  return fail(409, "SOURCE_AMBIGUOUS", "This company has more than one WhatsApp Business source. Name one by source_id.", { sources });
}

/** The sender with this id in the caller's company, with its WhatsApp source. */
export async function findWhatsAppSender(user: AuthedUser, senderId: string) {
  const sender = await prisma.externalContact.findFirst({
    where: { id: senderId, companyId: user.companyId, connectorSource: { connectorKey: "whatsapp_business", isActive: true } },
    include: { connectorSource: { select: { id: true, displayName: true } } },
  });
  return sender;
}

const DETAIL_MESSAGES = 30;
const DETAIL_MESSAGE_CHARS = 2000;

/**
 * One sender in full: identity, review state, the linked CRM contact if any,
 * the work-related signal and the most recent messages. Reading only.
 */
export async function getWhatsAppSender(user: AuthedUser, senderId: string): Promise<ServiceResult<unknown>> {
  if (!user.permissions.includes("crm.read")) return fail(403, "MISSING_PERMISSION", "CRM read permission is required to review WhatsApp senders.");
  const sender = await findWhatsAppSender(user, senderId);
  if (!sender) return fail(404, "WHATSAPP_SENDER_NOT_FOUND", "That WhatsApp sender was not found.");
  const phone = normalizePhone(sender.phone);
  const [messages, messageCount, linked] = await Promise.all([
    phone
      ? prisma.communicationIntake.findMany({
          where: { companyId: user.companyId, connectorSourceId: sender.connectorSourceId, channel: "whatsapp", senderPhone: phone },
          select: { id: true, messageText: true, receivedAt: true, intakeStatus: true },
          orderBy: { receivedAt: "desc" },
          take: DETAIL_MESSAGES,
        })
      : Promise.resolve([]),
    phone
      ? prisma.communicationIntake.count({ where: { companyId: user.companyId, connectorSourceId: sender.connectorSourceId, channel: "whatsapp", senderPhone: phone } })
      : Promise.resolve(0),
    sender.importedContactId
      ? prisma.contact.findFirst({
          where: { id: sender.importedContactId, companyId: user.companyId },
          select: { id: true, displayName: true, isActive: true, source: true, client: { select: { id: true, displayName: true } } },
        })
      : Promise.resolve(null),
  ]);
  return ok(200, {
    id: sender.id,
    source: sender.connectorSource,
    displayName: sender.displayName,
    phone: sender.phone,
    phoneValid: Boolean(phone) && isValidPhoneNumberFormat(sender.phone ?? ""),
    externalResourceName: sender.externalResourceName,
    reviewStatus: sender.reviewStatus,
    reviewClassification: sender.reviewClassification,
    reviewNote: sender.reviewNote,
    reviewedAt: sender.reviewedAt,
    revision: sender.updatedAt.toISOString(),
    linkedContact: linked,
    messageCount,
    messagesShown: messages.length,
    messages: messages.map((message) => ({
      id: message.id,
      receivedAt: message.receivedAt,
      intakeStatus: message.intakeStatus,
      text: message.messageText.length > DETAIL_MESSAGE_CHARS ? message.messageText.slice(0, DETAIL_MESSAGE_CHARS) + "…" : message.messageText,
    })),
    signal: workSignal(messages.map((message) => message.messageText)),
    signalNote: "The signal is an inference from message text only; it never decides who is a customer.",
    allowedDecisions: [
      ...(!(SUPPRESSED_SENDER_STATUSES as readonly string[]).includes(sender.reviewStatus) ? ["approve_customer"] : []),
      ...(Object.keys(ALLOWED_FROM) as DecisionInput["decision"][]).filter((decision) => (ALLOWED_FROM[decision] as readonly string[]).includes(sender.reviewStatus)),
    ],
  });
}

/**
 * Exactly what a decision without import (reject, mark_review_needed,
 * reopen) would change, without changing anything. Refuses a decision the
 * sender's current status does not allow, as the decision itself would.
 */
export async function previewWhatsAppSenderDecision(user: AuthedUser, senderId: string, rawInput: unknown): Promise<ServiceResult<unknown>> {
  if (!user.permissions.includes(REVIEW_WHATSAPP_SENDER_ACTION.requiredPermission)) {
    return fail(403, "MISSING_PERMISSION", "CRM management permission is required to review WhatsApp senders.");
  }
  const parsed = reviewSenderSchema.safeParse(rawInput ?? {});
  if (!parsed.success) return fail(400, "VALIDATION_FAILED", parsed.error.message);
  const input = parsed.data;
  if (input.decision === "approve_customer") return fail(400, "VALIDATION_FAILED", "Approval has its own preview.");
  const sender = await findWhatsAppSender(user, senderId);
  if (!sender) return fail(404, "WHATSAPP_SENDER_NOT_FOUND", "That WhatsApp sender was not found.");
  if (!(ALLOWED_FROM[input.decision] as readonly string[]).includes(sender.reviewStatus)) {
    return fail(409, "INVALID_REVIEW_TRANSITION", `A sender that is ${sender.reviewStatus.replaceAll("_", " ")} cannot be changed with ${input.decision.replaceAll("_", " ")}.`);
  }
  const linked = sender.importedContactId
    ? await prisma.contact.findFirst({ where: { id: sender.importedContactId, companyId: user.companyId }, select: { id: true, displayName: true, isActive: true } })
    : null;
  const next = decisionOutcome(input);
  return ok(200, {
    sender: { id: sender.id, displayName: sender.displayName, phone: sender.phone, source: sender.connectorSource },
    decision: input.decision,
    statusBefore: sender.reviewStatus,
    classificationBefore: sender.reviewClassification,
    statusAfter: next.reviewStatus,
    classificationAfter: next.reviewClassification,
    note: input.note ?? null,
    linkedContact: linked,
    revision: sender.updatedAt.toISOString(),
    effect: input.decision === "reject"
      ? "The sender is marked as not a customer. Their WhatsApp messages are kept unchanged, and they will not be added to CRM unless the review is reopened." +
        (linked?.isActive ? ` The existing CRM contact ${linked.displayName} is kept; archiving or deleting it is a separate action.` : "")
      : input.decision === "reopen"
        ? "The sender goes back to the review queue as pending. Nothing is added to CRM until a person approves them."
        : "The sender is left for later review. Nothing is added to CRM.",
  });
}
