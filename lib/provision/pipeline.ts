/**
 * Provisioning pipeline (+ ) — architecture §4.3, spec §6.1,
 * docs/provisioning-contract.md §2/§4/§5.
 *
 * One async job per instance, held under the per-server single-flight lock
 * (lib/jobs/lock) and streamed through lib/jobs/stream under
 * `provision:{instanceId}`. Every phase boundary is published with the exact
 * marker glyphs the fleet UI's checklist is built against:
 *
 *   › {phase}            phase started   (kind "step")
 *   ✓ {phase}            phase completed (kind "ok")
 *   ✗ {phase}: {message} phase failed    (kind "err")
 *
 * Phases, in order: validate → [prepare] → secrets → render → upload → start →
 * health. `prepare` appears ONLY when the target server was not already
 * bootstrapped (, lazy preparation) and is emitted by
 * lib/bootstrap/prepare.ts, with bootstrap's own step lines nested as `info`.
 *
 * All remote work happens inside ONE withConnection — one connection, one
 * lock, one log for preparation + provisioning.
 *
 * Failure is terminal (spec §6.1): status → `error`, log tail persisted,
 * remote files deliberately LEFT IN PLACE for inspection, and never an
 * automatic retry — the operator chooses Retry (idempotent `up -d`) or Remove.
 */
import path from "node:path";
import { ensureServerPrepared } from "@/lib/bootstrap/prepare";
import type { EmitFn } from "@/lib/bootstrap/steps";
import { sealBytes } from "@/lib/servers/seal-bytes";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { serverLockHolder, tryAcquireServerLock } from "@/lib/jobs/lock";
import { endJob, publish, startJob } from "@/lib/jobs/stream";
import { exec, sftpWrite, withConnection } from "@/lib/ssh";
import { waitForHealthy } from "./health";
import { provisionJobId } from "./job-ids";
import { composeProjectName, isValidSlug, remotePathFor, subdomainsFor } from "./naming";
import { renderInstanceCompose } from "./render";
import { generateInstanceSecrets } from "./secrets";
import { loadStaticVolumeFiles } from "./static-volumes";

/** The connection handle lib/ssh hands out (ssh2 Client, never imported here). */
type SshConnection = Parameters<typeof exec>[0];

export interface ProvisionCtx {
  userId: string;
  userEmail: string;
}

/** Lines of job log persisted to `db_instances.last_action_log`. */
export const LOG_TAIL_LINES = 200;

/** Max output lines streamed per remote command (same budget as bootstrap). */
const MAX_STREAM_LINES = 200;

/** `docker compose up -d` can pull several images on a cold host. */
const COMPOSE_UP_TIMEOUT_MS = 180_000;

// Defined in the dependency-free job-ids module (so crash recovery and route
// handlers can name a job without importing this file's ssh2 graph), and
// re-exported here because the API layer imports them from the pipeline.
export { removeJobId } from "./job-ids";
export { provisionJobId };

/** Rolling tail of the job log, persisted on every phase transition. */
export class LogTail {
  private lines: string[] = [];

  push(line: string): void {
    this.lines.push(line);
    if (this.lines.length > LOG_TAIL_LINES) {
      this.lines.splice(0, this.lines.length - LOG_TAIL_LINES);
    }
  }

  text(): string {
    return this.lines.join("\n");
  }
}

/** Best-effort log-tail write — persistence must never mask the real outcome. */
export async function persistLogTail(instanceId: string, tail: LogTail): Promise<void> {
  await prisma.dbInstance
    .update({ where: { id: instanceId }, data: { lastActionLog: tail.text() } })
    .catch((err: unknown) => {
      console.error(`[provision] failed to persist log tail for ${instanceId}:`, err);
    });
}

/** Publish + record every job line so a panel restart still leaves a tail. */
export function makeEmitter(jobId: string, tail: LogTail): EmitFn {
  return (kind, line) => {
    publish(jobId, kind, line);
    tail.push(line);
  };
}

/**
 * Run one contract §5 phase: `› id` … `✓ id` / `✗ id: message`, persisting the
 * log tail on both boundaries so a crash mid-phase still leaves a readable
 * explanation on the row.
 */
export async function runPhase<T>(
  opts: { instanceId: string; emit: EmitFn; tail: LogTail },
  id: string,
  fn: () => Promise<T>,
): Promise<T> {
  opts.emit("step", `› ${id}`);
  await persistLogTail(opts.instanceId, opts.tail);
  try {
    const result = await fn();
    opts.emit("ok", `✓ ${id}`);
    await persistLogTail(opts.instanceId, opts.tail);
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    opts.emit("err", `✗ ${id}: ${message}`);
    await persistLogTail(opts.instanceId, opts.tail);
    throw Object.assign(err instanceof Error ? err : new Error(message), {
      phaseReported: true,
    });
  }
}

/** Stream trimmed remote output as capped `info` detail (bootstrap parity). */
function lineStreamer(emit: EmitFn): (chunk: string) => void {
  let published = 0;
  let truncated = false;
  return (chunk: string) => {
    for (const raw of chunk.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      if (published >= MAX_STREAM_LINES) {
        if (!truncated) {
          truncated = true;
          emit("info", "… output truncated");
        }
        return;
      }
      published += 1;
      emit("info", line);
    }
  };
}

interface PipelineRow {
  id: string;
  serverId: string;
  name: string;
  slug: string;
  composeProjectName: string;
  remotePath: string;
  apiSubdomain: string;
  studioSubdomain: string;
}

/**
 * The phase sequence itself, shared by provision and retry (retry reuses the
 * same row, project name and remote path — `up -d` is idempotent).
 */
async function runPipeline(
  row: PipelineRow,
  ctx: ProvisionCtx,
  jobId: string,
  release: () => void,
): Promise<void> {
  const tail = new LogTail();
  const emit = makeEmitter(jobId, tail);
  const phaseOpts = { instanceId: row.id, emit, tail };
  const domain = process.env.INSTANCE_DOMAIN ?? "";

  try {
    // `validate` already ran synchronously in startProvision/retryProvision —
    // the phase is emitted so the checklist has its first tick immediately.
    await runPhase(phaseOpts, "validate", async () => {
      emit("info", `slug ${row.slug} → ${row.apiSubdomain} / ${row.studioSubdomain}`);
      emit("info", `project ${row.composeProjectName} at ${row.remotePath}`);
    });

    const secrets = await withConnection(row.serverId, async (conn: SshConnection) => {
      // Lazy server preparation. Emits its own `prepare` phase ONLY
      // when the server was not already bootstrapped.
      await ensureServerPrepared(row.serverId, conn, emit, ctx);
      await persistLogTail(row.id, tail);

      const generated = await runPhase(phaseOpts, "secrets", async () => {
        const s = generateInstanceSecrets();
        emit("info", "generated postgres password, JWT secret, anon + service_role keys");
        return s;
      });

      const rendered = await runPhase(phaseOpts, "render", async () =>
        renderInstanceCompose({
          slug: row.slug,
          project: row.composeProjectName,
          domain,
          secrets: generated,
          remotePath: row.remotePath,
        }),
      );

      await runPhase(phaseOpts, "upload", async () => {
        await sftpWrite(
          conn,
          `${row.remotePath}/docker-compose.yml`,
          rendered.composeYaml,
          0o644,
        );
        await sftpWrite(conn, `${row.remotePath}/.env`, rendered.envFile, 0o600);

        // The compose file bind-mounts Postgres init-scripts and Kong's
        // declarative config from ./volumes/ (relative to the compose file).
        // These are static — no per-instance secrets to inject, each
        // container substitutes its own env at startup — so they are read
        // once and uploaded verbatim on every provision/retry. Without them
        // `db`'s bind-mount sources are missing and it never becomes healthy,
        // which blocks every service that depends on it.
        //
        // `.gitkeep` placeholders (storage/snippets/functions — empty
        // directories the compose file bind-mounts) are handled separately
        // via a single `mkdir -p`: an SFTP write of zero-length content is an
        // untested edge case worth avoiding outright, and it collapses three
        // round-trips into one.
        const staticFiles = await loadStaticVolumeFiles();
        const emptyDirs = new Set<string>();
        let uploaded = 0;
        for (const file of staticFiles) {
          if (path.posix.basename(file.relPath) === ".gitkeep") {
            emptyDirs.add(path.posix.dirname(file.relPath));
            continue;
          }
          await sftpWrite(
            conn,
            `${row.remotePath}/volumes/${file.relPath}`,
            file.content,
            0o644,
          );
          uploaded += 1;
          emit("info", `uploaded volumes/${file.relPath}`);
        }
        if (emptyDirs.size > 0) {
          const dirs = [...emptyDirs].map(
            (d) => `${row.remotePath}/volumes/${d}`,
          );
          const res = await exec(
            conn,
            `mkdir -p ${dirs.map((d) => `'${d}'`).join(" ")}`,
          );
          if (res.code !== 0) {
            throw new Error(
              `mkdir -p for empty volume dirs failed (code ${res.code}): ${res.stderr.trim()}`,
            );
          }
          emit("info", `created ${dirs.length} empty volume dir(s)`);
        }
        emit(
          "info",
          `uploaded docker-compose.yml + .env + ${uploaded} support file(s) to ${row.remotePath}`,
        );
      });

      await runPhase(phaseOpts, "start", async () => {
        const stream = lineStreamer(emit);
        // `cd` first: compose resolves the project directory (and therefore
        // `.env`) from the working directory when given a bare `-p`.
        const res = await exec(
          conn,
          `cd ${row.remotePath} && docker compose -p ${row.composeProjectName} up -d`,
          { timeoutMs: COMPOSE_UP_TIMEOUT_MS, onStdout: stream, onStderr: stream },
        );
        if (res.code !== 0) {
          throw new Error(
            `docker compose up -d failed (code ${res.code}): ${res.stderr.trim()}`,
          );
        }
      });

      await runPhase(phaseOpts, "health", async () => {
        await waitForHealthy(conn, row.composeProjectName, emit);
      });

      return generated;
    });

    await prisma.dbInstance.update({
      where: { id: row.id },
      data: {
        pgPasswordEnc: sealBytes(secrets.pgPassword),
        jwtSecretEnc: sealBytes(secrets.jwtSecret),
        anonKeyEnc: sealBytes(secrets.anonKey),
        serviceRoleKeyEnc: sealBytes(secrets.serviceRoleKey),
        status: "running",
        healthCheckedAt: new Date(),
        lastActionLog: tail.text(),
      },
    });
    await audit({
      userId: ctx.userId,
      userEmail: ctx.userEmail,
      action: "instance.provision",
      targetType: "db_instance",
      targetId: row.id,
      metadata: { slug: row.slug, server: row.serverId },
    }).catch((auditErr: unknown) => {
      console.error("[provision] failed to write audit row:", auditErr);
    });
    endJob(jobId, "ok");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Errors raised outside a phase (SSH connect, lock, …) still need a line.
    if (!(err as { phaseReported?: boolean })?.phaseReported) {
      emit("err", message);
    }
    await prisma.dbInstance
      .update({
        where: { id: row.id },
        data: { status: "error", lastActionLog: tail.text() },
      })
      .catch((dbErr: unknown) => {
        console.error(`[provision] failed to mark ${row.id} errored:`, dbErr);
      });
    await audit({
      userId: ctx.userId,
      userEmail: ctx.userEmail,
      action: "instance.provision.failed",
      targetType: "db_instance",
      targetId: row.id,
      metadata: { error: message },
    }).catch((auditErr: unknown) => {
      console.error("[provision] failed to write failure audit row:", auditErr);
    });
    endJob(jobId, "error");
  } finally {
    release();
  }
}

/** Pick a compose project name that is free on this server (contract §7). */
async function uniqueProjectName(serverId: string): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const candidate = composeProjectName();
    const clash = await prisma.dbInstance.findFirst({
      where: { serverId, composeProjectName: candidate },
    });
    if (!clash) return candidate;
  }
  throw new Error("Could not allocate a free compose project name on this server.");
}

export type StartProvisionResult =
  | { instanceId: string; jobId: string }
  | { busy: string }
  | { invalid: string };

/**
 * Validate, create the row, and kick off a detached provisioning job.
 * Returns synchronously-ish: the caller gets `{instanceId, jobId}` to stream
 * (`GET …/provision-log`) while the work continues in the background.
 *
 * Validation happens BEFORE any row is written, so a rejected request leaves
 * no trace. `invalid` messages are user-facing (400); `busy` names the lock
 * holder (409).
 */
export async function startProvision(input: {
  serverId: string;
  name: string;
  slug: string;
  userId: string;
  userEmail: string;
}): Promise<StartProvisionResult> {
  const ctx: ProvisionCtx = { userId: input.userId, userEmail: input.userEmail };
  const name = input.name?.trim() ?? "";
  const slug = input.slug?.trim() ?? "";

  if (!name) return { invalid: "Instance name is required." };
  if (!isValidSlug(slug)) {
    return {
      invalid:
        "Slug must be lowercase letters, digits and hyphens, start with a letter or " +
        "digit, and be at most 40 characters.",
    };
  }

  const domain = process.env.INSTANCE_DOMAIN?.trim();
  if (!domain) {
    return {
      invalid:
        "INSTANCE_DOMAIN is not configured on the panel — set it to the apex domain " +
        "whose wildcard record points at your database server, then retry.",
    };
  }

  // Slug uniqueness is checked across ALL rows, soft-deleted included: the
  // subdomain of a removed instance lingers in DNS/Let's Encrypt caches.
  const existing = await prisma.dbInstance.findFirst({ where: { slug } });
  if (existing) return { invalid: `Slug "${slug}" is already taken.` };

  const server = await prisma.server.findUnique({ where: { id: input.serverId } });
  if (!server) return { invalid: `Server ${input.serverId} was not found.` };

  const release = tryAcquireServerLock(input.serverId, "provision");
  if (!release) {
    return { busy: serverLockHolder(input.serverId) ?? "another job" };
  }

  let row: PipelineRow;
  try {
    const project = await uniqueProjectName(input.serverId);
    const remotePath = remotePathFor(project);
    const { apiSubdomain, studioSubdomain } = subdomainsFor(slug, domain);
    const created = await prisma.dbInstance.create({
      data: {
        serverId: input.serverId,
        name,
        slug,
        composeProjectName: project,
        remotePath,
        apiSubdomain,
        studioSubdomain,
        status: "provisioning",
      },
    });
    row = {
      id: created.id,
      serverId: input.serverId,
      name,
      slug,
      composeProjectName: project,
      remotePath,
      apiSubdomain,
      studioSubdomain,
    };
  } catch (err) {
    release();
    throw err;
  }

  const jobId = provisionJobId(row.id);
  try {
    startJob(jobId);
  } catch (err) {
    release();
    throw err;
  }

  void runPipeline(row, ctx, jobId, release);
  return { instanceId: row.id, jobId };
}

export type RetryProvisionResult = { jobId: string } | { busy: string } | { invalid: string };

/**
 * Re-run the pipeline for an errored instance. Same row, same compose project
 * and remote path — `docker compose up -d` and the SFTP writes are idempotent,
 * so a retry converges rather than duplicating anything.
 */
export async function retryProvision(
  instanceId: string,
  ctx: ProvisionCtx,
): Promise<RetryProvisionResult> {
  const instance = await prisma.dbInstance.findUnique({ where: { id: instanceId } });
  if (!instance || instance.deletedAt) {
    return { invalid: `Instance ${instanceId} was not found.` };
  }
  if (instance.status !== "error") {
    return {
      invalid: `Only instances in the 'error' state can be retried (this one is '${instance.status}').`,
    };
  }

  const release = tryAcquireServerLock(instance.serverId, "provision");
  if (!release) {
    return { busy: serverLockHolder(instance.serverId) ?? "another job" };
  }

  const jobId = provisionJobId(instanceId);
  try {
    await prisma.dbInstance.update({
      where: { id: instanceId },
      data: { status: "provisioning", lastActionLog: null },
    });
    startJob(jobId);
  } catch (err) {
    release();
    throw err;
  }

  await audit({
    userId: ctx.userId,
    userEmail: ctx.userEmail,
    action: "instance.provision.retry",
    targetType: "db_instance",
    targetId: instanceId,
    metadata: { slug: instance.slug, server: instance.serverId },
  }).catch((auditErr: unknown) => {
    console.error("[provision] failed to write retry audit row:", auditErr);
  });

  void runPipeline(
    {
      id: instance.id,
      serverId: instance.serverId,
      name: instance.name,
      slug: instance.slug,
      composeProjectName: instance.composeProjectName,
      remotePath: instance.remotePath,
      apiSubdomain: instance.apiSubdomain,
      studioSubdomain: instance.studioSubdomain,
    },
    ctx,
    jobId,
    release,
  );
  return { jobId };
}

/** Lenient "does this project have running containers" probe. */
async function anyRunning(conn: SshConnection, project: string): Promise<boolean> {
  try {
    const res = await exec(conn, `docker compose -p ${project} ps --format json`);
    return res.code === 0 && res.stdout.includes('"running"');
  } catch {
    return false;
  }
}

/**
 * Stop / start an instance's containers. Short enough to run inline (the API
 * awaits these and returns the updated DTO), but they still take the
 * per-server lock so they can never interleave with a provision or teardown.
 * Volumes are untouched by `stop`; Traefik's routers vanish while the
 * containers are down, so the subdomains simply go quiet.
 */
async function composeLifecycle(
  instanceId: string,
  ctx: ProvisionCtx,
  action: "stop" | "start",
): Promise<void> {
  const instance = await prisma.dbInstance.findUnique({ where: { id: instanceId } });
  if (!instance || instance.deletedAt) {
    throw new Error(`Instance ${instanceId} was not found.`);
  }

  const release = tryAcquireServerLock(instance.serverId, action);
  if (!release) {
    throw new Error(
      `Server is busy: ${serverLockHolder(instance.serverId) ?? "another job"} is already running.`,
    );
  }

  try {
    await withConnection(instance.serverId, async (conn: SshConnection) => {
      const res = await exec(
        conn,
        `docker compose -p ${instance.composeProjectName} ${action}`,
        { timeoutMs: 120_000 },
      );
      if (res.code !== 0) {
        throw new Error(
          `docker compose ${action} failed (code ${res.code}): ${res.stderr.trim()}`,
        );
      }
      const running = await anyRunning(conn, instance.composeProjectName);
      if (action === "start" && !running) {
        throw new Error(
          `Containers for ${instance.composeProjectName} are still not running after ` +
            "`docker compose start` — inspect the logs on the server.",
        );
      }
      if (action === "stop" && running) {
        throw new Error(
          `Containers for ${instance.composeProjectName} are still running after ` +
            "`docker compose stop`.",
        );
      }
    });

    await prisma.dbInstance.update({
      where: { id: instanceId },
      data: { status: action === "stop" ? "stopped" : "running" },
    });
    await audit({
      userId: ctx.userId,
      userEmail: ctx.userEmail,
      action: `instance.${action}`,
      targetType: "db_instance",
      targetId: instanceId,
      metadata: { project: instance.composeProjectName, server: instance.serverId },
    }).catch((auditErr: unknown) => {
      console.error(`[provision] failed to write ${action} audit row:`, auditErr);
    });
  } finally {
    release();
  }
}

export async function stopInstance(instanceId: string, ctx: ProvisionCtx): Promise<void> {
  await composeLifecycle(instanceId, ctx, "stop");
}

export async function startInstance(instanceId: string, ctx: ProvisionCtx): Promise<void> {
  await composeLifecycle(instanceId, ctx, "start");
}
