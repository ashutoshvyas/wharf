/**
 * WHARF master-key rotation (architecture.md §6).
 *
 * Re-encrypts every `*_enc` column from WHARF_MASTER_KEY_OLD to
 * WHARF_MASTER_KEY_NEW (both base64-encoded 32-byte keys). Intended to run
 * offline, against the panel database, while the panel is stopped:
 *
 *   WHARF_MASTER_KEY_OLD=... WHARF_MASTER_KEY_NEW=... npx tsx scripts/rotate-key.ts [--dry-run]
 *
 * For each row/field, the NEW key is tried first — values it opens are
 * already rotated and are skipped, so reruns are idempotent. Otherwise the
 * value is opened with the OLD key and re-sealed with the NEW key. Each batch
 * of updates is applied in a single transaction. --dry-run performs the
 * decrypt checks but writes nothing.
 *
 * Exits non-zero if any field failed to open with both keys (that value would
 * be unrecoverable under the new key — investigate before switching keys).
 *
 * Secret values and keys are never printed.
 */
import { PrismaClient } from "@prisma/client";
import { openWith, sealWith } from "../lib/crypto";

const BATCH_SIZE = 100;
const KEY_LENGTH = 32;

interface RotationTarget {
  /** Prisma client delegate name (camelCase model accessor). */
  model: "server" | "website" | "dbInstance";
  /** Encrypted Bytes? fields on that model. */
  fields: string[];
}

/** The agreed model/field contract (see prisma/schema.prisma). */
const TARGETS: RotationTarget[] = [
  { model: "server", fields: ["sshPasswordEnc", "sshPrivateKeyEnc", "panelUserEnc", "panelPassEnc"] },
  { model: "website", fields: ["accessPasswordEnc"] },
  { model: "dbInstance", fields: ["pgPasswordEnc", "anonKeyEnc", "serviceRoleKeyEnc", "jwtSecretEnc"] },
];

interface Counts {
  rotated: number;
  skipped: number;
  failed: number;
}

type EncryptedRow = { id: string } & Record<string, Uint8Array | null | unknown>;

/** Minimal typing for the delegate surface this script uses. */
interface Delegate {
  findMany(args: {
    select: Record<string, boolean>;
    orderBy: { id: "asc" };
    take: number;
    where?: { id: { gt: string } };
  }): Promise<EncryptedRow[]>;
  update(args: { where: { id: string }; data: Record<string, Buffer> }): Promise<unknown>;
}

function delegateOf(client: unknown, model: RotationTarget["model"]): Delegate {
  return (client as Record<RotationTarget["model"], Delegate>)[model];
}

function readKeyEnv(name: string): Buffer {
  const raw = process.env[name];
  if (!raw) {
    console.error(`Error: ${name} is not set. Provide a base64-encoded 32-byte key.`);
    process.exit(1);
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== KEY_LENGTH) {
    console.error(`Error: ${name} must decode to exactly ${KEY_LENGTH} bytes (got ${key.length}).`);
    process.exit(1);
  }
  return key;
}

async function rotateTarget(
  prisma: PrismaClient,
  target: RotationTarget,
  oldKey: Buffer,
  newKey: Buffer,
  dryRun: boolean,
): Promise<Counts> {
  const counts: Counts = { rotated: 0, skipped: 0, failed: 0 };
  const delegate = delegateOf(prisma, target.model);
  const select: Record<string, boolean> = { id: true };
  for (const field of target.fields) select[field] = true;

  let cursor: string | null = null;
  for (;;) {
    const rows: EncryptedRow[] = await delegate.findMany({
      select,
      orderBy: { id: "asc" },
      take: BATCH_SIZE,
      ...(cursor !== null ? { where: { id: { gt: cursor } } } : {}),
    });
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1]!.id;

    const updates: { id: string; data: Record<string, Buffer> }[] = [];
    for (const row of rows) {
      const data: Record<string, Buffer> = {};
      for (const field of target.fields) {
        const value = row[field];
        if (value === null || value === undefined) continue;
        const sealed = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
        try {
          openWith(newKey, sealed);
          counts.skipped += 1; // already under the new key
          continue;
        } catch {
          // fall through to the old key
        }
        try {
          const plaintext = openWith(oldKey, sealed);
          data[field] = sealWith(newKey, plaintext);
          counts.rotated += 1;
        } catch {
          counts.failed += 1;
          console.error(`  FAILED ${target.model} id=${row.id} field=${field}: opens with neither key`);
        }
      }
      if (Object.keys(data).length > 0) updates.push({ id: row.id, data });
    }

    if (!dryRun && updates.length > 0) {
      await prisma.$transaction(async (tx: unknown) => {
        const txDelegate = delegateOf(tx, target.model);
        for (const u of updates) {
          await txDelegate.update({ where: { id: u.id }, data: u.data });
        }
      });
    }
  }
  return counts;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const oldKey = readKeyEnv("WHARF_MASTER_KEY_OLD");
  const newKey = readKeyEnv("WHARF_MASTER_KEY_NEW");
  if (oldKey.equals(newKey)) {
    console.warn("Warning: WHARF_MASTER_KEY_OLD and WHARF_MASTER_KEY_NEW are identical; every value will be skipped.");
  }

  const prisma = new PrismaClient();
  const totals: Counts = { rotated: 0, skipped: 0, failed: 0 };
  try {
    console.log(`Master-key rotation${dryRun ? " (dry run — no writes)" : ""}`);
    for (const target of TARGETS) {
      const counts = await rotateTarget(prisma, target, oldKey, newKey, dryRun);
      totals.rotated += counts.rotated;
      totals.skipped += counts.skipped;
      totals.failed += counts.failed;
      console.log(
        `  ${target.model.padEnd(10)} rotated=${counts.rotated} skipped=${counts.skipped} failed=${counts.failed}`,
      );
    }
    console.log(
      `Summary: rotated=${totals.rotated} skipped=${totals.skipped} failed=${totals.failed}${
        dryRun ? " (dry run — nothing was written)" : ""
      }`,
    );
  } finally {
    await prisma.$disconnect();
  }

  if (totals.failed > 0) {
    console.error("Rotation finished with failures: some values open with neither key. Do NOT discard the old key.");
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error("Rotation aborted:", err instanceof Error ? err.message : err);
  process.exit(1);
});
