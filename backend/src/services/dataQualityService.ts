import { z } from "zod";
import { prisma } from "../db.js";
import { recordAudit } from "../lib/audit.js";
import { MERGE_CLIENTS_ACTION } from "../lib/actionContracts.js";
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

interface MergeCounts {
  jobs: number;
  quotes: number;
  communicationRecords: number;
  communicationIntakes: number;
  portfolioPhotos: number;
  contacts: number;
  documentRecords: number;
  tasks: number;
}

async function countDuplicateLinkedRecords(companyId: string, duplicateClientId: string): Promise<MergeCounts> {
  const [jobs, quotes, communicationRecords, communicationIntakes, portfolioPhotos, contacts, documentRecords, tasks] = await Promise.all([
    prisma.job.count({ where: { companyId, clientId: duplicateClientId } }),
    prisma.quote.count({ where: { companyId, clientId: duplicateClientId } }),
    prisma.communicationRecord.count({ where: { companyId, clientId: duplicateClientId } }),
    prisma.communicationIntake.count({ where: { companyId, clientId: duplicateClientId } }),
    prisma.portfolioPhoto.count({ where: { companyId, clientId: duplicateClientId } }),
    prisma.contact.count({ where: { companyId, clientId: duplicateClientId } }),
    prisma.documentRecord.count({ where: { companyId, clientId: duplicateClientId } }),
    prisma.task.count({ where: { companyId, clientId: duplicateClientId } }),
  ]);
  return { jobs, quotes, communicationRecords, communicationIntakes, portfolioPhotos, contacts, documentRecords, tasks };
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

  // Single Prisma $transaction — every updateMany plus the duplicate's
  // isActive flip either all succeed or all roll back together. There is no
  // partial-merge state: a job either still points at the duplicate, or the
  // whole merge (all supported client-linked record types + archive) has completed.
  const [jobsRelinked, quotesRelinked, communicationRecordsRelinked, communicationIntakesRelinked, portfolioPhotosRelinked, contactsRelinked, documentRecordsRelinked, tasksRelinked, archivedDuplicate] =
    await prisma.$transaction([
      prisma.job.updateMany({
        where: { companyId: user.companyId, clientId: duplicate.id },
        data: { clientId: primary.id },
      }),
      prisma.quote.updateMany({
        where: { companyId: user.companyId, clientId: duplicate.id },
        data: { clientId: primary.id },
      }),
      prisma.communicationRecord.updateMany({
        where: { companyId: user.companyId, clientId: duplicate.id },
        data: { clientId: primary.id },
      }),
      prisma.communicationIntake.updateMany({
        where: { companyId: user.companyId, clientId: duplicate.id },
        data: { clientId: primary.id },
      }),
      prisma.portfolioPhoto.updateMany({
        where: { companyId: user.companyId, clientId: duplicate.id },
        data: { clientId: primary.id },
      }),
      prisma.contact.updateMany({
        where: { companyId: user.companyId, clientId: duplicate.id },
        data: { clientId: primary.id },
      }),
      prisma.documentRecord.updateMany({
        where: { companyId: user.companyId, clientId: duplicate.id },
        data: { clientId: primary.id },
      }),
      prisma.task.updateMany({
        where: { companyId: user.companyId, clientId: duplicate.id },
        data: { clientId: primary.id },
      }),
      prisma.client.update({
        where: { id: duplicate.id },
        data: { isActive: false },
      }),
    ]);

  const result = {
    primaryClientId: primary.id,
    duplicateClientId: duplicate.id,
    relinked: {
      jobs: jobsRelinked.count,
      quotes: quotesRelinked.count,
      communicationRecords: communicationRecordsRelinked.count,
      communicationIntakes: communicationIntakesRelinked.count,
      portfolioPhotos: portfolioPhotosRelinked.count,
      contacts: contactsRelinked.count,
      documentRecords: documentRecordsRelinked.count,
      tasks: tasksRelinked.count,
    },
    duplicateClient: { id: archivedDuplicate.id, isActive: archivedDuplicate.isActive },
  };

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
