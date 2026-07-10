import { prisma } from "../db.js";

export type RiskLevel = 0 | 1 | 2 | 3 | 4 | 5;

interface AuditEntryInput {
  companyId: string;
  userId?: string | null;
  actionName: string;
  interpretedIntent?: string;
  inputPayload?: unknown;
  dataBefore?: unknown;
  dataAfter?: unknown;
  riskLevel: RiskLevel;
  confirmationRequired?: boolean;
  confirmed?: boolean;
  result: "success" | "error" | "rejected";
  errorMessage?: string;
}

/**
 * Audit Engine — every important action must be auditable.
 * Records who, what was requested, what data was used, what changed, and the result.
 * See VCUF Master Documentation section 37 and the Action Contract rule in
 * the vcubf-programmer-skill.
 */
export async function recordAudit(entry: AuditEntryInput) {
  return prisma.auditLog.create({
    data: {
      companyId: entry.companyId,
      userId: entry.userId ?? null,
      actionName: entry.actionName,
      interpretedIntent: entry.interpretedIntent,
      inputPayload: entry.inputPayload as never,
      dataBefore: entry.dataBefore as never,
      dataAfter: entry.dataAfter as never,
      riskLevel: entry.riskLevel,
      confirmationRequired: entry.confirmationRequired ?? false,
      confirmed: entry.confirmed ?? false,
      result: entry.result,
      errorMessage: entry.errorMessage,
    },
  });
}
