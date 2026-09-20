/**
 * Audit hash chain (Engineering Bible v6.1: CON-020, CON-026, SEC-04; ADR-020 open).
 * Pure functions — no I/O — so the chain rule is unit-testable without a database.
 *
 * entry_hash = sha256( prev_hash || canonical(entry) )
 * Chains are per company. The first entry of a chain has prev_hash = GENESIS.
 */
import { createHash } from "node:crypto";

export const GENESIS_HASH = "0".repeat(64);

export interface ChainedAuditFields {
  companyId: string;
  userId: string | null;
  actionName: string;
  interpretedIntent?: string | null;
  inputPayload?: unknown;
  dataBefore?: unknown;
  dataAfter?: unknown;
  riskLevel: number;
  confirmationRequired: boolean;
  confirmed: boolean;
  result: string;
  errorMessage?: string | null;
  createdAt: Date;
  sequenceNo: bigint | number;
}

/** Deterministic JSON: sorted object keys, no undefined, Dates as ISO, bigint as string. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (value === undefined) return null;
  if (value === null) return null;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

/** Only the chained fields participate in the hash — never db ids, prev_hash, entry_hash or unrelated columns. */
export function chainedFields(entry: ChainedAuditFields): Record<string, unknown> {
  return {
    companyId: entry.companyId,
    userId: entry.userId ?? null,
    actionName: entry.actionName,
    interpretedIntent: entry.interpretedIntent ?? null,
    inputPayload: entry.inputPayload ?? null,
    dataBefore: entry.dataBefore ?? null,
    dataAfter: entry.dataAfter ?? null,
    riskLevel: entry.riskLevel,
    confirmationRequired: entry.confirmationRequired,
    confirmed: entry.confirmed,
    result: entry.result,
    errorMessage: entry.errorMessage ?? null,
    createdAt: entry.createdAt,
    sequenceNo: entry.sequenceNo.toString(),
  };
}

export function computeEntryHash(prevHash: string, entry: ChainedAuditFields): string {
  const h = createHash("sha256");
  h.update(prevHash);
  h.update("\n");
  h.update(canonicalJson(chainedFields(entry)));
  return h.digest("hex");
}

export interface ChainVerificationResult {
  ok: boolean;
  checked: number;
  firstBrokenSequenceNo?: string;
  reason?: string;
}

/** Verify an ordered list of entries (ascending sequence_no) for one company. */
export function verifyChain(entries: Array<ChainedAuditFields & { prevHash: string | null; entryHash: string | null }>): ChainVerificationResult {
  let expectedPrev = GENESIS_HASH;
  let checked = 0;
  for (const e of entries) {
    if (e.prevHash === null || e.entryHash === null) {
      return { ok: false, checked, firstBrokenSequenceNo: e.sequenceNo.toString(), reason: "MISSING_HASH" };
    }
    if (e.prevHash !== expectedPrev) {
      return { ok: false, checked, firstBrokenSequenceNo: e.sequenceNo.toString(), reason: "PREV_HASH_MISMATCH" };
    }
    const recomputed = computeEntryHash(e.prevHash, e);
    if (recomputed !== e.entryHash) {
      return { ok: false, checked, firstBrokenSequenceNo: e.sequenceNo.toString(), reason: "ENTRY_HASH_MISMATCH" };
    }
    expectedPrev = e.entryHash;
    checked += 1;
  }
  return { ok: true, checked };
}
