/**
 * Clone a managed database into another managed instance. Archives include all
 * application schemas, auth and storage metadata; runtime schemas and cluster
 * roles belong to the destination. Uploaded storage files are a separate store.
 *
 * Restore into a fresh database first: --clean alone leaves destination-only
 * objects behind. Strict restoration and an atomic name swap prevent a partial
 * restore from becoming the serving database. Keep the previous database until
 * destination services pass their health checks, then retain the safety dump.
 */
import { randomUUID } from "node:crypto";
import type { DbInstance } from "@prisma/client";
import { audit } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { serverLockHolder, tryAcquireServerLock } from "@/lib/jobs/lock";
import { endJob, startJob } from "@/lib/jobs/stream";
import { exec, sftpCopyFile, sftpWrite, withConnection } from "@/lib/ssh";
import { cloneJobId } from "./job-ids";
import { LogTail, makeEmitter, persistLogTail, runPhase, type ProvisionCtx } from "./pipeline";
import { shellQuote, sqlIdent, sqlLiteral } from "./restore-core";
import { assertSafeRemotePath } from "./teardown";
import { CLONE_RESTORE_FLAGS, renderCreateStageSql, renderPreserveDatabaseSettingsSql, renderRollbackSql, renderSwapSql } from "./clone-sql";

type Connection = Parameters<typeof exec>[0];
type CloneRow = Pick<DbInstance, "id" | "name" | "serverId" | "remotePath" | "composeProjectName">;
export type StartCloneResult = { jobId: string } | { invalid: string } | { busy: string };
export const CLONE_RUNTIME_SCHEMAS = ["_realtime", "_analytics", "_supavisor", "pgbouncer"] as const;
const LONG_TIMEOUT = 60 * 60_000;
const SERVICES_TIMEOUT = 5 * 60_000;

/** Acquire unique server IDs in deterministic order, releasing on contention. */
export function acquireCloneLocks(serverIds: string[]): { release: () => void } | { busy: string } {
  const releases: Array<() => void> = [];
  for (const id of [...new Set(serverIds)].sort()) {
    const release = tryAcquireServerLock(id, "clone");
    if (!release) {
      releases.reverse().forEach((unlock) => unlock());
      return { busy: serverLockHolder(id) ?? "another job" };
    }
    releases.push(release);
  }
  return { release: () => releases.reverse().forEach((unlock) => unlock()) };
}

export async function startClone(sourceInstanceId: string, targetInstanceId: string, ctx: ProvisionCtx, confirmName: string): Promise<StartCloneResult> {
  if (sourceInstanceId === targetInstanceId) return { invalid: "Choose a different destination database." };
  const find = (id: string) => prisma.dbInstance.findFirst({ where: { id, deletedAt: null } });
  const [source, target] = await Promise.all([find(sourceInstanceId), find(targetInstanceId)]);
  if (!source || !target) return { invalid: "The source or destination database was not found." };
  if (target.name !== confirmName) return { invalid: "Confirmation does not match the destination database name." };
  if (source.status !== "running" || target.status !== "running") return { invalid: "Both source and destination databases must be running." };
  if (!source.pgPasswordEnc || !target.pgPasswordEnc) return { invalid: "Both databases must have finished provisioning." };
  try {
    assertSafeRemotePath(source.remotePath, source.composeProjectName, "CLONE FROM");
    assertSafeRemotePath(target.remotePath, target.composeProjectName, "CLONE INTO");
  } catch {
    return { invalid: "A database has an invalid managed directory. Repair its configuration before cloning." };
  }
  if (source.serverId === target.serverId && source.composeProjectName === target.composeProjectName) return { invalid: "The source and destination resolve to the same database." };
  const lock = acquireCloneLocks([source.serverId, target.serverId]);
  if ("busy" in lock) return lock;
  const jobId = cloneJobId(target.id);
  try {
    // Reads before the lock can race a lifecycle job. Validate again under it.
    const [freshSource, freshTarget] = await Promise.all([find(source.id), find(target.id)]);
    if (!freshSource || !freshTarget || freshSource.status !== "running" || freshTarget.status !== "running" || freshTarget.name !== confirmName) {
      lock.release();
      return { invalid: "A database changed while the clone was starting. Refresh and try again." };
    }
    await prisma.dbInstance.update({ where: { id: target.id }, data: { status: "restoring" } });
    startJob(jobId);
  } catch (error) {
    lock.release();
    throw error;
  }
  void runClone(source, target, ctx, jobId, lock.release);
  return { jobId };
}

function compose(row: CloneRow): string {
  return `docker compose --project-directory ${shellQuote(row.remotePath)} -p ${shellQuote(row.composeProjectName)}`;
}

/** Do not forward PostgreSQL diagnostics: they may echo private row values. */
async function checked(conn: Connection, command: string, label: string, timeoutMs = LONG_TIMEOUT): Promise<string> {
  let result;
  try { result = await exec(conn, command, { timeoutMs }); }
  catch { throw new Error(`${label} failed or timed out. Inspect the managed server for details.`); }
  if (result.code !== 0) throw new Error(`${label} failed (exit ${result.code ?? "unknown"}). No partial restore is accepted.`);
  return result.stdout.trim();
}

function psql(project: string, database: string, sql: string): string {
  return `${project} exec -T db psql -X -U supabase_admin -d ${shellQuote(database)} -v ON_ERROR_STOP=1 -Atq -c ${shellQuote(sql)}`;
}

/** Refuse source state that cannot safely retain a new instance identity. */
const SOURCE_SAFETY_SQL = `DO $$ DECLARE present boolean; t text; BEGIN
  IF EXISTS (SELECT 1 FROM pg_subscription) THEN RAISE EXCEPTION 'subscriptions'; END IF;
  IF EXISTS (SELECT 1 FROM pg_foreign_server) THEN RAISE EXCEPTION 'foreign servers'; END IF;
  IF to_regclass('cron.job') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM cron.job)' INTO present;
    IF present THEN RAISE EXCEPTION 'scheduled jobs'; END IF;
  END IF;
  FOREACH t IN ARRAY ARRAY['vault.secrets', 'pgsodium.key'] LOOP
    IF to_regclass(t) IS NOT NULL THEN
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM %s)', t) INTO present;
      IF present THEN RAISE EXCEPTION 'instance encryption keys'; END IF;
    END IF;
  END LOOP;
END $$;`;

async function runClone(source: CloneRow, target: CloneRow, ctx: ProvisionCtx, jobId: string, release: () => void): Promise<void> {
  const tail = new LogTail();
  const emit = makeEmitter(jobId, tail);
  const phases = { instanceId: target.id, tail, emit };
  const token = randomUUID().replace(/-/g, "");
  const stage = `wharf_clone_${token}`;
  const previous = `wharf_previous_${token}`;
  const src = compose(source);
  const dst = compose(target);
  const sourceDir = `${source.remotePath}/clone-${token}`;
  const targetDir = `${target.remotePath}/clone-${token}`;
  const containerDir = `/tmp/wharf-clone-${token}`;
  const archive = `${containerDir}/source.dump`;
  const snapshot = `${containerDir}/previous.dump`;
  const runtime = `${containerDir}/runtime.dump`;
  const snapshotPath = `${target.remotePath}/backups/pre-clone-${token}.backup`;
  let services: string[] = [];
  let runtimeSchemas: string[] = [];
  let paused = false;
  let gated = false;
  let swapped = false;
  let activated = false;
  let recovered = true;
  let snapshotSaved = false;
  let sourcePrepared = false;
  let targetPrepared = false;
  let stageCreated = false;
  let failure: string | null = null;

  const sqlFile = async (conn: Connection, name: string, sql: string, database = "template1") => {
    const hostPath = `${targetDir}/${name}.sql`;
    const containerPath = `${containerDir}/${name}.sql`;
    await sftpWrite(conn, hostPath, sql, 0o600);
    await checked(conn, `${dst} cp ${shellQuote(hostPath)} db:${shellQuote(containerPath)}`, `${name} SQL upload`);
    await checked(conn, `${dst} exec -T db psql -X -U supabase_admin -d ${shellQuote(database)} -v ON_ERROR_STOP=1 -q -f ${shellQuote(containerPath)}`, name);
  };
  const restart = async (conn: Connection) => {
    if (!services.length) return;
    await checked(conn, `${dst} up -d --no-deps --wait --wait-timeout 240 ${services.map(shellQuote).join(" ")}`, "Destination service health checks", SERVICES_TIMEOUT);
  };
  const gate = async (conn: Connection, name: string) => {
    await checked(conn, psql(dst, "template1", `ALTER DATABASE ${sqlIdent(name)} ALLOW_CONNECTIONS false;`), "Pause database connections");
    await checked(conn, psql(dst, "template1", `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${sqlLiteral(name)} AND pid <> pg_backend_pid();`), "Drain database connections");
  };
  const recover = async (conn: Connection) => {
    if (swapped && !activated) {
      await checked(conn, `${dst} stop ${services.map(shellQuote).join(" ")}`, "Pause services for rollback", SERVICES_TIMEOUT);
      await gate(conn, "postgres");
      await sqlFile(conn, "rollback", renderRollbackSql(stage, previous));
      swapped = false;
      gated = false;
      emit("info", "Restored the destination's original database after clone activation failed.");
    } else if (gated && !swapped) {
      await checked(conn, psql(dst, "template1", "ALTER DATABASE postgres ALLOW_CONNECTIONS true;"), "Reopen destination connections");
      gated = false;
    }
    if (paused) { await restart(conn); paused = false; }
  };
  const cleanupTarget = async (conn: Connection) => {
    if (!recovered) return; // Keep all evidence when manual recovery is required.
    if (stageCreated && !swapped) await checked(conn, psql(dst, "template1", `DROP DATABASE IF EXISTS ${sqlIdent(stage)} WITH (FORCE);`), "Remove staged database");
    if (activated) await checked(conn, psql(dst, "template1", `DROP DATABASE IF EXISTS ${sqlIdent(previous)} WITH (FORCE);`), "Remove previous database (safety archive retained)");
    if (targetPrepared) {
      await checked(conn, `${dst} exec -T db rm -rf -- ${shellQuote(containerDir)}`, "Remove destination temporary archive");
      await checked(conn, `rm -rf -- ${shellQuote(targetDir)}`, "Remove destination temporary directory");
    }
  };
  const cleanupSource = async (conn: Connection) => {
    if (!sourcePrepared) return;
    await checked(conn, `${src} exec -T db rm -rf -- ${shellQuote(containerDir)}`, "Remove source temporary archive");
    await checked(conn, `rm -rf -- ${shellQuote(sourceDir)}`, "Remove source temporary directory");
  };

  try {
    await withConnection(source.serverId, async (sourceConn) => {
      const work = async (targetConn: Connection) => {
        try {
          await runPhase(phases, "preflight", async () => {
            emit("info", `Cloning ${source.name} into ${target.name}. Destination URLs, credentials and configuration are retained.`);
            emit("info", "Copies database schemas, rows, Auth data and Storage metadata. Uploaded Storage files are not copied.");
            const [sourceImages, targetImages] = await Promise.all([
              checked(sourceConn, `${src} config --images`, "Source container versions"),
              checked(targetConn, `${dst} config --images`, "Destination container versions"),
            ]);
            const signature = (value: string) => value.split(/\s+/).filter(Boolean).sort();
            if (signature(sourceImages).length === 0 || JSON.stringify(signature(sourceImages)) !== JSON.stringify(signature(targetImages))) {
              throw new Error("Source and destination must use matching database stack image versions. Update their stacks before cloning.");
            }
            const [sourceVersion, targetVersion] = await Promise.all([
              checked(sourceConn, psql(src, "postgres", "SHOW server_version_num"), "Source database access"),
              checked(targetConn, psql(dst, "postgres", "SHOW server_version_num"), "Destination database access"),
            ]);
            if (!/^\d+$/.test(sourceVersion) || sourceVersion !== targetVersion || Number(sourceVersion) < 150000) throw new Error("Source and destination require matching PostgreSQL versions (15 or later).");
            try { await checked(sourceConn, psql(src, "postgres", SOURCE_SAFETY_SQL), "Source identity compatibility"); }
            catch { throw new Error("Cannot clone databases with Vault secrets, pgsodium keys, subscriptions, foreign servers or pg_cron. These depend on source credentials or external systems and require a separate migration."); }
            const running = await checked(targetConn, `${dst} ps --status running --services`, "Destination running services");
            const all = running.split(/\s+/).filter(Boolean);
            if (!["db", "auth", "storage", "realtime"].every((service) => all.includes(service)) || all.some((name) => !/^[a-zA-Z0-9_-]+$/.test(name))) throw new Error("The destination database stack must be fully running before cloning.");
            services = all.filter((service) => service !== "db");
            const runtimeList = CLONE_RUNTIME_SCHEMAS.map(sqlLiteral).join(", ");
            const existingRuntime = await checked(
              targetConn,
              psql(dst, "postgres", `SELECT nspname FROM pg_namespace WHERE nspname IN (${runtimeList}) ORDER BY nspname;`),
              "Inspect destination runtime schemas",
            );
            runtimeSchemas = existingRuntime.split(/\s+/).filter((name) =>
              (CLONE_RUNTIME_SCHEMAS as readonly string[]).includes(name),
            );
            sourcePrepared = true;
            await checked(sourceConn, `install -d -m 700 ${shellQuote(sourceDir)}`, "Prepare source archive directory");
            await checked(sourceConn, `${src} exec -T db mkdir -m 700 ${shellQuote(containerDir)}`, "Prepare source container archive directory");
            targetPrepared = true;
            await checked(targetConn, `install -d -m 700 ${shellQuote(targetDir)} ${shellQuote(`${target.remotePath}/backups`)}`, "Prepare destination archive directory");
            await checked(targetConn, `${dst} exec -T db mkdir -m 700 ${shellQuote(containerDir)}`, "Prepare destination container archive directory");
          });
          await runPhase(phases, "dump", async () => {
            const excludes = CLONE_RUNTIME_SCHEMAS.map((schema) => `--exclude-schema=${shellQuote(schema)}`).join(" ");
            await checked(sourceConn, `${src} exec -T db pg_dump -U supabase_admin -d postgres -Fc ${excludes} -f ${shellQuote(archive)}`, "Source database snapshot");
            await checked(sourceConn, `${src} cp db:${shellQuote(archive)} ${shellQuote(`${sourceDir}/source.dump`)}`, "Export source archive");
            emit("info", "Captured a consistent snapshot of the live source database.");
          });
          await runPhase(phases, "transfer", async () => {
            if (source.serverId === target.serverId) await checked(sourceConn, `install -m 600 ${shellQuote(`${sourceDir}/source.dump`)} ${shellQuote(`${targetDir}/source.dump`)}`, "Copy database archive on managed server");
            else await sftpCopyFile(sourceConn, `${sourceDir}/source.dump`, targetConn, `${targetDir}/source.dump`);
            await checked(targetConn, `${dst} cp ${shellQuote(`${targetDir}/source.dump`)} db:${shellQuote(archive)}`, "Import source archive");
            await checked(targetConn, `${dst} exec -T db pg_restore --list ${shellQuote(archive)} > /dev/null`, "Validate transferred archive");
          });
          await runPhase(phases, "snapshot", async () => {
            await checked(targetConn, `${dst} exec -T db pg_dump -U supabase_admin -d postgres -Fc -f ${shellQuote(snapshot)}`, "Destination safety snapshot");
            if (runtimeSchemas.length > 0) {
              const flags = runtimeSchemas.map((schema) => `--schema=${shellQuote(schema)}`).join(" ");
              await checked(
                targetConn,
                `${dst} exec -T db pg_dump -U supabase_admin -d postgres -Fc ${flags} -f ${shellQuote(runtime)}`,
                "Destination runtime schema snapshot",
              );
            }
            await checked(targetConn, `${dst} cp db:${shellQuote(snapshot)} ${shellQuote(snapshotPath)}`, "Retain destination safety snapshot");
            await checked(targetConn, `chmod 600 ${shellQuote(snapshotPath)}`, "Protect safety snapshot");
            snapshotSaved = true;
            emit("info", `Destination safety snapshot saved: ${snapshotPath}`);
          });
          await runPhase(phases, "restore", async () => {
            stageCreated = true;
            await sqlFile(targetConn, "create-stage", renderCreateStageSql(stage));
            await checked(targetConn, `${dst} exec -T db pg_restore -U supabase_admin -d ${shellQuote(stage)} ${CLONE_RESTORE_FLAGS.join(" ")} ${shellQuote(archive)}`, "Restore complete source database into staging (matching extensions and roles required)");
            if (runtimeSchemas.length > 0) {
              // This is a dedicated archive rather than a --schema filter on
              // the full snapshot. pg_restore schema filters omit the CREATE
              // SCHEMA item itself, which makes a restore into template0 fail.
              await checked(
                targetConn,
                `${dst} exec -T db pg_restore -U supabase_admin -d ${shellQuote(stage)} ${CLONE_RESTORE_FLAGS.join(" ")} ${shellQuote(runtime)}`,
                "Preserve destination runtime schemas",
              );
            }
            await sqlFile(targetConn, "preserve-settings", renderPreserveDatabaseSettingsSql(stage));
          });
          await runPhase(phases, "verify", async () => {
            await checked(targetConn, psql(dst, stage, "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r', 'p') AND n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema';"), "Verify restored tables");
            paused = true;
            await checked(targetConn, `${dst} stop ${services.map(shellQuote).join(" ")}`, "Pause destination services for cutover", SERVICES_TIMEOUT);
            gated = true;
            await gate(targetConn, "postgres");
            await gate(targetConn, stage);
            await sqlFile(targetConn, "activate", renderSwapSql(stage, previous));
            swapped = true;
            gated = false;
            await restart(targetConn);
            await checked(targetConn, psql(dst, "postgres", "SELECT 1;"), "Verify active cloned database");
            activated = true;
            paused = false;
            emit("ok", "The cloned database is serving through the destination's existing URLs and credentials.");
          });
        } catch (error) {
          // Attempt recovery while verified connections are still available.
          if (paused || gated || swapped) {
            try { await recover(targetConn); }
            catch { recovered = false; }
          }
          throw error;
        } finally {
          try {
            await runPhase(phases, "cleanup", async () => { await cleanupSource(sourceConn); await cleanupTarget(targetConn); });
          } catch (error) {
            // A failed cleanup is a failed job, even when activation succeeded.
            failure = error instanceof Error ? error.message : "Clone cleanup failed.";
          }
        }
      };
      if (source.serverId === target.serverId) await work(sourceConn);
      else await withConnection(target.serverId, work);
    });
  } catch (error) {
    failure = error instanceof Error ? error.message : "Database clone failed.";
    // A lost connection may have committed the atomic swap before its reply
    // reached us. Reconnect and inspect the catalog instead of guessing.
    if (paused || gated || swapped) {
      try {
        await withConnection(target.serverId, async (conn) => {
          const oldExists = await checked(conn, psql(dst, "template1", `SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = ${sqlLiteral(previous)});`), "Inspect clone recovery state");
          swapped = oldExists === "t";
          await recover(conn);
          recovered = true;
          await cleanupTarget(conn);
        });
      } catch { recovered = false; }
    }
    // Source preparation can outlive an unsuccessful destination connection.
    if (sourcePrepared) await withConnection(source.serverId, cleanupSource).catch(() => {});
    if (targetPrepared && recovered) await withConnection(target.serverId, cleanupTarget).catch(() => {});
  } finally {
    try {
      if (failure) emit("err", failure);
      if (!recovered) emit("err", `Automatic recovery could not finish. Keep the destination offline and inspect databases ${previous} and ${stage}. Safety archive: ${snapshotSaved ? snapshotPath : "not created"}.`);
      await prisma.dbInstance.update({ where: { id: target.id }, data: { status: recovered ? "running" : "error", lastActionLog: tail.text() } });
      await audit({ userId: ctx.userId, userEmail: ctx.userEmail, action: failure || !recovered ? "instance.clone.failed" : "instance.clone", targetType: "db_instance", targetId: target.id, metadata: { sourceInstanceId: source.id, sourceServerId: source.serverId, targetServerId: target.serverId, snapshotPath: snapshotSaved ? snapshotPath : null, activated, recovered, ...(failure ? { error: failure } : {}) } }).catch(() => {});
      await persistLogTail(target.id, tail);
    } catch { failure = failure ?? "Could not persist clone completion."; }
    endJob(jobId, failure || !recovered ? "error" : "ok");
    release();
  }
}
