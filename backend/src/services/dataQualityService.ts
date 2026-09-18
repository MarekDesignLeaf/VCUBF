import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { recordAudit } from "../lib/audit.js";
import { MERGE_CLIENTS_ACTION, UNMERGE_CLIENTS_ACTION } from "../lib/actionContracts.js";
import { normalizeEmail, normalizeName, normalizePhone } from "../lib/contactNormalization.js";
import type { AuthedUser } from "../middleware/auth.js";
import { fail, ok, type ServiceResult } from "./result.js";

// Data Quality Engine — see vcubf-programmer-skill "Data Quality Engine" /
// "CRM rule". This module is read-only and purely structural: every finding
// is a deterministic comparison over real Client fields the user already
// entered (email, phone, display name). It never calls an external identity
// service, never fabricates a confidence score beyond what the comparison
// itself proves, and never merges, edits, or deletes a client record — an
// uncertain identity match is only ever presented for a human to confirm,
// exactly as the CRM rule requires. Findings feed additively into the
// existing Notification and Escalation Module feed (buildDataQualityItems),
// reusing that module's acknowledge/unacknowledge mechanism instead of
// inventing a second "dismiss" concept.

export type DuplicateMatchReason = "email_match" | "phone_match" | "name_match" | "name_similar";

export interface DuplicateClientGroup {
  clientAId: string;
  clientBId: string;
  clientALabel: string;
  clientBLabel: string;
  reason: DuplicateMatchReason;
  detail: string;
}

export interface MissingContactIssue {
  clientId: string;
  clientLabel: string;
  issue: "missing_contact_method";
  detail: string;
}

export interface DataQualityReport {
  duplicateClientGroups: DuplicateClientGroup[];
  missingContactIssues: MissingContactIssue[];
}

// Matches the shape of notificationService.AttentionItemBase structurally
// (narrower literal `type`/`severity`) without importing from
// notificationService, which would create a circular module dependency —
// notificationService imports buildDataQualityItems from this file.
export interface DataQualityAttentionItem {
  key: string;
  type: "duplicate_client_possible" | "missing_client_contact_info";
  severity: "warning";
  title: string;
  message: string;
  dueAt: string | null;
  entity: { type: string; id: string; label?: string };
}

// Plain Levenshtein edit distance — a standard, deterministic string
// comparison algorithm, not a fabricated "AI similarity score". Used only
// to catch obvious typo duplicates ("Jon Smith" vs "John Smith") on names
// long enough that a small edit distance is meaningful.
function levenshteinDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp: number[][] = Array.from({ length: rows }, () => new Array(cols).fill(0));
  for (let i = 0; i < rows; i++) dp[i][0] = i;
  for (let j = 0; j < cols; j++) dp[0][j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }
  return dp[rows - 1][cols - 1];
}

const MAX_NAME_TYPO_DISTANCE = 2;
const MIN_NAME_LENGTH_FOR_TYPO_CHECK = 6;
const MIN_NAME_LENGTH_FOR_EXACT_MATCH = 3;

// analyze_data_quality — risk 0, read-only. Scans every client in the
// company (never across companies — multi-tenant scoping matches every
// other service in this codebase) for possible duplicates and clients
// missing a usable contact method.
export async function getDataQualityReport(user: AuthedUser): Promise<DataQualityReport> {
  // Archived (merged-away) clients are excluded from the scan — otherwise a
  // duplicate that has already been merged via merge_clients would keep
  // reappearing as a "possible duplicate" of the client it was merged into,
  // forever, since its own email/phone/name fields are untouched by a merge.
  const clients = await prisma.client.findMany({
    where: { companyId: user.companyId, isActive: true },
    orderBy: { createdAt: "asc" },
  });

  const missingContactIssues: MissingContactIssue[] = [];
  for (const c of clients) {
    if (!normalizeEmail(c.emailPrimary) && !normalizePhone(c.phonePrimary)) {
      missingContactIssues.push({
        clientId: c.id,
        clientLabel: c.displayName,
        issue: "missing_contact_method",
        detail: "No email or phone number on file — this client cannot be reliably contacted.",
      });
    }
  }

  const duplicateClientGroups: DuplicateClientGroup[] = [];
  for (let i = 0; i < clients.length; i++) {
    for (let j = i + 1; j < clients.length; j++) {
      const a = clients[i];
      const b = clients[j];

      const emailA = normalizeEmail(a.emailPrimary);
      const emailB = normalizeEmail(b.emailPrimary);
      if (emailA && emailB && emailA === emailB) {
        duplicateClientGroups.push({
          clientAId: a.id,
          clientBId: b.id,
          clientALabel: a.displayName,
          clientBLabel: b.displayName,
          reason: "email_match",
          detail: `Both records share the email ${emailA}.`,
        });
        continue;
      }

      const phoneA = normalizePhone(a.phonePrimary);
      const phoneB = normalizePhone(b.phonePrimary);
      if (phoneA && phoneB && phoneA === phoneB) {
        duplicateClientGroups.push({
          clientAId: a.id,
          clientBId: b.id,
          clientALabel: a.displayName,
          clientBLabel: b.displayName,
          reason: "phone_match",
          detail: `Both records share the phone number ${b.phonePrimary}.`,
        });
        continue;
      }

      const nameA = normalizeName(a.displayName)!;
      const nameB = normalizeName(b.displayName)!;
      if (nameA.length >= MIN_NAME_LENGTH_FOR_EXACT_MATCH && nameA === nameB) {
        duplicateClientGroups.push({
          clientAId: a.id,
          clientBId: b.id,
          clientALabel: a.displayName,
          clientBLabel: b.displayName,
          reason: "name_match",
          detail: `Both records have the exact same name "${a.displayName}".`,
        });
        continue;
      }

      if (nameA.length >= MIN_NAME_LENGTH_FOR_TYPO_CHECK && nameB.length >= MIN_NAME_LENGTH_FOR_TYPO_CHECK) {
        const distance = levenshteinDistance(nameA, nameB);
        if (distance > 0 && distance <= MAX_NAME_TYPO_DISTANCE) {
          duplicateClientGroups.push({
            clientAId: a.id,
            clientBId: b.id,
            clientALabel: a.displayName,
            clientBLabel: b.displayName,
            reason: "name_similar",
            detail: `Names "${a.displayName}" and "${b.displayName}" are very close (edit distance ${distance}) — possible typo duplicate.`,
          });
        }
      }
    }
  }

  return { duplicateClientGroups, missingContactIssues };
}

// Additive source function for the Notification and Escalation Module's
// unified feed (see notificationService.getAttentionFeed) — matches the
// "add another buildXItems source function" extension point the module was
// explicitly designed for. Severity is always "warning" (never "urgent"):
// a possible duplicate or a missing contact method is a suggestion for a
// human to review, not a confirmed, time-critical business fact.
export async function buildDataQualityItems(user: AuthedUser): Promise<DataQualityAttentionItem[]> {
  const report = await getDataQualityReport(user);
  const items: DataQualityAttentionItem[] = [];

  for (const g of report.duplicateClientGroups) {
    const [idA, idB] = [g.clientAId, g.clientBId].sort();
    items.push({
      key: `duplicate_client:${idA}:${idB}`,
      type: "duplicate_client_possible",
      severity: "warning",
      title: `Possible duplicate clients: ${g.clientALabel} / ${g.clientBLabel}`,
      message: g.detail,
      dueAt: null,
      entity: { type: "client_pair", id: `${idA}:${idB}`, label: `${g.clientALabel} / ${g.clientBLabel}` },
    });
  }

  for (const m of report.missingContactIssues) {
    items.push({
      key: `missing_contact:${m.clientId}`,
      type: "missing_client_contact_info",
      severity: "warning",
      title: `${m.clientLabel} has no contact method on file`,
      message: m.detail,
      dueAt: null,
      entity: { type: "client", id: m.clientId, label: m.clientLabel },
    });
  }

  return items;
}

// --- merge_clients (confirmation-gated, risk 3) ---
//
// Closes the "no merge these clients action yet" gap documented in
// README.md. This is the highest-risk action in the Data Quality Engine so
// far because, unlike everything else in this module, it *does* change real
// linked business records — so it follows the exact same
// confirmationRequired: true / 409 CONFIRMATION_REQUIRED preview pattern
// already used by employeeService.createEmployee/updateEmployee and
// playbookService's run_playbook: a request without `confirmed: true`
// validates and returns a preview of exactly what would change (with real
// counts) and writes nothing; only a second request with `confirmed: true`
// performs the re-linking, inside a single Prisma $transaction so a
// failure partway through rolls back every table's change, never leaving a
// partial merge. The duplicate client is archived (isActive: false), never
// hard-deleted — its own row, and its own AuditLog history, remain in the
// database untouched; all supported client-linked operational records move
// to the primary client in the same transaction.

export const mergeClientsSchema = z.object({
  primary_client_id: z.string().min(1, "primary_client_id is required"),
  duplicate_client_id: z.string().min(1, "duplicate_client_id is required"),
  confirmed: z.boolean().optional(),
});

// Every client-linked record type the merge re-points. Adding a type here is
// the only change needed for both merge and un-merge to cover it: the
// snapshot, the preview counts and the reversal all iterate this list.
const CLIENT_LINKED_RECORDS = {
  jobs: "job",
  quotes: "quote",
  invoices: "invoice",
  communicationRecords: "communicationRecord",
  communicationIntakes: "communicationIntake",
  portfolioPhotos: "portfolioPhoto",
  contacts: "contact",
  documentRecords: "documentRecord",
  tasks: "task",
} as const;
const CLIENT_LINKED_RECORD_TYPES = Object.keys(CLIENT_LINKED_RECORDS) as ClientLinkedRecordType[];
type ClientLinkedRecordType = keyof typeof CLIENT_LINKED_RECORDS;
type MergeCounts = Record<ClientLinkedRecordType, number>;
type RelinkedRecordIds = Record<ClientLinkedRecordType, string[]>;

type ClientLinkedWhere = { companyId: string; clientId: string; id?: { in: string[] } };
type ClientLinkedDelegate = {
  findMany(args: { where: ClientLinkedWhere; select: { id: true } }): Promise<{ id: string }[]>;
  updateMany(args: { where: ClientLinkedWhere; data: { clientId: string } }): Promise<{ count: number }>;
};
type ClientLinkedClient = Prisma.TransactionClient | typeof prisma;

function delegateFor(client: ClientLinkedClient, type: ClientLinkedRecordType): ClientLinkedDelegate {
  // Every listed model exposes companyId + clientId, so the same narrow
  // findMany/updateMany shape applies to each one.
  return (client as unknown as Record<string, ClientLinkedDelegate>)[CLIENT_LINKED_RECORDS[type]];
}

async function countDuplicateLinkedRecords(companyId: string, duplicateClientId: string): Promise<MergeCounts> {
  const entries = await Promise.all(CLIENT_LINKED_RECORD_TYPES.map(async (type) => {
    const rows = await delegateFor(prisma, type).findMany({ where: { companyId, clientId: duplicateClientId }, select: { id: true } });
    return [type, rows.length] as const;
  }));
  return Object.fromEntries(entries) as MergeCounts;
}

function emptyCounts(): MergeCounts {
  return Object.fromEntries(CLIENT_LINKED_RECORD_TYPES.map((type) => [type, 0])) as MergeCounts;
}

function parseRelinkedIds(value: unknown): RelinkedRecordIds {
  const source = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  return Object.fromEntries(CLIENT_LINKED_RECORD_TYPES.map((type) => {
    const ids = Array.isArray(source[type]) ? (source[type] as unknown[]).filter((id): id is string => typeof id === "string") : [];
    return [type, ids];
  })) as RelinkedRecordIds;
}

export async function mergeClients(user: AuthedUser, rawInput: unknown): Promise<ServiceResult<unknown>> {
  const parsed = mergeClientsSchema.safeParse(rawInput);
  if (!parsed.success) {
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: MERGE_CLIENTS_ACTION.actionName,
      inputPayload: rawInput,
      riskLevel: MERGE_CLIENTS_ACTION.riskLevel,
      confirmationRequired: MERGE_CLIENTS_ACTION.confirmationRequired,
      result: "error",
      errorMessage: "VALIDATION_FAILED",
    });
    return fail(400, "VALIDATION_FAILED", parsed.error.message);
  }
  const { primary_client_id, duplicate_client_id, confirmed } = parsed.data;

  if (primary_client_id === duplicate_client_id) {
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: MERGE_CLIENTS_ACTION.actionName,
      inputPayload: parsed.data,
      riskLevel: MERGE_CLIENTS_ACTION.riskLevel,
      confirmationRequired: MERGE_CLIENTS_ACTION.confirmationRequired,
      result: "error",
      errorMessage: "SAME_CLIENT",
    });
    return fail(400, "SAME_CLIENT", "primary_client_id and duplicate_client_id must be different clients.");
  }

  // Scoped to user.companyId — this is what makes a cross-tenant client id
  // resolve to "not found" rather than leaking another company's data, the
  // same multi-tenant guard used by every other service in this codebase.
  const [primary, duplicate] = await Promise.all([
    prisma.client.findFirst({ where: { id: primary_client_id, companyId: user.companyId } }),
    prisma.client.findFirst({ where: { id: duplicate_client_id, companyId: user.companyId } }),
  ]);

  if (!primary || !duplicate) {
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: MERGE_CLIENTS_ACTION.actionName,
      inputPayload: parsed.data,
      riskLevel: MERGE_CLIENTS_ACTION.riskLevel,
      confirmationRequired: MERGE_CLIENTS_ACTION.confirmationRequired,
      result: "error",
      errorMessage: "CLIENT_NOT_FOUND",
    });
    return fail(404, "CLIENT_NOT_FOUND", "primary_client_id and duplicate_client_id must both belong to your company.");
  }

  const counts = await countDuplicateLinkedRecords(user.companyId, duplicate.id);

  const preview = {
    primaryClientId: primary.id,
    primaryClientLabel: primary.displayName,
    duplicateClientId: duplicate.id,
    duplicateClientLabel: duplicate.displayName,
    recordsToRelink: counts,
    duplicateWillBeArchived: true,
    reversible: true,
  };

  if (!confirmed) {
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: MERGE_CLIENTS_ACTION.actionName,
      inputPayload: parsed.data,
      dataBefore: preview,
      riskLevel: MERGE_CLIENTS_ACTION.riskLevel,
      confirmationRequired: MERGE_CLIENTS_ACTION.confirmationRequired,
      result: "error",
      errorMessage: "CONFIRMATION_REQUIRED",
    });
    return fail(409, "CONFIRMATION_REQUIRED", "Review the preview and resubmit with confirmed: true.", { preview });
  }

  // One interactive transaction: snapshot the exact ids that still point at
  // the duplicate, re-point them, archive the duplicate and write the merge
  // record. Either everything commits or nothing does — there is no
  // partial-merge state and no merge without its reversal record.
  const result = await prisma.$transaction(async (tx) => {
    const relinkedIds = {} as RelinkedRecordIds;
    const relinked = emptyCounts();
    for (const type of CLIENT_LINKED_RECORD_TYPES) {
      const rows = await delegateFor(tx, type).findMany({ where: { companyId: user.companyId, clientId: duplicate.id }, select: { id: true } });
      relinkedIds[type] = rows.map((row) => row.id);
      if (rows.length === 0) continue;
      const updated = await delegateFor(tx, type).updateMany({ where: { id: { in: relinkedIds[type] }, companyId: user.companyId, clientId: duplicate.id }, data: { clientId: primary.id } });
      relinked[type] = updated.count;
    }
    const archivedDuplicate = await tx.client.update({ where: { id: duplicate.id }, data: { isActive: false } });
    const mergeRecord = await tx.clientMergeRecord.create({
      data: {
        companyId: user.companyId,
        primaryClientId: primary.id,
        duplicateClientId: duplicate.id,
        relinkedRecordIds: relinkedIds,
        duplicateWasActive: duplicate.isActive,
        mergedBy: user.id,
      },
    });
    return {
      mergeRecordId: mergeRecord.id,
      primaryClientId: primary.id,
      duplicateClientId: duplicate.id,
      relinked,
      duplicateClient: { id: archivedDuplicate.id, isActive: archivedDuplicate.isActive },
    };
  });

  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: MERGE_CLIENTS_ACTION.actionName,
    inputPayload: parsed.data,
    dataBefore: preview,
    dataAfter: result,
    riskLevel: MERGE_CLIENTS_ACTION.riskLevel,
    confirmationRequired: MERGE_CLIENTS_ACTION.confirmationRequired,
    confirmed: true,
    result: "success",
  });

  return ok(200, result);
}

// ---------------------------------------------------------------------------
// unmerge_clients — reverses exactly one recorded merge.
// ---------------------------------------------------------------------------

export const unmergeClientsSchema = z.object({
  merge_record_id: z.string().min(1, "merge_record_id is required"),
  confirmed: z.boolean().optional(),
});

/**
 * Per record type: how many snapshotted ids still point at the primary (and
 * will be moved back), and how many no longer do (deleted since, or moved to
 * a third client) — those are reported and deliberately left alone.
 */
async function assessUnmerge(client: ClientLinkedClient, companyId: string, primaryClientId: string, relinkedIds: RelinkedRecordIds) {
  const restorable = emptyCounts();
  const noLongerLinked = emptyCounts();
  for (const type of CLIENT_LINKED_RECORD_TYPES) {
    const ids = relinkedIds[type];
    if (ids.length === 0) continue;
    const rows = await delegateFor(client, type).findMany({ where: { id: { in: ids }, companyId, clientId: primaryClientId }, select: { id: true } });
    restorable[type] = rows.length;
    noLongerLinked[type] = ids.length - rows.length;
  }
  return { restorable, noLongerLinked };
}

export async function listClientMerges(user: AuthedUser) {
  const records = await prisma.clientMergeRecord.findMany({ where: { companyId: user.companyId }, orderBy: { mergedAt: "desc" } });
  const clientIds = [...new Set(records.flatMap((record) => [record.primaryClientId, record.duplicateClientId]))];
  const clients = clientIds.length
    ? await prisma.client.findMany({ where: { companyId: user.companyId, id: { in: clientIds } }, select: { id: true, displayName: true, isActive: true } })
    : [];
  const byId = new Map(clients.map((client) => [client.id, client]));
  return records.map((record) => {
    const relinkedIds = parseRelinkedIds(record.relinkedRecordIds);
    return {
      id: record.id,
      mergeStatus: record.mergeStatus,
      mergedAt: record.mergedAt.toISOString(),
      unmergedAt: record.unmergedAt?.toISOString() ?? null,
      primaryClient: { id: record.primaryClientId, label: byId.get(record.primaryClientId)?.displayName ?? null, isActive: byId.get(record.primaryClientId)?.isActive ?? null },
      duplicateClient: { id: record.duplicateClientId, label: byId.get(record.duplicateClientId)?.displayName ?? null, isActive: byId.get(record.duplicateClientId)?.isActive ?? null },
      relinkedCounts: Object.fromEntries(CLIENT_LINKED_RECORD_TYPES.map((type) => [type, relinkedIds[type].length])) as MergeCounts,
      duplicateWasActive: record.duplicateWasActive,
      unmergeSummary: record.unmergeSummary,
    };
  });
}

export async function unmergeClients(user: AuthedUser, rawInput: unknown): Promise<ServiceResult<unknown>> {
  const audit = (extra: Parameters<typeof recordAudit>[0] extends infer T ? Partial<T> : never) => recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: UNMERGE_CLIENTS_ACTION.actionName,
    riskLevel: UNMERGE_CLIENTS_ACTION.riskLevel,
    confirmationRequired: UNMERGE_CLIENTS_ACTION.confirmationRequired,
    result: "error",
    ...extra,
  } as Parameters<typeof recordAudit>[0]);

  const parsed = unmergeClientsSchema.safeParse(rawInput);
  if (!parsed.success) {
    await audit({ inputPayload: rawInput, errorMessage: "VALIDATION_FAILED" });
    return fail(400, "VALIDATION_FAILED", parsed.error.message);
  }
  const { merge_record_id, confirmed } = parsed.data;

  const record = await prisma.clientMergeRecord.findFirst({ where: { id: merge_record_id, companyId: user.companyId } });
  if (!record) {
    await audit({ inputPayload: parsed.data, errorMessage: "MERGE_RECORD_NOT_FOUND" });
    return fail(404, "MERGE_RECORD_NOT_FOUND", "No merge with this id exists for your company.");
  }
  if (record.mergeStatus !== "merged") {
    await audit({ inputPayload: parsed.data, errorMessage: "MERGE_ALREADY_REVERSED" });
    return fail(409, "MERGE_ALREADY_REVERSED", "This merge has already been reversed.");
  }

  const [primary, duplicate] = await Promise.all([
    prisma.client.findFirst({ where: { id: record.primaryClientId, companyId: user.companyId } }),
    prisma.client.findFirst({ where: { id: record.duplicateClientId, companyId: user.companyId } }),
  ]);
  if (!primary || !duplicate) {
    await audit({ inputPayload: parsed.data, errorMessage: "CLIENT_NOT_FOUND" });
    return fail(404, "CLIENT_NOT_FOUND", "One of the merged clients no longer exists, so the merge cannot be reversed automatically.");
  }

  const relinkedIds = parseRelinkedIds(record.relinkedRecordIds);
  const assessment = await assessUnmerge(prisma, user.companyId, primary.id, relinkedIds);
  const preview = {
    mergeRecordId: record.id,
    mergedAt: record.mergedAt.toISOString(),
    primaryClientId: primary.id,
    primaryClientLabel: primary.displayName,
    duplicateClientId: duplicate.id,
    duplicateClientLabel: duplicate.displayName,
    recordsToRestore: assessment.restorable,
    recordsNoLongerLinked: assessment.noLongerLinked,
    duplicateWillBeReactivated: record.duplicateWasActive,
  };

  if (!confirmed) {
    await audit({ inputPayload: parsed.data, dataBefore: preview, errorMessage: "CONFIRMATION_REQUIRED" });
    return fail(409, "CONFIRMATION_REQUIRED", "Review the preview and resubmit with confirmed: true.", { preview });
  }

  const result = await prisma.$transaction(async (tx) => {
    const restored = emptyCounts();
    const skipped = emptyCounts();
    for (const type of CLIENT_LINKED_RECORD_TYPES) {
      const ids = relinkedIds[type];
      if (ids.length === 0) continue;
      // Only ids from this merge's snapshot that still point at the primary
      // move back. Anything linked to the primary independently is untouched.
      const updated = await delegateFor(tx, type).updateMany({ where: { id: { in: ids }, companyId: user.companyId, clientId: primary.id }, data: { clientId: duplicate.id } });
      restored[type] = updated.count;
      skipped[type] = ids.length - updated.count;
    }
    const reactivated = await tx.client.update({ where: { id: duplicate.id }, data: { isActive: record.duplicateWasActive } });
    const summary = { restored, skipped, duplicateIsActive: reactivated.isActive };
    await tx.clientMergeRecord.update({ where: { id: record.id }, data: { mergeStatus: "unmerged", unmergedBy: user.id, unmergedAt: new Date(), unmergeSummary: summary } });
    return { mergeRecordId: record.id, primaryClientId: primary.id, duplicateClientId: duplicate.id, ...summary };
  });

  await audit({ inputPayload: parsed.data, dataBefore: preview, dataAfter: result, confirmed: true, result: "success", errorMessage: undefined });
  return ok(200, result);
}
