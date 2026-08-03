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
import { isReservedSchema } from "@/lib/instances/sync-source-schema";
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
  countTables,
  emitCapturedOutput,
  listTables,
  loadDumpIntoTarget,
  parseTableList,
  pgPasswordEnv,
  reassertInstanceRoles,
  reassertSchemaPrivileges,
  resolveAdminUser,
  shellQuote,
  sqlIdent,
  sqlLiteral,
  TABLE_LIST_SQL,
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

/**
 * Turn a failed `open()` into something an operator can act on.
 *
 * Decryption fails for exactly one class of reason — the value was sealed
 * under a different WHARF_MASTER_KEY than the one this process holds (a
 * rotation that missed this row, a restored backup paired with the wrong
 * key, or the env var pointing somewhere new). That is an operational
 * condition, not a bug, and surfacing it as an opaque 500 sends the operator
 * hunting through logs for a one-line answer. The underlying message is
 * included but never the value.
 */
function describeDecryptFailure(err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  return (
    "The stored credentials for this sync source could not be decrypted " +
    `(${detail}). They were sealed with a different WHARF_MASTER_KEY than this ` +
    "panel is using — re-enter the source password (and service_role key, if set) " +
    "and save it again."
  );
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

  // Decrypt EVERY secret before the lock is taken and the row is flipped to
  // `restoring`: a throw after that point would leak the lock and strand the
  // instance mid-status with no job behind it. A failure here is also a real
  // operational condition (a rotated or mismatched WHARF_MASTER_KEY), not a
  // crash, so it comes back as a message the operator can act on.
  let source: SyncSource;
  let targetPgPassword: string;
  let targetServiceRoleKey: string | null;
  try {
    source = {
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
    targetPgPassword = open(instance.pgPasswordEnc);
    targetServiceRoleKey = instance.serviceRoleKeyEnc
      ? open(instance.serviceRoleKeyEnc)
      : null;
  } catch (err) {
    return { invalid: describeDecryptFailure(err) };
  }

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
      pgPassword: targetPgPassword,
      serviceRoleKey: targetServiceRoleKey,
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
  // Decrypting can fail (see describeDecryptFailure) — for a probe that is an
  // answer, not a crash.
  let srcEnv: string;
  try {
    srcEnv = pgPasswordEnv(open(stored.pgPasswordEnc));
  } catch (err) {
    return { ok: false, detail: describeDecryptFailure(err) };
  }
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
  } catch (err) {
    // A probe whose whole job is reporting connectivity problems must not
    // turn one into a 500. Everything up to and including the SSH hop can
    // fail here — unreachable managed server, changed host key, missing
    // credentials, timeout — and each is a legitimate answer of "no", with
    // the reason the operator needs to fix it.
    return { ok: false as const, detail: err instanceof Error ? err.message : String(err) };
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

/**
 * Install the SOURCE's extensions on the TARGET, before any dump is loaded.
 *
 * `pg_dump --schema=...` (which every pass here uses) does NOT emit
 * `CREATE EXTENSION`: extensions are database-level objects living outside the
 * dumped schema. A source using pgvector/PostGIS/pg_trgm therefore produces a
 * dump full of columns and functions typed `extensions.vector` with nothing
 * to define that type, and pg_restore fails every object that references it
 * while everything else restores perfectly.
 *
 * That asymmetry is what makes the bug so hard to see from the outside: the
 * field report this fixes had `shlokas`, `knowledge_chunks` and
 * `verse_commentary_chunks` missing out of 59 tables — precisely the three
 * carrying an embedding column — with the sync reporting success.
 *
 * The extension must land in the SAME schema as on the source. That is not
 * cosmetic: the dump spells the type `<schema>.vector`, so a copy installed
 * anywhere else does not satisfy it.
 *
 * Best-effort per extension — one this image cannot provide is named and
 * skipped rather than failing the whole sync, since the rest of the data is
 * still worth having and the operator needs to know which one was missing.
 */
async function replicateSourceExtensions(
  conn: SshConnection,
  ctx: { compose: string; srcEnv: string; connInfo: string },
  target: { compose: string; pgEnv: string; user: string },
  emit: EmitFn,
): Promise<void> {
  const srcRes = await exec(
    conn,
    `${ctx.compose} exec -T ${ctx.srcEnv} db psql ${shellQuote(ctx.connInfo)} -At -c ` +
      shellQuote(
        "select e.extname || E'\\t' || n.nspname from pg_extension e " +
          "join pg_namespace n on n.oid = e.extnamespace order by 1",
      ),
    { timeoutMs: CONNECT_TIMEOUT_MS },
  );
  if (srcRes.code !== 0) {
    emit(
      "info",
      `could not list the source's extensions (code ${srcRes.code}): ${srcRes.stderr.trim()} — ` +
        "continuing, but any table using an extension type may fail to restore.",
    );
    return;
  }
  const wanted = srcRes.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.split("\t"))
    .filter((p): p is [string, string] => p.length === 2 && !!p[0] && !!p[1]);
  if (wanted.length === 0) return;

  const [installedRes, availableRes] = await Promise.all([
    exec(
      conn,
      `${target.compose} exec -T db psql -U ${target.user} -d postgres -At -c ` +
        shellQuote("select extname from pg_extension"),
    ),
    exec(
      conn,
      `${target.compose} exec -T db psql -U ${target.user} -d postgres -At -c ` +
        shellQuote("select name from pg_available_extensions"),
    ),
  ]);
  if (installedRes.code !== 0 || availableRes.code !== 0) {
    emit("info", "could not inspect this instance's extensions — skipping extension sync");
    return;
  }
  const installed = new Set(parseTableList(installedRes.stdout));
  const available = new Set(parseTableList(availableRes.stdout));

  const missing = wanted.filter(([name]) => !installed.has(name));
  if (missing.length === 0) {
    emit("info", "every extension the source uses is already installed here");
    return;
  }
  const unavailable = missing.filter(([name]) => !available.has(name));
  const creatable = missing.filter(([name]) => available.has(name));
  if (unavailable.length > 0) {
    emit(
      "err",
      `this Postgres image does not provide ${unavailable.map(([n]) => n).join(", ")} — ` +
        "any table, column or function in the source that depends on them CANNOT be " +
        "restored. The rest of the sync continues.",
    );
  }
  if (creatable.length === 0) return;

  // No ON_ERROR_STOP: one extension that refuses must not prevent the others
  // from being created. What actually landed is verified immediately below.
  const sql = creatable
    .map(
      ([name, schema]) =>
        `CREATE SCHEMA IF NOT EXISTS ${sqlIdent(schema)}; ` +
        `CREATE EXTENSION IF NOT EXISTS ${sqlIdent(name)} WITH SCHEMA ${sqlIdent(schema)};`,
    )
    .join("\n");
  const applyRes = await exec(
    conn,
    `${target.compose} exec -T db psql -U ${target.user} -d postgres -c ${shellQuote(sql)}`,
    { timeoutMs: CONNECT_TIMEOUT_MS },
  );
  if (applyRes.code !== 0) emitCapturedOutput(emit, applyRes.stderr);

  const verifyRes = await exec(
    conn,
    `${target.compose} exec -T db psql -U ${target.user} -d postgres -At -c ` +
      shellQuote("select extname from pg_extension"),
  );
  const nowInstalled =
    verifyRes.code === 0 ? new Set(parseTableList(verifyRes.stdout)) : installed;
  const created = creatable.filter(([name]) => nowInstalled.has(name));
  const failed = creatable.filter(([name]) => !nowInstalled.has(name));
  if (created.length > 0) {
    emit(
      "info",
      `installed ${created.map(([n, s]) => `${n} (schema ${s})`).join(", ")} to match the source`,
    );
  }
  if (failed.length > 0) {
    emit(
      "err",
      `could not install ${failed.map(([n]) => n).join(", ")} — objects depending on them ` +
        "will not restore. See the psql output above.",
    );
  }
}

/** The `schema.table` names the SOURCE holds in `schemas` — the yardstick for a complete sync. */
async function listSourceTables(
  conn: SshConnection,
  ctx: { compose: string; srcEnv: string; connInfo: string },
  schemas: readonly string[],
  emit: EmitFn,
): Promise<string[] | null> {
  const list = schemas.map(sqlLiteral).join(", ");
  const res = await exec(
    conn,
    `${ctx.compose} exec -T ${ctx.srcEnv} db psql ${shellQuote(ctx.connInfo)} -At -c ` +
      shellQuote(TABLE_LIST_SQL(list)),
    { timeoutMs: CONNECT_TIMEOUT_MS },
  );
  if (res.code !== 0) {
    emit("info", `could not list the source's tables to verify the sync: ${res.stderr.trim()}`);
    return null;
  }
  return parseTableList(res.stdout);
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
  // `user` is filled in during `connect`, once the container can be probed —
  // `postgres` is not a superuser here and cannot restore into `public`.
  const target = { compose, pgEnv: pgPasswordEnv(row.pgPassword), user: "postgres" };
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
  /**
   * Whether anything has been written to the instance's DATABASE yet.
   *
   * `connect`, `dump` and `snapshot` only read the source and write scratch
   * files; the instance's own data is untouched until the `restore` phase
   * starts. Failing before that point must NOT strand a perfectly healthy
   * instance in `error` — that status is terminal until an explicit retry or
   * remove, so it would make the operator repair something that was never
   * broken.
   */
  let dataTouched = false;
  /**
   * Set once the `restore` phase finishes cleanly. A failure AFTER that point
   * (copying storage files, cleanup) leaves the database correct — only the
   * object files are incomplete — so the instance is healthy and must not be
   * dropped into the terminal `error` status as though its data were mangled.
   */
  let restoreCompleted = false;
  /** Schemas the main pass was asked to load — verified afterwards. */
  let restoredSchemas: string[] = ["public"];
  /**
   * Tables the SOURCE has that did NOT arrive. Non-empty means a partial
   * restore: the data that landed is real and usable, but objects are
   * missing, so the job must report failure even though the instance stays
   * healthy enough to sync again once the cause is fixed.
   */
  let missingTables: string[] = [];

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

        target.user = await resolveAdminUser(conn, compose);
        emit("info", `this instance's restore operations will run as '${target.user}'`);
      });

      // ── dump: up to three pg_dump passes against the live source ─────────
      await runPhase(phaseOpts, "dump", async () => {
        // A source saved before the reserved-schema rule existed can still
        // name one, and copying it would drop a schema this instance's own
        // containers/extensions own. Drop them loudly rather than trusting
        // the row came through the API schema.
        const reserved = source.extraSchemas.filter(isReservedSchema);
        if (reserved.length > 0) {
          emit(
            "info",
            `ignoring reserved schema(s) ${reserved.join(", ")} — this instance owns them, ` +
              "copying them would break its own containers. Remove them from the sync source.",
          );
        }
        const schemas = [
          "public",
          ...source.extraSchemas.filter((s) => !isReservedSchema(s)),
        ];
        restoredSchemas = schemas;
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
        // Before anything is written: the dump can reference types this
        // instance does not have yet, and every object using one would fail.
        // Additive and safe, so it runs while the data is still untouched.
        await replicateSourceExtensions(conn, probeCtx, target, emit);

        dataTouched = true;
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
        const main = await loadDumpIntoTarget(
          conn,
          target,
          { containerPath: mainDump, snapshotPath, label: "schema + data" },
          emit,
        );

        // A non-zero pg_restore exit is normally just cross-environment
        // ownership noise, so it is tolerated — but that same tolerance would
        // hide a restore that created NOTHING (which is what happens when the
        // connecting role cannot write to `public`). Errors plus an empty
        // result is not noise, it is a failed restore, and saying so here is
        // the difference between a visible failure and an empty database that
        // looks successful.
        const tables = await countTables(conn, target, restoredSchemas, emit);
        if (tables >= 0) {
          emit("info", `${tables} table(s) now in ${restoredSchemas.join(", ")}`);
        }
        if (main.code !== 0 && tables === 0) {
          throw new Error(
            `pg_restore reported errors and no tables exist in ${restoredSchemas.join(", ")} — ` +
              "nothing was restored. Review the pg_restore output above; the most common " +
              `cause is the connecting role ('${target.user}') lacking rights on those ` +
              `schemas. This instance's previous data is in ${snapshotPath}.`,
          );
        }

        // "Some tables landed" is NOT the same as "the sync is complete".
        // A dump referencing a type the target lacks fails only the objects
        // that use it, so a handful of tables can go missing while dozens
        // restore perfectly — which used to be reported as success. Having
        // the live source in hand, the only honest check is to diff it
        // against what actually arrived.
        if (main.failedStatements > 0) {
          const [sourceTables, targetTables] = await Promise.all([
            listSourceTables(conn, probeCtx, restoredSchemas, emit),
            listTables(conn, target, restoredSchemas, emit),
          ]);
          if (sourceTables && targetTables) {
            const arrived = new Set(targetTables);
            missingTables = sourceTables.filter((t) => !arrived.has(t));
          }
        }
        // The data now comes from another cluster, whose roles had different
        // credentials. Put this instance's own back, or its containers
        // (Studio/postgres-meta, PostgREST, GoTrue, storage-api) can no
        // longer authenticate against their own database.
        await reassertInstanceRoles(
          conn,
          target,
          {
            remotePath: `${safeDir}/restore/roles-${ts}.sql`,
            containerPath: `/tmp/wharf-roles-${ts}.sql`,
          },
          emit,
        );

        // The source's own owner/grants came with it too (--no-owner made
        // `target.user` the owner of everything it just (re)created) — put
        // this instance's normal postgres-owned, PostgREST-usable state back.
        await reassertSchemaPrivileges(
          conn,
          target,
          restoredSchemas,
          {
            remotePath: `${safeDir}/restore/privileges-${ts}.sql`,
            containerPath: `/tmp/wharf-privileges-${ts}.sql`,
          },
          emit,
        );
        restoreCompleted = true;
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

    // The instance is left RUNNING either way: whatever did arrive is real,
    // and `error` is terminal — startSync refuses anything but a running
    // instance, so failing the row here would lock the operator out of the
    // very re-sync that fixes the problem. The JOB is what reports failure.
    await prisma.dbInstance.update({ where: { id: row.id }, data: { status: "running" } });

    if (missingTables.length > 0) {
      const shown = missingTables.slice(0, 20).join(", ");
      const more =
        missingTables.length > 20 ? ` (+${missingTables.length - 20} more)` : "";
      emit(
        "err",
        `${missingTables.length} table(s) in the source did not arrive: ${shown}${more}`,
      );
      emit(
        "info",
        "the data that DID restore is intact and this instance stays running, so you can " +
          "fix the cause and sync again. The usual cause is an extension the source has " +
          "and this image does not (see the errors above) — every object using its types " +
          `fails while the rest restore normally. Previous data: ${snapshotPath}.`,
      );
      const partialSummary =
        `partial sync — ${missingTables.length} table(s) missing: ${shown}${more}`;
      await recordSyncOutcome(row.id, "error", partialSummary);
      await audit({
        userId: ctx.userId,
        userEmail: ctx.userEmail,
        action: "instance.sync.failed",
        targetType: "db_instance",
        targetId: row.id,
        metadata: {
          project: row.composeProjectName,
          server: row.serverId,
          source: describeSource(source),
          error: partialSummary,
          missingTables,
          snapshotPath,
        },
      }).catch((auditErr: unknown) => {
        console.error("[sync] failed to write partial-sync audit row:", auditErr);
      });
      await persistLogTail(row.id, tail);
      endJob(jobId, "error");
      return;
    }

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
    const halfReplaced = dataTouched && !restoreCompleted;
    emit(
      "info",
      halfReplaced
        ? `this instance's data was being replaced when the sync failed — it is left in ` +
            `'error' for inspection. The pre-sync snapshot at ${snapshotPath} is the way back.`
        : restoreCompleted
          ? "the database restored correctly — only the step after it failed, so this " +
            "instance stays running. Anything that step was responsible for (storage " +
            "object files) may be missing or incomplete; re-run the sync to finish it."
          : "the sync failed before anything was written to this instance — its data is " +
            "untouched and it stays running. Fix the problem above and sync again.",
    );
    await prisma.dbInstance
      .update({
        where: { id: row.id },
        data: {
          status: halfReplaced ? "error" : "running",
          lastActionLog: tail.text(),
        },
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
  target: { compose: string; pgEnv: string; user: string },
  tables: readonly string[],
  containerPath: string,
  label: string,
  emit: EmitFn,
): Promise<void> {
  const truncate = await exec(
    conn,
    `${target.compose} exec -T ${target.pgEnv} db psql -U ${target.user} -d postgres ` +
      `-v ON_ERROR_STOP=1 -c ${shellQuote(truncateExistingSql(tables))}`,
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
    target: { compose: string; pgEnv: string; user: string };
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
  // One concatenated column, so ORDER BY must name the expressions — an
  // `order by 1, 2` here is a position that does not exist.
  const listSql =
    `select b.name || E'\\t' || o.name || E'\\t' || ` +
    `coalesce(o.metadata->>'mimetype', 'application/octet-stream') ` +
    `from storage.objects o join storage.buckets b on b.id = o.bucket_id ` +
    `where o.name is not null and b.name is not null ` +
    `order by b.name, o.name limit ${MAX_SYNC_OBJECTS + 1}`;
  const listRes = await exec(
    conn,
    `${target.compose} exec -T ${target.pgEnv} db psql -U ${target.user} -d postgres -At -c ` +
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
