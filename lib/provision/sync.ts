/**
 * Live-database sync — pull an existing, running database (a hosted
 * Supabase project, or any reachable Postgres) into a WHARF instance,
 * replacing its data.
 *
 * This is restore.ts's pipeline with a different SOURCE: instead of an
 * operator uploading a dump they made by hand, the engine dumps the live
 * source itself. Detached job under `sync:{instanceId}` holding the
 * per-server lock, phases `connect → dump → snapshot → restore → storage →
 * cleanup`, and the same safety snapshot of the current data before anything
 * is overwritten.
 *
 * WHERE THE WORK HAPPENS: every pg_dump/pg_restore/psql runs INSIDE the
 * instance's own `db` container via `docker compose exec` — that image ships
 * the version-matched client tools, so nothing is installed on the managed
 * host and, crucially, the dump never transits the panel. WHARF stays a
 * control plane (architecture §1). Storage OBJECTS are copied the same way:
 * a generated shell script `curl`s them source → instance from the managed
 * server itself.
 *
 * THREE DUMP PASSES, and the order they are LOADED in matters:
 *   1. identity  — data-only `auth.users`/`auth.identities`/`auth.mfa_factors`
 *   2. storage   — data-only `storage.buckets`/`storage.objects`
 *   3. main      — schema + data for `public` (+ any extra schemas)
 * The two data-only passes must be loaded FIRST: clearing `auth.users` needs
 * `TRUNCATE … CASCADE` (app tables reference it), which would delete rows the
 * main pass had just loaded if it ran after. Loading identity first also
 * means the app tables' FKs to `auth.users` are satisfied as they load.
 * Data-only (never the source's auth/storage SCHEMA) is deliberate: the local
 * GoTrue/storage-api containers own those schemas and their migration state,
 * and restoring a hosted project's version of them over the top would break
 * containers this panel provisioned.
 *
 * SECRETS: the source password and both service_role keys reach the remote
 * side only through `-e PGPASSWORD=…` (docker compose exec) or a mode-0600
 * env file the script sources — never through argv, and never through a log
 * line. Log lines name host/port/database/user only.
 */
import { audit } from "@/lib/audit";
import type { EmitFn } from "@/lib/bootstrap/steps";
import { open } from "@/lib/crypto";
import { prisma } from "@/lib/db";
import { serverLockHolder, tryAcquireServerLock } from "@/lib/jobs/lock";
import { endJob, startJob } from "@/lib/jobs/stream";
import { exec, sftpWrite, withConnection } from "@/lib/ssh";
import {
  LogTail,
  makeEmitter,
  persistLogTail,
  runPhase,
  syncJobId,
  type ProvisionCtx,
} from "./pipeline";
import {
  loadDumpIntoTarget,
  pgPasswordEnv,
  shellQuote,
  takeSafetySnapshot,
} from "./restore-core";
import { assertSafeRemotePath } from "./teardown";

/** The connection handle lib/ssh hands out (ssh2 Client, never imported here). */
type SshConnection = Parameters<typeof exec>[0];

/** Identity tables copied data-only when `includeAuthUsers` is on.
 * Deliberately NOT `auth.sessions`/`auth.refresh_tokens`/`auth.mfa_amr_claims`:
 * those are per-session state that would arrive dangling, and users signing in
 * again re-creates them. */
const AUTH_TABLES = ["auth.users", "auth.identities", "auth.mfa_factors"] as const;

/** Storage METADATA tables (the files themselves are copied in `storage`). */
const STORAGE_TABLES = ["storage.buckets", "storage.objects"] as const;

/** Refuse to build a manifest bigger than this — bounds one job's runtime. */
export const MAX_SYNC_OBJECTS = 50_000;

const CONNECT_TIMEOUT_MS = 60_000;
const DUMP_TIMEOUT_MS = 60 * 60_000;
/** The object-copy loop is one long-lived remote command; be generous. */
const STORAGE_TIMEOUT_MS = 2 * 60 * 60_000;
/** Per-object curl budget inside that loop. */
const OBJECT_TIMEOUT_S = 600;
const MAX_OBJECT_BYTES = 5 * 1024 * 1024 * 1024;

/** Decrypted source connection details — never persisted, never logged. */
export interface SyncSource {
  kind: "supabase" | "postgres";
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  sslMode: string;
  projectUrl: string | null;
  serviceRoleKey: string | null;
  includeAuthUsers: boolean;
  includeStorageObjects: boolean;
  extraSchemas: string[];
}

/**
 * `postgresql://user@host:port/db?sslmode=…` — no password (that travels as
 * PGPASSWORD), so this string is safe to put in a remote command line. The
 * components are already charset-restricted at the API boundary
 * (lib/instances/sync-source-schema.ts); percent-encoding here is the second
 * layer, and shellQuote at the call site is the third.
 */
export function buildConnInfo(src: {
  host: string;
  port: number;
  database: string;
  user: string;
  sslMode: string;
}): string {
  const user = encodeURIComponent(src.user);
  const database = encodeURIComponent(src.database);
  const sslmode = encodeURIComponent(src.sslMode);
  return `postgresql://${user}@${src.host}:${src.port}/${database}?sslmode=${sslmode}`;
}

/** Human-readable source identity for log lines — deliberately password-free. */
export function describeSource(src: SyncSource): string {
  return `${src.user}@${src.host}:${src.port}/${src.database} (sslmode=${src.sslMode})`;
}

/** Percent-encode a storage path segment-by-segment (slashes stay slashes). */
export function encodeObjectPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

export interface ManifestEntry {
  bucket: string;
  path: string;
  contentType: string;
}

/**
 * Parse the tab-separated object list psql produces into manifest entries.
 *
 * Object names are arbitrary user input; one containing a tab or newline would
 * desynchronize both this parse and the shell loop's `read`, so those rows are
 * dropped and reported rather than guessed at.
 */
export function parseObjectList(stdout: string): {
  entries: ManifestEntry[];
  skipped: number;
} {
  const entries: ManifestEntry[] = [];
  let skipped = 0;
  for (const line of stdout.split("\n")) {
    const row = line.replace(/\r$/, "");
    if (!row.trim()) continue;
    const parts = row.split("\t");
    if (parts.length !== 3 || !parts[0] || !parts[1]) {
      skipped += 1;
      continue;
    }
    entries.push({
      bucket: parts[0],
      path: parts[1],
      contentType: parts[2] || "application/octet-stream",
    });
  }
  return { entries, skipped };
}

/**
 * The object-copy loop, run on the managed server. Credentials come from the
 * mode-0600 env file passed as $1 (sourced, so they never appear in argv or
 * in `ps`); everything else is already percent-encoded in the manifest.
 *
 * A per-object failure is counted and skipped, never fatal — a sync of 10 000
 * objects must not be thrown away because one of them 404s on the source.
 */
export function renderStorageScript(): string {
  return `#!/bin/sh
# Generated by WHARF. Deleted at the end of the sync job.
set -u
. "$1"

ok=0
failed=0
n=0
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

while IFS='\t' read -r bucket path ctype; do
  [ -z "$bucket" ] && continue
  n=$((n + 1))
  if ! curl -sS --fail --max-time ${OBJECT_TIMEOUT_S} --max-filesize ${MAX_OBJECT_BYTES} \\
      -H "Authorization: Bearer $SRC_TOKEN" \\
      "$SRC_URL/storage/v1/object/authenticated/$bucket/$path" -o "$tmp"; then
    failed=$((failed + 1))
    echo "FAIL download $bucket/$path"
    continue
  fi
  # -T streams the file instead of buffering it in memory like --data-binary.
  if ! curl -sS --fail --max-time ${OBJECT_TIMEOUT_S} -X POST -T "$tmp" \\
      -H "Authorization: Bearer $DST_TOKEN" \\
      -H "x-upsert: true" \\
      -H "Content-Type: $ctype" \\
      "$DST_URL/storage/v1/object/$bucket/$path" -o /dev/null; then
    failed=$((failed + 1))
    echo "FAIL upload $bucket/$path"
    continue
  fi
  ok=$((ok + 1))
  [ $((n % 25)) -eq 0 ] && echo "PROGRESS $n/$TOTAL"
done < "$MANIFEST"

echo "DONE ok=$ok failed=$failed"
`;
}

export type StartSyncResult = { jobId: string } | { busy: string } | { invalid: string };

/**
 * Kick off a detached sync job. Same guards as startRestore — a `running`
 * instance whose name matches `confirmName`, admin-gated at the route — plus
 * "a sync source is configured", and, when storage copying is on, the two
 * service_role keys that copy needs.
 */
export async function startSync(
  instanceId: string,
  ctx: ProvisionCtx,
  confirmName: string,
): Promise<StartSyncResult> {
  const instance = await prisma.dbInstance.findFirst({
    where: { id: instanceId, deletedAt: null },
    include: { syncSource: true },
  });
  if (!instance) return { invalid: `Instance ${instanceId} was not found.` };
  if (confirmName !== instance.name) {
    return { invalid: "Confirmation does not match the instance name." };
  }
  if (instance.status !== "running") {
    return {
      invalid:
        `Sync is only available for a running instance ` +
        `(this instance is '${instance.status}').`,
    };
  }
  if (!instance.pgPasswordEnc) {
    return {
      invalid: "This instance has no stored Postgres password — it never finished provisioning.",
    };
  }
  const stored = instance.syncSource;
  if (!stored) {
    return { invalid: "No sync source is configured for this instance." };
  }

  const source: SyncSource = {
    kind: stored.kind,
    host: stored.pgHost,
    port: stored.pgPort,
    database: stored.pgDatabase,
    user: stored.pgUser,
    password: open(stored.pgPasswordEnc),
    sslMode: stored.pgSslMode,
    projectUrl: stored.projectUrl,
    serviceRoleKey: stored.serviceRoleKeyEnc ? open(stored.serviceRoleKeyEnc) : null,
    includeAuthUsers: stored.includeAuthUsers,
    includeStorageObjects: stored.includeStorageObjects,
    extraSchemas: stored.extraSchemas,
  };

  if (source.includeStorageObjects) {
    if (!source.projectUrl || !source.serviceRoleKey) {
      return {
        invalid:
          "Copying storage objects needs the source project URL and its service_role key — " +
          "add them to the sync source, or turn storage copying off.",
      };
    }
    if (!instance.serviceRoleKeyEnc) {
      return {
        invalid:
          "This instance has no stored service_role key, so storage objects cannot be " +
          "uploaded into it — turn storage copying off.",
      };
    }
  }

  const release = tryAcquireServerLock(instance.serverId, "sync");
  if (!release) {
    return { busy: serverLockHolder(instance.serverId) ?? "another job" };
  }

  const jobId = syncJobId(instanceId);
  try {
    await prisma.dbInstance.update({
      where: { id: instanceId },
      data: { status: "restoring" },
    });
    startJob(jobId);
  } catch (err) {
    release();
    throw err;
  }

  void runSync(
    {
      id: instance.id,
      serverId: instance.serverId,
      composeProjectName: instance.composeProjectName,
      remotePath: instance.remotePath,
      apiSubdomain: instance.apiSubdomain,
      pgPassword: open(instance.pgPasswordEnc),
      serviceRoleKey: instance.serviceRoleKeyEnc ? open(instance.serviceRoleKeyEnc) : null,
    },
    source,
    ctx,
    jobId,
    release,
  );
  return { jobId };
}

export type TestSyncSourceResult =
  | { ok: true; detail: string }
  | { ok: false; detail: string }
  | { busy: string }
  | { invalid: string };

/**
 * Read-only connectivity probe against the configured source — the `connect`
 * phase on its own, so an operator can find out that a password or host is
 * wrong without starting a job that overwrites data.
 *
 * Holds the server lock for the duration (it runs a command in the instance's
 * db container), but that is one short `psql -c 'select …'`.
 */
export async function testSyncSource(instanceId: string): Promise<TestSyncSourceResult> {
  const instance = await prisma.dbInstance.findFirst({
    where: { id: instanceId, deletedAt: null },
    include: { syncSource: true },
  });
  if (!instance) return { invalid: `Instance ${instanceId} was not found.` };
  if (!instance.syncSource) {
    return { invalid: "No sync source is configured for this instance." };
  }
  if (instance.status !== "running") {
    return {
      invalid:
        `The instance must be running to test its source ` +
        `(this instance is '${instance.status}').`,
    };
  }

  const stored = instance.syncSource;
  const connInfo = buildConnInfo({
    host: stored.pgHost,
    port: stored.pgPort,
    database: stored.pgDatabase,
    user: stored.pgUser,
    sslMode: stored.pgSslMode,
  });
  const srcEnv = pgPasswordEnv(open(stored.pgPasswordEnc));
  const compose = `docker compose -p ${instance.composeProjectName}`;

  const release = tryAcquireServerLock(instance.serverId, "sync-test");
  if (!release) return { busy: serverLockHolder(instance.serverId) ?? "another job" };

  try {
    return await withConnection(instance.serverId, async (conn: SshConnection) => {
      const res = await exec(
        conn,
        `${compose} exec -T ${srcEnv} db psql ${shellQuote(connInfo)} -At -c ` +
          shellQuote("select current_database() || ' · ' || version()"),
        { timeoutMs: CONNECT_TIMEOUT_MS },
      );
      if (res.code !== 0) {
        return { ok: false as const, detail: res.stderr.trim() || `psql exited ${res.code}` };
      }
      return { ok: true as const, detail: res.stdout.trim().split("\n")[0] ?? "connected" };
    });
  } finally {
    release();
  }
}

interface SyncRow {
  id: string;
  serverId: string;
  composeProjectName: string;
  remotePath: string;
  apiSubdomain: string;
  pgPassword: string;
  serviceRoleKey: string | null;
}

/** `TRUNCATE … CASCADE`, skipping tables this instance doesn't have. */
function truncateExistingSql(tables: readonly string[]): string {
  const list = tables.map((t) => `'${t}'`).join(", ");
  return (
    `DO $$ DECLARE t text; BEGIN ` +
    `FOREACH t IN ARRAY ARRAY[${list}] LOOP ` +
    `IF to_regclass(t) IS NOT NULL THEN EXECUTE format('TRUNCATE TABLE %s CASCADE', t); END IF; ` +
    `END LOOP; END $$;`
  );
}

/**
 * Which of `candidates` actually exist on the SOURCE. pg_dump errors outright
 * when none of its `--table` patterns match, and GoTrue/storage-api table sets
 * differ across versions, so the pattern list is built from reality.
 */
async function existingSourceTables(
  conn: SshConnection,
  ctx: { compose: string; srcEnv: string; connInfo: string },
  candidates: readonly string[],
): Promise<string[]> {
  const res = await exec(
    conn,
    `${ctx.compose} exec -T ${ctx.srcEnv} db psql ${shellQuote(ctx.connInfo)} -At -c ` +
      shellQuote(
        "select schemaname || '.' || tablename from pg_tables " +
          "where schemaname in ('auth','storage')",
      ),
    { timeoutMs: CONNECT_TIMEOUT_MS },
  );
  if (res.code !== 0) {
    throw new Error(`could not list source tables (code ${res.code}): ${res.stderr.trim()}`);
  }
  const present = new Set(
    res.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean),
  );
  return candidates.filter((t) => present.has(t));
}

/** Stream a remote command's stdout into the job log, line by line. */
function lineStreamer(emit: EmitFn): (chunk: string) => void {
  let buffer = "";
  return (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) emit("info", trimmed);
    }
  };
}

async function runSync(
  row: SyncRow,
  source: SyncSource,
  ctx: ProvisionCtx,
  jobId: string,
  release: () => void,
): Promise<void> {
  const tail = new LogTail();
  const emit = makeEmitter(jobId, tail);
  const phaseOpts = { instanceId: row.id, emit, tail };
  const compose = `docker compose -p ${row.composeProjectName}`;
  const ts = Date.now();
  const target = { compose, pgEnv: pgPasswordEnv(row.pgPassword) };
  const srcEnv = pgPasswordEnv(source.password);
  const connInfo = buildConnInfo(source);
  const probeCtx = { compose, srcEnv, connInfo };

  // Container-local scratch paths — dump and restore both run in the same
  // container, so these never need to touch the host at all.
  const mainDump = `/tmp/wharf-sync-${ts}-main.dump`;
  const authDump = `/tmp/wharf-sync-${ts}-auth.dump`;
  const storageDump = `/tmp/wharf-sync-${ts}-storage.dump`;
  const snapshotContainerPath = `/tmp/wharf-snapshot-${ts}.backup`;

  let snapshotPath = "";
  let authTables: string[] = [];
  let storageTables: string[] = [];
  let summary = "";

  try {
    const safeDir = assertSafeRemotePath(row.remotePath, row.composeProjectName, "SYNC INTO");
    const snapshotRemotePath = `${safeDir}/backups/pre-sync-${ts}.backup`;
    const scriptPath = `${safeDir}/restore/sync-storage-${ts}.sh`;
    const manifestPath = `${safeDir}/restore/sync-manifest-${ts}.tsv`;
    const envPath = `${safeDir}/restore/sync-env-${ts}.sh`;

    await withConnection(row.serverId, async (conn: SshConnection) => {
      // ── connect: prove the source is reachable before touching anything ──
      await runPhase(phaseOpts, "connect", async () => {
        emit("info", `source: ${describeSource(source)}`);
        const res = await exec(
          conn,
          `${compose} exec -T ${srcEnv} db psql ${shellQuote(connInfo)} -At -c ` +
            shellQuote("select current_database() || ' · ' || version()"),
          { timeoutMs: CONNECT_TIMEOUT_MS },
        );
        if (res.code !== 0) {
          throw new Error(
            `could not connect to the source database (code ${res.code}): ` +
              (res.stderr.trim() || "no error output"),
          );
        }
        emit("info", `connected — ${res.stdout.trim().split("\n")[0] ?? ""}`);
      });

      // ── dump: up to three pg_dump passes against the live source ─────────
      await runPhase(phaseOpts, "dump", async () => {
        const schemas = ["public", ...source.extraSchemas];
        const schemaFlags = schemas.map((s) => `--schema=${shellQuote(s)}`).join(" ");
        const mainRes = await exec(
          conn,
          `${compose} exec -T ${srcEnv} db pg_dump -Fc --no-owner --no-acl ` +
            `--no-publications --no-subscriptions ${schemaFlags} ` +
            `-f ${mainDump} -d ${shellQuote(connInfo)}`,
          { timeoutMs: DUMP_TIMEOUT_MS },
        );
        if (mainRes.code !== 0) {
          throw new Error(
            `pg_dump of ${schemas.join(", ")} failed (code ${mainRes.code}): ` +
              mainRes.stderr.trim(),
          );
        }
        emit("info", `dumped schema + data for ${schemas.join(", ")}`);

        if (source.includeAuthUsers) {
          authTables = await existingSourceTables(conn, probeCtx, AUTH_TABLES);
          if (authTables.length === 0) {
            emit("info", "source has no auth tables — skipping the identity pass");
          } else {
            const flags = authTables.map((t) => `--table=${shellQuote(t)}`).join(" ");
            const res = await exec(
              conn,
              `${compose} exec -T ${srcEnv} db pg_dump -Fc --data-only --no-owner --no-acl ` +
                `${flags} -f ${authDump} -d ${shellQuote(connInfo)}`,
              { timeoutMs: DUMP_TIMEOUT_MS },
            );
            if (res.code !== 0) {
              throw new Error(
                `pg_dump of the identity tables failed (code ${res.code}): ${res.stderr.trim()}`,
              );
            }
            emit("info", `dumped identity data (${authTables.join(", ")})`);
          }
        }

        if (source.includeStorageObjects) {
          storageTables = await existingSourceTables(conn, probeCtx, STORAGE_TABLES);
          if (storageTables.length === 0) {
            emit("info", "source has no storage tables — skipping the storage pass");
          } else {
            const flags = storageTables.map((t) => `--table=${shellQuote(t)}`).join(" ");
            const res = await exec(
              conn,
              `${compose} exec -T ${srcEnv} db pg_dump -Fc --data-only --no-owner --no-acl ` +
                `${flags} -f ${storageDump} -d ${shellQuote(connInfo)}`,
              { timeoutMs: DUMP_TIMEOUT_MS },
            );
            if (res.code !== 0) {
              throw new Error(
                `pg_dump of the storage tables failed (code ${res.code}): ${res.stderr.trim()}`,
              );
            }
            emit("info", `dumped storage metadata (${storageTables.join(", ")})`);
          }
        }
      });

      // ── snapshot: pg_dump the CURRENT data before it's overwritten ───────
      await runPhase(phaseOpts, "snapshot", async () => {
        snapshotPath = await takeSafetySnapshot(
          conn,
          target,
          { containerPath: snapshotContainerPath, remotePath: snapshotRemotePath },
          emit,
        );
      });

      // ── restore: identity → storage metadata → main (see the module doc) ─
      await runPhase(phaseOpts, "restore", async () => {
        if (authTables.length > 0) {
          await truncateThenLoad(conn, target, authTables, authDump, "identity data", emit);
        }
        if (storageTables.length > 0) {
          await truncateThenLoad(
            conn,
            target,
            storageTables,
            storageDump,
            "storage metadata",
            emit,
          );
        }
        await loadDumpIntoTarget(
          conn,
          target,
          { containerPath: mainDump, snapshotPath, label: "schema + data" },
          emit,
        );
      });

      // ── storage: copy the actual objects source → instance ──────────────
      await runPhase(phaseOpts, "storage", async () => {
        if (!source.includeStorageObjects) {
          emit("info", "storage object copying is off for this source — skipped");
          return;
        }
        if (storageTables.length === 0) {
          emit("info", "no storage metadata was copied — nothing to fetch");
          return;
        }
        summary = await copyStorageObjects(
          conn,
          { row, source, target, paths: { scriptPath, manifestPath, envPath } },
          emit,
        );
      });

      // ── cleanup: drop every temp file (the safety snapshot stays) ────────
      await runPhase(phaseOpts, "cleanup", async () => {
        await exec(
          conn,
          `${compose} exec -T db rm -f ${mainDump} ${authDump} ${storageDump}`,
        );
        await exec(
          conn,
          `rm -f ${shellQuote(scriptPath)} ${shellQuote(manifestPath)} ${shellQuote(envPath)}`,
        );
        emit("info", "removed temporary sync files (safety snapshot kept)");
      });
    });

    await prisma.dbInstance.update({ where: { id: row.id }, data: { status: "running" } });
    await recordSyncOutcome(row.id, "ok", summary || "sync completed");
    await audit({
      userId: ctx.userId,
      userEmail: ctx.userEmail,
      action: "instance.sync",
      targetType: "db_instance",
      targetId: row.id,
      metadata: {
        project: row.composeProjectName,
        server: row.serverId,
        // Identity of the source, never its credentials.
        source: describeSource(source),
        includeAuthUsers: source.includeAuthUsers,
        includeStorageObjects: source.includeStorageObjects,
        snapshotPath,
        summary,
      },
    }).catch((auditErr: unknown) => {
      console.error("[sync] failed to write audit row:", auditErr);
    });
    await persistLogTail(row.id, tail);
    endJob(jobId, "ok");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!(err as { phaseReported?: boolean })?.phaseReported) {
      emit("err", message);
    }
    await prisma.dbInstance
      .update({
        where: { id: row.id },
        data: { status: "error", lastActionLog: tail.text() },
      })
      .catch((dbErr: unknown) => {
        console.error(`[sync] failed to mark ${row.id} errored:`, dbErr);
      });
    await recordSyncOutcome(row.id, "error", message);
    await audit({
      userId: ctx.userId,
      userEmail: ctx.userEmail,
      action: "instance.sync.failed",
      targetType: "db_instance",
      targetId: row.id,
      metadata: {
        project: row.composeProjectName,
        source: describeSource(source),
        error: message,
        snapshotPath,
      },
    }).catch((auditErr: unknown) => {
      console.error("[sync] failed to write failure audit row:", auditErr);
    });
    endJob(jobId, "error");
  } finally {
    release();
  }
}

/** Best-effort — the sync's own outcome must not hinge on this bookkeeping. */
async function recordSyncOutcome(
  instanceId: string,
  status: "ok" | "error",
  summary: string,
): Promise<void> {
  await prisma.instanceSyncSource
    .update({
      where: { dbInstanceId: instanceId },
      data: {
        lastSyncedAt: new Date(),
        lastSyncStatus: status,
        lastSyncSummary: summary.slice(0, 2000),
      },
    })
    .catch((err: unknown) => {
      console.error(`[sync] failed to record outcome for ${instanceId}:`, err);
    });
}

/** Clear the target's copies of `tables`, then load the data-only dump. */
async function truncateThenLoad(
  conn: SshConnection,
  target: { compose: string; pgEnv: string },
  tables: readonly string[],
  containerPath: string,
  label: string,
  emit: EmitFn,
): Promise<void> {
  const truncate = await exec(
    conn,
    `${target.compose} exec -T ${target.pgEnv} db psql -U postgres -d postgres -v ON_ERROR_STOP=1 ` +
      `-c ${shellQuote(truncateExistingSql(tables))}`,
    { timeoutMs: CONNECT_TIMEOUT_MS },
  );
  if (truncate.code !== 0) {
    throw new Error(
      `clearing ${label} on the target failed (code ${truncate.code}): ${truncate.stderr.trim()}`,
    );
  }
  await loadDumpIntoTarget(
    conn,
    target,
    {
      containerPath,
      // --clean is invalid with --data-only; the TRUNCATE above is the
      // equivalent step. --disable-triggers keeps FK order from mattering.
      flags: ["--data-only", "--no-owner", "--no-acl", "--disable-triggers"],
      label,
    },
    emit,
  );
  emit("info", `loaded ${label} (${tables.join(", ")})`);
}

/**
 * Copy every storage object listed in the just-restored metadata from the
 * source project into this instance, via both ends' Storage HTTP API.
 *
 * Deliberately NOT written straight into the instance's `volumes/storage`
 * directory: storage-api owns that layout and changes it between versions,
 * whereas the HTTP API is stable and makes storage-api itself reconcile the
 * object row with the bytes on disk.
 */
async function copyStorageObjects(
  conn: SshConnection,
  args: {
    row: SyncRow;
    source: SyncSource;
    target: { compose: string; pgEnv: string };
    paths: { scriptPath: string; manifestPath: string; envPath: string };
  },
  emit: EmitFn,
): Promise<string> {
  const { row, source, target, paths } = args;

  const curlCheck = await exec(conn, "command -v curl >/dev/null 2>&1");
  if (curlCheck.code !== 0) {
    throw new Error(
      "curl is not installed on this server — it is required to copy storage objects. " +
        "Install it, or turn storage copying off for this source.",
    );
  }

  // The list comes from the TARGET, whose metadata this sync just replaced —
  // so it is exactly the set of objects the instance now expects to have.
  const listSql =
    `select b.name || E'\\t' || o.name || E'\\t' || ` +
    `coalesce(o.metadata->>'mimetype', 'application/octet-stream') ` +
    `from storage.objects o join storage.buckets b on b.id = o.bucket_id ` +
    `where o.name is not null order by 1, 2 limit ${MAX_SYNC_OBJECTS + 1}`;
  const listRes = await exec(
    conn,
    `${target.compose} exec -T ${target.pgEnv} db psql -U postgres -d postgres -At -c ` +
      shellQuote(listSql),
    { timeoutMs: CONNECT_TIMEOUT_MS },
  );
  if (listRes.code !== 0) {
    throw new Error(
      `could not list storage objects (code ${listRes.code}): ${listRes.stderr.trim()}`,
    );
  }

  const { entries, skipped } = parseObjectList(listRes.stdout);
  if (skipped > 0) {
    emit(
      "info",
      `${skipped} object(s) skipped — their names contain a tab or newline, which cannot ` +
        "be carried through the copy manifest. Move those objects by hand.",
    );
  }
  if (entries.length === 0) {
    emit("info", "no storage objects to copy");
    return "0 storage objects";
  }
  const capped = entries.slice(0, MAX_SYNC_OBJECTS);
  if (entries.length > MAX_SYNC_OBJECTS) {
    emit(
      "info",
      `source has more than ${MAX_SYNC_OBJECTS} objects — copying the first ` +
        `${MAX_SYNC_OBJECTS}. Re-run the sync or move the rest by hand.`,
    );
  }

  const manifest = capped
    .map(
      (e) =>
        `${encodeURIComponent(e.bucket)}\t${encodeObjectPath(e.path)}\t` +
        e.contentType.replace(/[\t\r\n]/g, " "),
    )
    .join("\n");

  const dstUrl = `https://${row.apiSubdomain}`;
  const srcUrl = (source.projectUrl ?? "").replace(/\/+$/, "");
  // Mode 0600 and sourced (not argv) so the two bearer tokens never appear in
  // the host's process list. Removed in `finally` below, and again in cleanup.
  const envFile =
    `SRC_URL='${srcUrl}'\n` +
    `DST_URL='${dstUrl}'\n` +
    `SRC_TOKEN='${source.serviceRoleKey ?? ""}'\n` +
    `DST_TOKEN='${row.serviceRoleKey ?? ""}'\n` +
    `MANIFEST='${paths.manifestPath}'\n` +
    `TOTAL=${capped.length}\n`;

  try {
    await sftpWrite(conn, paths.manifestPath, manifest, 0o600);
    await sftpWrite(conn, paths.scriptPath, renderStorageScript(), 0o700);
    await sftpWrite(conn, paths.envPath, envFile, 0o600);

    emit("info", `copying ${capped.length} storage object(s) from ${srcUrl}`);
    const res = await exec(
      conn,
      `sh ${shellQuote(paths.scriptPath)} ${shellQuote(paths.envPath)}`,
      { timeoutMs: STORAGE_TIMEOUT_MS, onStdout: lineStreamer(emit) },
    );
    if (res.code !== 0) {
      throw new Error(
        `the storage copy script exited with code ${res.code}: ` +
          (res.stderr.trim() || "no error output"),
      );
    }
    const done = res.stdout.split("\n").find((l) => l.startsWith("DONE ")) ?? "";
    const failed = /failed=(\d+)/.exec(done)?.[1] ?? "?";
    const copied = /ok=(\d+)/.exec(done)?.[1] ?? "?";
    if (failed !== "0") {
      emit(
        "info",
        `${failed} object(s) could not be copied — see the FAIL lines above. The rest of ` +
          "the sync is unaffected; re-running the sync retries them.",
      );
    }
    return `${copied} of ${capped.length} storage objects copied (${failed} failed)`;
  } finally {
    // The env file holds both service_role keys — never leave it behind, even
    // if the copy threw before `cleanup` could run.
    await exec(conn, `rm -f ${shellQuote(paths.envPath)}`).catch(() => {});
  }
}
