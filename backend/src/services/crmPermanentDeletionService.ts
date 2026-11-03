/**
 * Permanent deletion of CRM clients and contacts.
 *
 * This is a separate action from archiving (clientService.archiveClient,
 * contactService.archiveContact), never a stronger form of it:
 *
 *   - Archive keeps the row (isActive=false) and every record linked to it.
 *     It stays the default and is what voice and MCP clients can do.
 *   - Permanent deletion removes the row itself. It is offered in the UI
 *     and, for contacts only, through the MCP gateway (writeTools.ts
 *     delete_contact_permanently: preview, explicit yes and typed name, then
 *     this same execute), only with crm.manage, only inside the caller's
 *     company, and only when nothing of business value would be lost or left
 *     pointing at a record that no longer exists. Never by voice.
 *
 * The flow, for both kinds of record:
 *
 *   1. Preview. The exact record (id, name, email, phone, source, status,
 *      revision), every link and every dependency count, the list of
 *      blockers, and a digest of all of it.
 *   2. Execute, with confirmed: true, the preview's digest and the record's
 *      display name typed back by the person. Inside one transaction that
 *      holds the emergency-stop lock and the record's row lock, the preview is
 *      computed again; any difference (an edit, a new job, a new link) refuses
 *      with PREVIEW_STALE and the fresh preview. The delete and its audit
 *      entry commit together or not at all.
 *   3. Repeat. A second confirmation for a record that this company already
 *      deleted answers alreadyDeleted from the audit trail instead of 404, so
 *      a retried request is harmless. The Idempotency-Key header (middleware)
 *      also applies to the REST route.
 *
 * Nothing here cascades. Client relations that the database would silently
 * SET NULL (contacts, tasks, intakes, photos, documents) are counted and
 * block deletion exactly like the RESTRICT ones (jobs, quotes, invoices,
 * communication records). Inserting a child takes a key-share lock on the
 * client row, which waits for this transaction's FOR UPDATE, so a record
 * linked during the deletion is either counted or fails its own insert.
 */
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../db.js";
import {
  DELETE_CLIENT_PERMANENTLY_ACTION,
  DELETE_CONTACT_PERMANENTLY_ACTION,
  type ActionContract,
} from "../lib/actionContracts.js";
import { recordAudit } from "../lib/audit.js";
import { normalizeEmail, normalizePhone } from "../lib/contactNormalization.js";
import { whileNotInSafeMode } from "../lib/safeMode.js";
import type { AuthedUser } from "../middleware/auth.js";
import { fail, ok, type ServiceResult } from "./result.js";

export const permanentDeletionSchema = z.object({
  confirmed: z.boolean().optional(),
  /** The digest of the preview the person read. */
  preview_digest: z.string().regex(/^[a-f0-9]{64}$/, "preview_digest must be the digest returned with the preview").optional(),
  /** The record's display name, typed back by the person. */
  confirm_display_name: z.string().max(200).optional(),
}).strict();

export interface DeletionBlocker {
  /** Stable key of the dependency, e.g. "jobs". */
  key: string;
  count: number;
}

interface PreviewBase {
  kind: "client" | "contact";
  id: string;
  displayName: string;
  status: "active" | "archived";
  createdAt: string;
  revision: string;
  blockers: DeletionBlocker[];
  canDelete: boolean;
}

export interface ClientDeletionPreview extends PreviewBase {
  kind: "client";
  identity: {
    firstName: string | null; lastName: string | null; companyName: string | null;
    emailPrimary: string | null; phonePrimary: string | null; source: string | null; clientType: string | null;
  };
  dependencies: Record<string, number>;
  kept: string[];
}

export interface ContactDeletionPreview extends PreviewBase {
  kind: "contact";
  identity: {
    email: string | null; phone: string | null; source: string; sourceReference: string | null;
    jobTitle: string | null; department: string | null;
  };
  client: { id: string; displayName: string } | null;
  externalLinks: Array<{ id: string; connectorKey: string; sourceName: string; externalResourceName: string }>;
  communicationIntakesKept: number;
  kept: string[];
}

type Preview = ClientDeletionPreview | ContactDeletionPreview;

// ---------------------------------------------------------------------------
// Digest

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export function previewDigest(preview: Preview): string {
  return createHash("sha256").update(canonical(preview)).digest("hex");
}

function withDigest<T extends Preview>(preview: T): T & { digest: string } {
  return { ...preview, digest: previewDigest(preview) };
}

// ---------------------------------------------------------------------------
// Previews. Every query is scoped to the caller's company; called inside the
// execution transaction they read through it (ambient transaction).

const CLIENT_BLOCKING_DEPENDENCIES = [
  "jobs", "quotes", "invoices", "payments", "communicationRecords", "communicationIntakes", "tasks",
  "portfolioPhotos", "documentRecords", "contacts", "convertedLeads", "mergeRecords",
] as const;

async function buildClientPreview(user: AuthedUser, id: string): Promise<ClientDeletionPreview | null> {
  const client = await prisma.client.findFirst({ where: { id, companyId: user.companyId } });
  if (!client) return null;
  const companyId = user.companyId;
  const [
    jobs, quotes, invoices, payments, communicationRecords, communicationIntakes, tasks,
    portfolioPhotos, documentRecords, contacts, convertedLeads, mergeRecords,
  ] = await Promise.all([
    prisma.job.count({ where: { companyId, clientId: id } }),
    prisma.quote.count({ where: { companyId, clientId: id } }),
    prisma.invoice.count({ where: { companyId, clientId: id } }),
    prisma.payment.count({ where: { companyId, invoice: { clientId: id } } }),
    prisma.communicationRecord.count({ where: { companyId, clientId: id } }),
    prisma.communicationIntake.count({ where: { companyId, clientId: id } }),
    prisma.task.count({ where: { companyId, clientId: id } }),
    prisma.portfolioPhoto.count({ where: { companyId, clientId: id } }),
    prisma.documentRecord.count({ where: { companyId, clientId: id } }),
    // Archived contacts count too: deleting the client would silently unlink them.
    prisma.contact.count({ where: { companyId, clientId: id } }),
    prisma.lead.count({ where: { companyId, convertedClientId: id } }),
    prisma.clientMergeRecord.count({ where: { companyId, OR: [{ primaryClientId: id }, { duplicateClientId: id }] } }),
  ]);
  const dependencies: Record<string, number> = {
    jobs, quotes, invoices, payments, communicationRecords, communicationIntakes, tasks,
    portfolioPhotos, documentRecords, contacts, convertedLeads, mergeRecords,
  };
  const blockers = CLIENT_BLOCKING_DEPENDENCIES
    .filter((key) => dependencies[key] > 0)
    .map((key) => ({ key, count: dependencies[key] }));
  return {
    kind: "client",
    id: client.id,
    displayName: client.displayName,
    status: client.isActive ? "active" : "archived",
    createdAt: client.createdAt.toISOString(),
    revision: client.updatedAt.toISOString(),
    identity: {
      firstName: client.firstName, lastName: client.lastName, companyName: client.companyName,
      emailPrimary: client.emailPrimary, phonePrimary: client.phonePrimary, source: client.source, clientType: client.clientType,
    },
    dependencies,
    blockers,
    canDelete: blockers.length === 0,
    kept: ["audit_history"],
  };
}

async function buildContactPreview(user: AuthedUser, id: string): Promise<ContactDeletionPreview | null> {
  const contact = await prisma.contact.findFirst({
    where: { id, companyId: user.companyId },
    include: { client: { select: { id: true, displayName: true } } },
  });
  if (!contact) return null;
  const links = await prisma.externalContact.findMany({
    where: { companyId: user.companyId, importedContactId: id },
    include: { connectorSource: { select: { connectorKey: true, displayName: true } } },
    orderBy: { createdAt: "asc" },
  });
  // Communication is linked to people by sender address, not by contact id,
  // so deleting the contact leaves every message where it is. The count is
  // shown so the person knows history exists and stays.
  const phone = normalizePhone(contact.phone);
  const email = normalizeEmail(contact.email);
  const communicationIntakesKept = phone || email
    ? await prisma.communicationIntake.count({
        where: {
          companyId: user.companyId,
          OR: [
            ...(phone ? [{ senderPhone: phone }] : []),
            ...(email ? [{ senderEmail: { equals: email, mode: "insensitive" as const } }] : []),
          ],
        },
      })
    : 0;
  return {
    kind: "contact",
    id: contact.id,
    displayName: contact.displayName,
    status: contact.isActive ? "active" : "archived",
    createdAt: contact.createdAt.toISOString(),
    revision: contact.updatedAt.toISOString(),
    identity: {
      email: contact.email, phone: contact.phone, source: contact.source, sourceReference: contact.sourceReference,
      jobTitle: contact.jobTitle, department: contact.department,
    },
    client: contact.client,
    externalLinks: links.map((link) => ({
      id: link.id,
      connectorKey: link.connectorSource.connectorKey,
      sourceName: link.connectorSource.displayName,
      externalResourceName: link.externalResourceName,
    })),
    communicationIntakesKept,
    // A contact owns no business records; nothing it points at is lost.
    blockers: [],
    canDelete: true,
    kept: [
      ...(contact.client ? ["client"] : []),
      ...(links.length ? ["staged_connector_records"] : []),
      ...(communicationIntakesKept ? ["communication_history"] : []),
      "audit_history",
    ],
  };
}

// ---------------------------------------------------------------------------
// The shared flow.

interface Kind<P extends Preview> {
  contract: ActionContract;
  notFound: string;
  noun: string;
  build: (user: AuthedUser, id: string) => Promise<P | null>;
  table: "clients" | "contacts";
  /** Deletes the row (and only cleans up links that carry no business value). */
  remove: (user: AuthedUser, preview: P) => Promise<void>;
}

const CLIENT_KIND: Kind<ClientDeletionPreview> = {
  contract: DELETE_CLIENT_PERMANENTLY_ACTION,
  notFound: "CLIENT_NOT_FOUND",
  noun: "client",
  build: buildClientPreview,
  table: "clients",
  remove: async (user, preview) => {
    await prisma.client.delete({ where: { id: preview.id } });
  },
};

const CONTACT_KIND: Kind<ContactDeletionPreview> = {
  contract: DELETE_CONTACT_PERMANENTLY_ACTION,
  notFound: "CONTACT_NOT_FOUND",
  noun: "contact",
  build: buildContactPreview,
  table: "contacts",
  remove: async (user, preview) => {
    // Staged connector records are source evidence and stay. They are
    // unlinked explicitly (not left to ON DELETE SET NULL) and marked, so a
    // WhatsApp sender whose contact was deleted is not imported again
    // without a person reopening it.
    await prisma.externalContact.updateMany({
      where: { companyId: user.companyId, importedContactId: preview.id },
      data: { importedContactId: null, reviewStatus: "deleted_from_crm", reviewedBy: user.id, reviewedAt: new Date() },
    });
    await prisma.contact.delete({ where: { id: preview.id } });
  },
};

class PreviewStale extends Error {
  constructor(readonly fresh: Preview | null) {
    super("preview stale");
  }
}
class Blocked extends Error {
  constructor(readonly fresh: Preview) {
    super("blocked");
  }
}

async function auditRefusal(user: AuthedUser, contract: ActionContract, id: string, errorMessage: string, dataBefore?: unknown) {
  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: contract.actionName,
    inputPayload: { id },
    dataBefore,
    riskLevel: contract.riskLevel,
    confirmationRequired: true,
    result: errorMessage === "MISSING_PERMISSION" || errorMessage === "VALIDATION_FAILED" ? "error" : "rejected",
    errorMessage,
  });
}

/** The successful deletion of this record in this company, if there was one. */
async function earlierDeletion(user: AuthedUser, contract: ActionContract, id: string) {
  return prisma.auditLog.findFirst({
    where: {
      companyId: user.companyId,
      actionName: contract.actionName,
      result: "success",
      inputPayload: { path: ["id"], equals: id },
    },
    select: { id: true, createdAt: true, userId: true },
    orderBy: { createdAt: "asc" },
  });
}

function canManage(user: AuthedUser) {
  return user.permissions.includes("crm.manage");
}

async function preview<P extends Preview>(kind: Kind<P>, user: AuthedUser, id: string): Promise<ServiceResult<unknown>> {
  if (!canManage(user)) {
    await auditRefusal(user, kind.contract, id, "MISSING_PERMISSION");
    return fail(403, "MISSING_PERMISSION", `CRM management permission is required to delete a ${kind.noun} permanently.`);
  }
  const built = await kind.build(user, id);
  if (!built) return fail(404, kind.notFound, `The ${kind.noun} was not found.`);
  return ok(200, withDigest(built));
}

async function execute<P extends Preview>(kind: Kind<P>, user: AuthedUser, id: string, rawInput: unknown): Promise<ServiceResult<unknown>> {
  if (!canManage(user)) {
    await auditRefusal(user, kind.contract, id, "MISSING_PERMISSION");
    return fail(403, "MISSING_PERMISSION", `CRM management permission is required to delete a ${kind.noun} permanently.`);
  }
  const parsed = permanentDeletionSchema.safeParse(rawInput ?? {});
  if (!parsed.success) {
    await auditRefusal(user, kind.contract, id, "VALIDATION_FAILED");
    return fail(400, "VALIDATION_FAILED", parsed.error.message);
  }
  const input = parsed.data;

  const current = await kind.build(user, id);
  if (!current) {
    // A repeat of a deletion that already happened is answered, not refused.
    const earlier = input.confirmed ? await earlierDeletion(user, kind.contract, id) : null;
    if (earlier) {
      return ok(200, { alreadyDeleted: true, id, deletedAt: earlier.createdAt.toISOString(), auditId: earlier.id,
        message: `This ${kind.noun} was already deleted permanently.` });
    }
    return fail(404, kind.notFound, `The ${kind.noun} was not found.`);
  }
  const shown = withDigest(current);
  if (!shown.canDelete) {
    await auditRefusal(user, kind.contract, id, "DELETION_BLOCKED", shown);
    return fail(409, "DELETION_BLOCKED",
      `${shown.displayName} cannot be deleted permanently because other records depend on it. Archive it instead; nothing is lost.`,
      { preview: shown });
  }
  if (!input.confirmed) {
    return fail(409, "CONFIRMATION_REQUIRED",
      `Review exactly what will be deleted. Permanent deletion cannot be undone; archiving is the reversible alternative.`,
      { preview: shown });
  }
  if (!input.preview_digest) {
    await auditRefusal(user, kind.contract, id, "VALIDATION_FAILED");
    return fail(400, "VALIDATION_FAILED", "preview_digest from the preview the person reviewed is required.", { preview: shown });
  }
  if ((input.confirm_display_name ?? "").trim() !== shown.displayName.trim()) {
    await auditRefusal(user, kind.contract, id, "CONFIRMATION_TEXT_MISMATCH");
    return fail(400, "CONFIRMATION_TEXT_MISMATCH", `Type the exact name "${shown.displayName}" to confirm permanent deletion.`);
  }

  let deleted: P & { digest: string };
  try {
    deleted = await whileNotInSafeMode(user.companyId, async () => {
      // Lock the row first, then read everything again under the lock.
      const locked = await prisma.$queryRaw<Array<{ id: string }>>(
        Prisma.sql`SELECT id FROM ${Prisma.raw(`"${kind.table}"`)} WHERE id = ${id} AND company_id = ${user.companyId} FOR UPDATE`,
      );
      if (!locked.length) throw new PreviewStale(null);
      const fresh = await kind.build(user, id);
      if (!fresh) throw new PreviewStale(null);
      const freshWithDigest = withDigest(fresh);
      if (!fresh.canDelete) throw new Blocked(freshWithDigest);
      if (freshWithDigest.digest !== input.preview_digest) throw new PreviewStale(freshWithDigest);
      await kind.remove(user, fresh);
      await recordAudit({
        companyId: user.companyId,
        userId: user.id,
        actionName: kind.contract.actionName,
        inputPayload: { id, previewDigest: input.preview_digest },
        dataBefore: freshWithDigest,
        dataAfter: { deleted: true, id },
        riskLevel: kind.contract.riskLevel,
        confirmationRequired: true,
        confirmed: true,
        result: "success",
      });
      return freshWithDigest;
    });
  } catch (error) {
    if (error instanceof Blocked) {
      await auditRefusal(user, kind.contract, id, "DELETION_BLOCKED", error.fresh);
      return fail(409, "DELETION_BLOCKED",
        `${error.fresh.displayName} cannot be deleted permanently because other records now depend on it. Archive it instead.`,
        { preview: error.fresh });
    }
    if (error instanceof PreviewStale) {
      await auditRefusal(user, kind.contract, id, "PREVIEW_STALE");
      return fail(409, "PREVIEW_STALE", `The ${kind.noun} changed after it was shown. Review it again before deleting.`,
        error.fresh ? { preview: error.fresh } : undefined);
    }
    // A record linked between the check and the delete fails the foreign key
    // instead of being orphaned; nothing was deleted.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003") {
      await auditRefusal(user, kind.contract, id, "DELETION_BLOCKED");
      return fail(409, "DELETION_BLOCKED", `Another record was linked to this ${kind.noun} while it was being deleted. Nothing was deleted; review it again.`);
    }
    throw error;
  }
  return ok(200, {
    deleted: true,
    id,
    displayName: deleted.displayName,
    message: `${deleted.displayName} was deleted permanently. The audit history of the deletion is kept.`,
  });
}

export function previewClientPermanentDeletion(user: AuthedUser, id: string) {
  return preview(CLIENT_KIND, user, id);
}

export function deleteClientPermanently(user: AuthedUser, id: string, rawInput: unknown) {
  return execute(CLIENT_KIND, user, id, rawInput);
}

export function previewContactPermanentDeletion(user: AuthedUser, id: string) {
  return preview(CONTACT_KIND, user, id);
}

export function deleteContactPermanently(user: AuthedUser, id: string, rawInput: unknown) {
  return execute(CONTACT_KIND, user, id, rawInput);
}
