/**
 * PrismaClient singleton for the gateway.
 *
 * Constructed lazily on first use so that /healthz works (and boot succeeds)
 * without a reachable database — Prisma only opens connections on the first
 * query. Never call $connect() at boot.
 */
import { PrismaClient } from "@prisma/client";

let client: PrismaClient | null = null;

export function getPrisma(): PrismaClient {
  if (!client) {
    client = new PrismaClient();
  }
  return client;
}
