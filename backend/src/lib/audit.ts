import { prisma } from "../db.js";
import { computeEntryHash, GENESIS_HASH } from "./auditChain.js";

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
 *
 * CP-CODE-001: entries are hash-chained per company (CON-020/CON-026, SEC-04).
 * The chain is written inside a transaction that serialises on the company's
 * latest chained row, so concurrent writers cannot fork the chain. The table is
 * append-only at the database level (trigger in migration 20260920100000).
 */
export async function recordAudit(entry: AuditEntryInput) {
  const createdAt = new Date();
  return prisma.$transaction(async (tx) => {
    // Serialise per company: lock the latest chained row (if any).
    const last = await tx.$queryRaw<Array<{ sequence_no: bigint | null; entry_hash: string | null }>>`
      SELECT sequence_no, entry_hash FROM audit_log
      WHERE company_id = ${entry.companyId} AND sequence_no IS NOT NULL
      ORDER BY sequence_no DESC LIMIT 1 FOR UPDATE`;
    const prevSeq = last[0]?.sequence_no ?? 0n;
    const prevHash = last[0]?.entry_hash ?? GENESIS_HASH;
    const sequenceNo = BigInt(prevSeq) + 1n;
    const fields = {
      companyId: entry.companyId,
      userId: entry.userId ?? null,
      actionName: entry.actionName,
      interpretedIntent: entry.interpretedIntent ?? null,
      inputPayload: entry.inputPayload,
      dataBefore: entry.dataBefore,
      dataAfter: entry.dataAfter,
      riskLevel: entry.riskLevel,
      confirmationRequired: entry.confirmationRequired ?? false,
      confirmed: entry.confirmed ?? false,
      result: entry.result,
      errorMessage: entry.errorMessage ?? null,
      createdAt,
      sequenceNo,
    };
    const entryHash = computeEntryHash(prevHash, fields);
    return tx.auditLog.create({
      data: {
        companyId: fields.companyId,
        userId: fields.userId,
        actionName: fields.actionName,
        interpretedIntent: fields.interpretedIntent ?? undefined,
        inputPayload: fields.inputPayload as never,
        dataBefore: fields.dataBefore as never,
        dataAfter: fields.dataAfter as never,
        riskLevel: fields.riskLevel,
        confirmationRequired: fields.confirmationRequired,
        confirmed: fields.confirmed,
        result: fields.result,
        errorMessage: fields.errorMessage ?? undefined,
        createdAt,
        sequenceNo,
        prevHash,
        entryHash,
      },
    });
  });
}
