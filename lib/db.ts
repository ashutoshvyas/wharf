import { PrismaClient } from "@prisma/client";

// Prisma client singleton. In dev, Next.js hot reload re-evaluates modules,
// so we stash the client on globalThis to avoid exhausting DB connections.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
