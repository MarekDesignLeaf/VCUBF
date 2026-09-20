import { PrismaClient } from "@prisma/client";

// audit_log.sequence_no is a BigInt (CP-CODE-001 audit hash chain). JSON.stringify
// throws on BigInt by default, which would turn any accidental serialisation of an
// audit row (or of another BigInt column) into a 500. Serialise BigInt as a decimal
// string everywhere; the explicit conversion in modules/audit/routes.ts stays as the
// documented contract for the public API.
if (typeof (BigInt.prototype as { toJSON?: unknown }).toJSON !== "function") {
  Object.defineProperty(BigInt.prototype, "toJSON", {
    value: function toJSON(this: bigint): string {
      return this.toString();
    },
    writable: true,
    configurable: true,
  });
}

export const prisma = new PrismaClient();
