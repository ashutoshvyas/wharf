/**
 * Instance restore — load a Postgres backup, downloaded from an
 * existing Supabase project, into an existing running WHARF instance.
 *
 * Detached job under `restore:{instanceId}` holding the per-server lock, with
 * phases `upload → snapshot → restore → cleanup`, mirroring teardown.ts's
 * structure and reusing its `runPhase`/`LogTail`/`makeEmitter` helpers.
 *
 * The Postgres side (safety snapshot, loading a dump into the target) lives in
 * restore-core.ts, shared with sync.ts — the same pipeline fed from a live
 * source database instead of an uploaded file.
 *
 * SECURITY: the client-supplied filename (`X-Backup-Filename`) is used ONLY
 * to detect the file extension. It is never interpolated into a shell
 * command or a remote path — every path this module writes is generated
 * server-side from already-validated instance metadata (composeProjectName)
 * plus a timestamp. `assertSafeRemotePath` (imported from teardown.ts) is
 * re-checked before anything is uploaded, same as a normal removal.
 *
 * The uploaded file is transferred host-side via the existing `sftpWrite`,
 * then moved into the Postgres container with `docker compose cp` — `exec()`
 * decodes stdout/stderr as UTF-8 (lib/ssh.ts), so it is never used to carry
 * the dump bytes themselves, only the plain-text console output of
 * pg_dump/pg_restore/psql/docker compose.
 */
import AdmZip from "adm-zip";
import { audit } from "@/lib/audit";
import { open } from "@/lib/crypto";
import { prisma } from "@/lib/db";
import { serverLockHolder, tryAcquireServerLock } from "@/lib/jobs/lock";
import { endJob, startJob } from "@/lib/jobs/stream";
import { exec, sftpWrite, withConnection } from "@/lib/ssh";
import {
  LogTail,
  makeEmitter,
  persistLogTail,
  restoreJobId,
  runPhase,
  type ProvisionCtx,
} from "./pipeline";
import {
  countTables,
  loadDumpIntoTarget,
  looksLikeCustomFormatDump,
  pgPasswordEnv,
  reassertInstanceRoles,
  reassertSchemaPrivileges,
  resolveAdminUser,
  shellQuote,
  takeSafetySnapshot,
} from "./restore-core";
import { assertSafeRemotePath } from "./teardown";

/** The connection handle lib/ssh hands out (ssh2 Client, never imported here). */
type SshConnection = Parameters<typeof exec>[0];

/** Accepted dump-file extensions — for a direct upload or a single entry inside a .zip. */
const DUMP_EXTENSIONS = [".backup", ".dump", ".sql"] as const;
type DumpExtension = (typeof DUMP_EXTENSIONS)[number];

/** Refused before anything is parsed — bounds worst-case memory use (the
 * whole upload is buffered; see the module doc in the restore API route). */
export const MAX_RESTORE_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB

function extensionOf(filename: string): string {
  const i = filename.lastIndexOf(".");
  return i === -1 ? "" : filename.slice(i).toLowerCase();
}

function isDumpExtension(ext: string): ext is DumpExtension {
  return (DUMP_EXTENSIONS as readonly string[]).includes(ext);
}

/**
 * Resolve an uploaded file to its actual dump bytes + detected extension,
 * unwrapping a .zip if that's what was uploaded. Throws with a user-facing
 * message on anything else (multi-entry zip, disallowed extension, etc).
 */
export function extractDumpBuffer(
  buffer: Buffer,
  filename: string,
): { buffer: Buffer; extension: DumpExtension } {
  const topExt = extensionOf(filename);
  if (topExt === ".zip") {
    const zip = new AdmZip(buffer);
    const entries = zip.getEntries().filter((e) => !e.isDirectory);
    if (entries.length !== 1) {
      throw new Error(
        `The .zip must contain exactly one backup file — found ${entries.length}.`,
      );
    }
    const entry = entries[0]!;
    const entryExt = extensionOf(entry.entryName);
    if (!isDumpExtension(entryExt)) {
      throw new Error(
        `"${entry.entryName}" inside the .zip is not a .backup/.dump/.sql file.`,
      );
    }
    return { buffer: entry.getData(), extension: entryExt };
  }
  if (!isDumpExtension(topExt)) {
    throw new Error(
      `The file must be a .zip, .backup, .dump, or .sql file (got "${filename}").`,
    );
  }
  return { buffer, extension: topExt };
}

export type StartRestoreResult = { jobId: string } | { busy: string } | { invalid: string };

/**
 * Kick off a detached restore job. Only valid for a `running` instance whose
 * name matches `confirmName` (the same type-the-name confirmation pattern as
 * remove) — a healthy, reachable server is required since this needs a live
 * connection from the very first phase, unlike force-remove's escape hatch.
 */
export async function startRestore(
  instanceId: string,
  ctx: ProvisionCtx,
  confirmName: string,
  file: { buffer: Buffer; filename: string },
): Promise<StartRestoreResult> {
  const instance = await prisma.dbInstance.findFirst({
    where: { id: instanceId, deletedAt: null },
  });
  if (!instance) return { invalid: `Instance ${instanceId} was not found.` };
  if (confirmName !== instance.name) {
    return { invalid: "Confirmation does not match the instance name." };
  }
  if (instance.status !== "running") {
    return {
      invalid:
        `Restore is only available for a running instance ` +
        `(this instance is '${instance.status}').`,
    };
  }
  if (file.buffer.length > MAX_RESTORE_UPLOAD_BYTES) {
    return {
      invalid:
        `Upload is too large (${file.buffer.length} bytes) — ` +
        `the limit is ${MAX_RESTORE_UPLOAD_BYTES} bytes.`,
    };
  }
  if (!instance.pgPasswordEnc) {
    return {
      invalid: "This instance has no stored Postgres password — it never finished provisioning.",
    };
  }

  let dump: { buffer: Buffer; extension: DumpExtension };
  try {
    dump = extractDumpBuffer(file.buffer, file.filename);
  } catch (err) {
    return { invalid: err instanceof Error ? err.message : String(err) };
  }

  const release = tryAcquireServerLock(instance.serverId, "restore");
  if (!release) {
    return { busy: serverLockHolder(instance.serverId) ?? "another job" };
  }

  const jobId = restoreJobId(instanceId);
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

  void runRestore(
    {
      id: instance.id,
      serverId: instance.serverId,
      composeProjectName: instance.composeProjectName,
      remotePath: instance.remotePath,
      pgPassword: open(instance.pgPasswordEnc),
      sourceFilename: file.filename,
    },
    dump,
    ctx,
    jobId,
    release,
  );
  return { jobId };
}

interface RestoreRow {
  id: string;
  serverId: string;
  composeProjectName: string;
  remotePath: string;
  pgPassword: string;
  sourceFilename: string;
}

async function runRestore(
  row: RestoreRow,
  dump: { buffer: Buffer; extension: DumpExtension },
  ctx: ProvisionCtx,
  jobId: string,
  release: () => void,
): Promise<void> {
  const tail = new LogTail();
  const emit = makeEmitter(jobId, tail);
  const phaseOpts = { instanceId: row.id, emit, tail };
  const compose = `docker compose -p ${row.composeProjectName}`;
  const ts = Date.now();
  let snapshotPath = "";

  try {
    const safeDir = assertSafeRemotePath(
      row.remotePath,
      row.composeProjectName,
      "RESTORE INTO",
    );
    // Every path below is built from validated instance metadata + this
    // timestamp — never from the client-supplied filename (see module doc).
    const uploadRemotePath = `${safeDir}/restore/upload-${ts}${dump.extension}`;
    const snapshotRemotePath = `${safeDir}/backups/pre-restore-${ts}.backup`;
    const uploadContainerPath = `/tmp/wharf-restore-${ts}${dump.extension}`;
    const snapshotContainerPath = `/tmp/wharf-snapshot-${ts}.backup`;
    // Resolved once the connection is open — `postgres` is not a superuser in
    // supabase/postgres and cannot create objects in `public` (PG15+).
    const target = { compose, pgEnv: pgPasswordEnv(row.pgPassword), user: "postgres" };

    await withConnection(row.serverId, async (conn: SshConnection) => {
      // ── upload: get the dump onto the host, directories created upfront ──
      await runPhase(phaseOpts, "upload", async () => {
        target.user = await resolveAdminUser(conn, compose);
        emit("info", `restore operations will run as '${target.user}'`);
        const mkdirRes = await exec(
          conn,
          `mkdir -p ${shellQuote(`${safeDir}/restore`)} ${shellQuote(`${safeDir}/backups`)}`,
        );
        if (mkdirRes.code !== 0) {
          throw new Error(
            `mkdir -p failed (code ${mkdirRes.code}): ${mkdirRes.stderr.trim()}`,
          );
        }
        await sftpWrite(conn, uploadRemotePath, dump.buffer);
        emit("info", `uploaded ${dump.buffer.length} bytes to ${uploadRemotePath}`);
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

      // ── restore: load the uploaded dump, replacing existing data ─────────
      await runPhase(phaseOpts, "restore", async () => {
        const cpInRes = await exec(
          conn,
          `${compose} cp ${uploadRemotePath} db:${uploadContainerPath}`,
        );
        if (cpInRes.code !== 0) {
          throw new Error(
            `docker compose cp (restore upload) failed (code ${cpInRes.code}): ` +
              cpInRes.stderr.trim(),
          );
        }

        // Which tool to use is decided from the file's actual CONTENT, not
        // its extension — pg_dump's default format is plain-text SQL unless
        // -Fc/-Fd/-Ft was explicitly requested, so a ".backup"/".dump"-named
        // upload is very commonly plain SQL in practice. Trusting the
        // extension here previously sent every such file to pg_restore,
        // which refuses to even open it ("input file appears to be a text
        // format dump. Please use psql.") — a real error, but this phase
        // used to only ever log it as the commonly-benign warning below.
        const isSql = !looksLikeCustomFormatDump(dump.buffer);
        if (isSql && dump.extension !== ".sql") {
          emit(
            "info",
            `"${row.sourceFilename}" has a ${dump.extension} extension but is actually a ` +
              "plain-text SQL dump — loading it with psql instead of pg_restore.",
          );
        }

        // A non-zero exit is surfaced as a warning, not a failure — see the
        // doc on loadDumpIntoTarget for why that is the right call here. The
        // countTables check right after is what catches the case where that
        // tolerance would otherwise hide a restore that created NOTHING.
        const restoreCode = await loadDumpIntoTarget(
          conn,
          target,
          {
            containerPath: uploadContainerPath,
            isSql,
            snapshotPath,
          },
          emit,
        );

        const restoredSchemas = ["public"];
        const tables = await countTables(conn, target, restoredSchemas, emit);
        if (tables >= 0) {
          emit("info", `${tables} table(s) now in ${restoredSchemas.join(", ")}`);
        }
        if (restoreCode !== 0 && tables === 0) {
          throw new Error(
            `${isSql ? "psql" : "pg_restore"} reported errors and no tables exist in ` +
              `${restoredSchemas.join(", ")} — nothing was restored. Review the output above; ` +
              `the most common cause is the connecting role ('${target.user}') lacking rights ` +
              `on those schemas, or an upload that failed to parse at all. This instance's ` +
              `previous data is in ${snapshotPath}.`,
          );
        }

        // An uploaded dump comes from another cluster too, so it carries the
        // same risk as a live sync: put this instance's own role passwords
        // back, or its containers cannot authenticate against their own
        // database (see reassertInstanceRoles).
        await reassertInstanceRoles(
          conn,
          target,
          {
            remotePath: `${safeDir}/restore/roles-${ts}.sql`,
            containerPath: `/tmp/wharf-roles-${ts}.sql`,
          },
          emit,
        );

        // The upload's own owner/grants come with it too (--no-owner made
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
      });

      // ── cleanup: drop the temp copies (the snapshot under backups/ stays) ─
      await runPhase(phaseOpts, "cleanup", async () => {
        await exec(conn, `${compose} exec -T db rm -f ${uploadContainerPath}`);
        await exec(conn, `rm -f ${uploadRemotePath}`);
        emit("info", "removed temporary upload files (safety snapshot kept)");
      });
    });

    await prisma.dbInstance.update({ where: { id: row.id }, data: { status: "running" } });
    await audit({
      userId: ctx.userId,
      userEmail: ctx.userEmail,
      action: "instance.restore",
      targetType: "db_instance",
      targetId: row.id,
      metadata: {
        project: row.composeProjectName,
        server: row.serverId,
        sourceFilename: row.sourceFilename,
        snapshotPath,
      },
    }).catch((auditErr: unknown) => {
      console.error("[restore] failed to write audit row:", auditErr);
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
        console.error(`[restore] failed to mark ${row.id} errored:`, dbErr);
      });
    await audit({
      userId: ctx.userId,
      userEmail: ctx.userEmail,
      action: "instance.restore.failed",
      targetType: "db_instance",
      targetId: row.id,
      metadata: { project: row.composeProjectName, error: message, snapshotPath },
    }).catch((auditErr: unknown) => {
      console.error("[restore] failed to write failure audit row:", auditErr);
    });
    endJob(jobId, "error");
  } finally {
    release();
  }
}
