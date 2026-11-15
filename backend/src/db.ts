import { AsyncLocalStorage } from "node:async_hooks";
import { PrismaClient, type Prisma } from "@prisma/client";

const client = new PrismaClient();

/**
 * An ambient transaction: while work runs inside runInAmbientTransaction,
 * every query made through `prisma` anywhere in that call (an owning service,
 * its audit entry, a nested `prisma.$transaction`) goes through that one
 * transaction instead of a pooled connection. Used by the MCP gateway so a
 * direct write is made in the same transaction that holds the emergency-stop
 * lock (lib/safeMode.ts whileNotInSafeMode): it commits with that lock held,
 * or not at all. Outside such a call `prisma` is the plain client, unchanged.
 */
const ambient = new AsyncLocalStorage<Prisma.TransactionClient>();

export function runInAmbientTransaction<T>(tx: Prisma.TransactionClient, work: () => Promise<T>): Promise<T> {
  return ambient.run(tx, work);
}

/** True while running inside an ambient transaction. */
export function inAmbientTransaction(): boolean {
  return ambient.getStore() !== undefined;
}

export const prisma = new Proxy(client, {
  get(target, property) {
    const tx = ambient.getStore();
    if (!tx) {
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    }
    if (property === "$transaction") {
      // Nested transactions join the ambient one: the callback form runs on
      // it, the array form runs its queries on it in order.
      return async (input: unknown) => {
        if (typeof input === "function") return (input as (tx: Prisma.TransactionClient) => Promise<unknown>)(tx);
        const results: unknown[] = [];
        for (const query of input as Array<Promise<unknown>>) results.push(await query);
        return results;
      };
    }
    const value = Reflect.get(tx as object, property);
    return typeof value === "function" ? value.bind(tx) : value;
  },
}) as PrismaClient;
