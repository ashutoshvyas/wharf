/**
 * Connectivity dry-run for the panel database (run: npm run db:check).
 *
 * Loads .env, then verifies in order:
 *   1. DATABASE_URL / DIRECT_URL are set and parseable
 *   2. a connection can be opened and `SELECT 1` works (runtime URL)
 *   3. which migrations are applied vs pending (via _prisma_migrations)
 *   4. whether the WHARF tables exist and how many rows each has
 *
 * Exits 0 when the runtime connection works, 1 otherwise — safe to run
 * any time; it never writes.
 */
import { config as loadEnv } from "dotenv";
import { PrismaClient } from "@prisma/client";
import { readdirSync } from "node:fs";
import { join } from "node:path";

loadEnv({ quiet: true });

function redact(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "****";
    return u.toString();
  } catch {
    return "<unparseable URL>";
  }
}

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  const directUrl = process.env.DIRECT_URL;

  if (!dbUrl) {
    console.error("✗ DATABASE_URL is not set — fill it in .env (see .env.example).");
    process.exit(1);
  }
  console.log(`› DATABASE_URL  ${redact(dbUrl)}`);
  if (directUrl) {
    console.log(`› DIRECT_URL    ${redact(directUrl)}`);
  } else {
    console.log("! DIRECT_URL not set — prisma migrate will fall back to DATABASE_URL; fine only if that is a direct (non-pgbouncer) connection.");
  }

  const prisma = new PrismaClient();
  try {
    const t0 = Date.now();
    await prisma.$queryRaw`SELECT 1`;
    console.log(`✓ Connected (${Date.now() - t0}ms)`);
  } catch (err) {
    // Prisma error messages are multi-line with an "invocation" header;
    // surface the line that actually states the cause.
    const lines =
      err instanceof Error
        ? err.message.split("\n").map((l) => l.trim()).filter(Boolean)
        : [String(err)];
    const cause =
      lines.find((l) =>
        /can't reach|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|authentication|password|certificate|timeout|denied/i.test(l),
      ) ??
      lines.filter((l) => !/invocation/i.test(l)).pop() ??
      lines[0] ??
      "unknown error";
    console.error(`✗ Connection failed: ${cause}`);
    process.exit(1);
  }

  // Migration status
  const localMigrations = readdirSync(join(process.cwd(), "prisma", "migrations"), {
    withFileTypes: true,
  })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  try {
    const applied = await prisma.$queryRaw<
      Array<{ migration_name: string }>
    >`SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name`;
    const appliedNames = new Set(applied.map((m) => m.migration_name));
    for (const m of localMigrations) {
      console.log(`${appliedNames.has(m) ? "✓" : "○"} migration ${m}${appliedNames.has(m) ? "" : "  (pending — run: npm run db:deploy)"}`);
    }
  } catch {
    console.log(`○ No _prisma_migrations table — fresh database. ${localMigrations.length} migration(s) pending — run: npm run db:deploy`);
  }

  // Table row counts (best-effort; tables may not exist yet)
  const tables = ["panel_users", "servers", "websites", "db_instances", "audit_log"];
  for (const t of tables) {
    try {
      const rows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
        `SELECT count(*)::bigint AS count FROM "${t}"`,
      );
      console.log(`✓ table ${t}: ${rows[0]?.count ?? 0n} rows`);
    } catch {
      console.log(`○ table ${t}: missing (expected before first migrate)`);
    }
  }

  await prisma.$disconnect();
  console.log("✓ db:check complete");
}

main();
