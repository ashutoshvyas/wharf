/**
 * Instance teardown (spec §6.4, architecture §4.3 "Remove permanently").
 *
 * Detached job under `remove:{instanceId}` holding the per-server lock, with
 * the contract §5 teardown phases: stop → volumes → files → metadata.
 *
 * Destructive by design — `down -v` removes the named volumes, so the data is
 * gone the moment this succeeds (the confirmation copy in the UI says so).
 * The metadata row is only SOFT deleted, giving a grace period during which
 * an accidental removal is still explainable from the audit log.
 *
 * PATH SAFETY: `rm -rf` never sees user input. The stored `remotePath` is
 * re-derived and compared against `/opt/db-instances/{composeProjectName}`
 * immediately before the delete; anything else aborts the job loudly rather
 * than deleting a path an attacker (or a bad migration) put on the row.
 */
import { audit } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { serverLockHolder, tryAcquireServerLock } from "@/lib/jobs/lock";
import { endJob, startJob } from "@/lib/jobs/stream";
import { exec, withConnection } from "@/lib/ssh";
import {
  LogTail,
  makeEmitter,
  persistLogTail,
  removeJobId,
  runPhase,
  type ProvisionCtx,
} from "./pipeline";

/** The connection handle lib/ssh hands out (ssh2 Client, never imported here). */
type SshConnection = Parameters<typeof exec>[0];

/** The ONLY shape of remote path this module will ever delete (contract §7). */
export const INSTANCE_PATH_PREFIX = "/opt/db-instances";

/**
 * Re-validate a stored remote path before writing to or deleting it. Returns
 * the path when it is exactly `/opt/db-instances/{composeProjectName}`,
 * throws otherwise. Shared with lib/provision/restore.ts, which passes
 * `action: "RESTORE INTO"` since it uploads rather than deletes.
 * Exported for the unit test that feeds it a tampered row.
 */
export function assertSafeRemotePath(
  remotePath: string,
  project: string,
  action = "DELETE",
): string {
  const expected = `${INSTANCE_PATH_PREFIX}/${project}`;
  const shapeOk = new RegExp(
    `^${INSTANCE_PATH_PREFIX}/[A-Za-z0-9][A-Za-z0-9_.-]*$`,
  ).test(remotePath);
  if (!shapeOk || remotePath !== expected) {
    throw new Error(
      `REFUSING TO ${action} ${remotePath}: it is not this instance's directory ` +
        `(expected exactly ${expected}). The db_instances row looks tampered with — ` +
        "nothing was written to or removed from disk; investigate before retrying.",
    );
  }
  return expected;
}

export type StartRemoveResult = { jobId: string } | { busy: string } | { invalid: string };

/**
 * Kick off a detached teardown job. The instance is flipped to `removing`
 * before the job starts so a concurrent reader never sees it as healthy.
 *
 * `force`: skip the SSH-based stop/volumes/files phases and only remove
 * WHARF's own metadata — for an instance whose server can never be reached
 * (bad/missing credentials, decommissioned box), since the normal path
 * requires connecting before it can do anything at all. Restricted to
 * instances already in `error` — a healthy instance always has a reachable
 * server, so skipping cleanup there would abandon real running resources for
 * no reason; `error` is exactly the state that means normal remove can't work.
 */
export async function startRemove(
  instanceId: string,
  ctx: ProvisionCtx,
  opts: { force?: boolean } = {},
): Promise<StartRemoveResult> {
  const instance = await prisma.dbInstance.findUnique({ where: { id: instanceId } });
  if (!instance || instance.deletedAt) {
    throw new Error(`Instance ${instanceId} was not found.`);
  }

  const force = opts.force ?? false;
  if (force && instance.status !== "error") {
    return {
      invalid:
        `Force remove is only available for instances in 'error' status ` +
        `(this instance is '${instance.status}') — use the normal remove, ` +
        "which cleans up remote resources.",
    };
  }

  const release = tryAcquireServerLock(instance.serverId, "remove");
  if (!release) {
    return { busy: serverLockHolder(instance.serverId) ?? "another job" };
  }

  const jobId = removeJobId(instanceId);
  try {
    await prisma.dbInstance.update({
      where: { id: instanceId },
      data: { status: "removing" },
    });
    startJob(jobId);
  } catch (err) {
    release();
    throw err;
  }

  void runTeardown(
    {
      id: instance.id,
      serverId: instance.serverId,
      name: instance.name,
      slug: instance.slug,
      composeProjectName: instance.composeProjectName,
      remotePath: instance.remotePath,
    },
    ctx,
    jobId,
    release,
    force,
  );
  return { jobId };
}

interface TeardownRow {
  id: string;
  serverId: string;
  name: string;
  slug: string;
  composeProjectName: string;
  remotePath: string;
}

/** `docker volume ls -q --filter name={project}_` → the volume names. */
async function listVolumes(conn: SshConnection, project: string): Promise<string[]> {
  const res = await exec(conn, `docker volume ls -q --filter name=${project}_`);
  if (res.code !== 0) {
    throw new Error(`docker volume ls failed (code ${res.code}): ${res.stderr.trim()}`);
  }
  return res.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

async function runTeardown(
  row: TeardownRow,
  ctx: ProvisionCtx,
  jobId: string,
  release: () => void,
  force: boolean,
): Promise<void> {
  const tail = new LogTail();
  const emit = makeEmitter(jobId, tail);
  const phaseOpts = { instanceId: row.id, emit, tail };
  let volumesRemoved: string[] = [];

  try {
    if (force) {
      emit(
        "info",
        "force remove: no SSH connection is attempted — the stop/volumes/files " +
          "phases are skipped entirely. Anything that exists on the remote " +
          "server for this instance is left untouched; only WHARF's own " +
          "metadata row is removed.",
      );
    } else {
      await withConnection(row.serverId, async (conn: SshConnection) => {
        // ── stop: containers AND named volumes in one idempotent command ──
        await runPhase(phaseOpts, "stop", async () => {
          volumesRemoved = await listVolumes(conn, row.composeProjectName);
          const res = await exec(
            conn,
            `docker compose -p ${row.composeProjectName} down -v`,
            { timeoutMs: 180_000 },
          );
          if (res.code !== 0) {
            throw new Error(
              `docker compose down -v failed (code ${res.code}): ${res.stderr.trim()}`,
            );
          }
          emit("info", `stopped and removed containers for ${row.composeProjectName}`);
        });

        // ── volumes: prove the data is really gone ────────────────────────
        await runPhase(phaseOpts, "volumes", async () => {
          let left = await listVolumes(conn, row.composeProjectName);
          if (left.length > 0) {
            emit("info", `still present after down -v, removing explicitly: ${left.join(", ")}`);
            await exec(conn, `docker volume rm -f ${left.join(" ")}`, { timeoutMs: 60_000 });
            left = await listVolumes(conn, row.composeProjectName);
          }
          if (left.length > 0) {
            throw new Error(
              `volumes still exist after removal: ${left.join(", ")} — something is still ` +
                "using them. Remove them manually and retry.",
            );
          }
          emit(
            "info",
            volumesRemoved.length > 0
              ? `removed ${volumesRemoved.length} volume(s): ${volumesRemoved.join(", ")}`
              : "no named volumes found for this project",
          );
        });

        // ── files: the guarded rm -rf ──────────────────────────────────────
        await runPhase(phaseOpts, "files", async () => {
          const safePath = assertSafeRemotePath(row.remotePath, row.composeProjectName);
          const res = await exec(conn, `rm -rf ${safePath}`, { timeoutMs: 60_000 });
          if (res.code !== 0) {
            throw new Error(`rm -rf ${safePath} failed (code ${res.code}): ${res.stderr.trim()}`);
          }
          emit("info", `deleted ${safePath}`);
        });
      });
    }

    // ── metadata: soft delete + unlink websites ───────────────────────────
    await runPhase(phaseOpts, "metadata", async () => {
      const unlinked = await prisma.website.updateMany({
        where: { dbInstanceId: row.id },
        data: { dbInstanceId: null },
      });
      // `slug` carries a hard DB-level unique constraint independent of
      // deletedAt (contract §7 — subdomains stay reserved across the whole
      // grace period, even once purged, so a stale cache/DNS entry can never
      // point at a *different* instance's data). Left unchanged, that
      // constraint would keep the original slug permanently unavailable,
      // since nothing else ever clears it. Renaming it here — the moment the
      // real subdomain stops existing — immediately frees the human-facing
      // name for reuse while the soft-deleted row (and its audit trail)
      // still exists under this new value for the rest of the grace period.
      const retiredSlug = `${row.slug}__removed-${Date.now()}`;
      await prisma.dbInstance.update({
        where: { id: row.id },
        data: {
          deletedAt: new Date(),
          lastActionLog: tail.text(),
          slug: retiredSlug,
        },
      });
      emit(
        "info",
        `soft-deleted metadata row (slug retired as ${retiredSlug}); unlinked ${unlinked?.count ?? 0} website(s)`,
      );
    });

    await audit({
      userId: ctx.userId,
      userEmail: ctx.userEmail,
      action: "instance.remove",
      targetType: "db_instance",
      targetId: row.id,
      metadata: {
        // The original human-facing slug, since the row's own `slug` column
        // is retired (mangled) as part of this same removal — see above.
        slug: row.slug,
        project: row.composeProjectName,
        server: row.serverId,
        volumesRemoved: volumesRemoved.length,
        forced: force,
      },
    }).catch((auditErr: unknown) => {
      console.error("[teardown] failed to write audit row:", auditErr);
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
        console.error(`[teardown] failed to mark ${row.id} errored:`, dbErr);
      });
    await audit({
      userId: ctx.userId,
      userEmail: ctx.userEmail,
      action: "instance.remove.failed",
      targetType: "db_instance",
      targetId: row.id,
      metadata: { project: row.composeProjectName, error: message, forced: force },
    }).catch((auditErr: unknown) => {
      console.error("[teardown] failed to write failure audit row:", auditErr);
    });
    endJob(jobId, "error");
  } finally {
    release();
  }
}
