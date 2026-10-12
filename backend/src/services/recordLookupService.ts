import type { AuthedUser } from "../middleware/auth.js";
import { prisma } from "../db.js";
import { matchRecord, type RecordCandidate } from "../lib/recordMatch.js";
import { recordPath, type RecordKind } from "../lib/recordKinds.js";
import { fail, ok, type ServiceResult } from "./result.js";

// Opening one record by name, as clicking it in its list does. Read-only: it
// finds the record in the user's own company and says where it is; the page
// then shows it. Each kind needs the permission its list needs.

const READ_PERMISSION: Record<RecordKind, string> = {
  client: "crm.read",
  contact: "crm.read",
  lead: "crm.read",
  job: "crm.read",
  quote: "crm.read",
  invoice: "crm.read",
  employee: "crm.read",
  job_opening: "recruitment.manage",
  playbook: "voice.execute",
};

/** Enough for any one company's records; the newest come first. */
const CANDIDATE_LIMIT = 2000;

async function candidates(user: AuthedUser, kind: RecordKind): Promise<RecordCandidate[]> {
  const companyId = user.companyId;
  const take = CANDIDATE_LIMIT;
  switch (kind) {
    case "client":
      return (await prisma.client.findMany({ where: { companyId, isActive: true }, select: { id: true, displayName: true }, orderBy: { createdAt: "desc" }, take }))
        .map((row) => ({ id: row.id, label: row.displayName, names: [row.displayName] }));
    case "contact":
      return (await prisma.contact.findMany({ where: { companyId, isActive: true }, select: { id: true, displayName: true, client: { select: { displayName: true } } }, orderBy: { createdAt: "desc" }, take }))
        .map((row) => ({ id: row.id, label: row.client ? `${row.displayName} (${row.client.displayName})` : row.displayName, names: [row.displayName] }));
    case "lead":
      return (await prisma.lead.findMany({ where: { companyId }, select: { id: true, name: true }, orderBy: { createdAt: "desc" }, take }))
        .map((row) => ({ id: row.id, label: row.name, names: [row.name] }));
    case "job":
      return (await prisma.job.findMany({ where: { companyId }, select: { id: true, jobTitle: true, client: { select: { displayName: true } } }, orderBy: { createdAt: "desc" }, take }))
        .map((row) => ({ id: row.id, label: `${row.jobTitle} (${row.client.displayName})`, names: [row.jobTitle, row.client.displayName] }));
    case "quote":
      return (await prisma.quote.findMany({ where: { companyId }, select: { id: true, title: true, client: { select: { displayName: true } } }, orderBy: { createdAt: "desc" }, take }))
        .map((row) => ({ id: row.id, label: `${row.title} (${row.client.displayName})`, names: [row.title, row.client.displayName] }));
    case "invoice":
      return (await prisma.invoice.findMany({ where: { companyId }, select: { id: true, invoiceNumber: true, title: true, client: { select: { displayName: true } } }, orderBy: { createdAt: "desc" }, take }))
        .map((row) => ({ id: row.id, label: `${row.invoiceNumber} (${row.client.displayName})`, names: [row.invoiceNumber, row.title, row.client.displayName] }));
    case "employee":
      return (await prisma.user.findMany({ where: { companyId, isActive: true }, select: { id: true, displayName: true }, orderBy: { createdAt: "desc" }, take }))
        .map((row) => ({ id: row.id, label: row.displayName, names: [row.displayName] }));
    case "job_opening":
      return (await prisma.jobOpening.findMany({ where: { companyId }, select: { id: true, title: true }, orderBy: { createdAt: "desc" }, take }))
        .map((row) => ({ id: row.id, label: row.title, names: [row.title] }));
    case "playbook":
      return (await prisma.playbook.findMany({ where: { companyId, isActive: true }, select: { id: true, name: true }, orderBy: { createdAt: "desc" }, take }))
        .map((row) => ({ id: row.id, label: row.name, names: [row.name] }));
  }
}

export interface OpenedRecord {
  kind: RecordKind;
  id: string;
  label: string;
  path: string;
}

export async function findRecordToOpen(user: AuthedUser, kind: RecordKind, said: string): Promise<ServiceResult<OpenedRecord>> {
  if (!user.permissions.includes(READ_PERMISSION[kind])) {
    return fail(403, "MISSING_PERMISSION", `The ${READ_PERMISSION[kind]} permission is required to open this record.`);
  }
  const match = matchRecord(said, await candidates(user, kind));
  if (match.outcome === "none") return fail(404, "RECORD_NOT_FOUND", `No ${kind} matches '${said}'.`, { kind, said });
  if (match.outcome === "ambiguous") {
    return fail(409, "AMBIGUOUS_REFERENCE", `More than one ${kind} matches '${said}'.`, { kind, said, candidates: match.records.slice(0, 5).map((record) => record.label), more: Math.max(0, match.records.length - 5) });
  }
  return ok(200, { kind, id: match.record.id, label: match.record.label, path: recordPath(kind, match.record.id) });
}
