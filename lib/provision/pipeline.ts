/**
 * Provisioning pipeline — architecture §4.3, spec §6.1,
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
 * health → pooler. `prepare` appears ONLY when the target server was not already
 * bootstrapped (lazy preparation) and is emitted by
 * lib/bootstrap/prepare.ts, with bootstrap's own step lines nested as `info`.
 *
 * All remote work happens inside ONE withConnection — one connection, one
 * lock, one log for preparation + provisioning.
 *
 * Failure is terminal (spec §6.1): status → `error`, log tail persisted,
 * remote files deliberately LEFT IN PLACE for inspection, and never an
 * automatic retry — the operator chooses Retry (idempotent `up -d`) or Remove.
 *
 * `pooler` is the one exception to "any phase failure aborts the whole job":
 * by the time it runs, Kong/Studio/db are already up and health-checked, so
 * the instance is fully usable regardless of whether this separate, optional
 * capability (direct Postgres access via the shared Supavisor) registers
 * successfully. A `pooler` failure still reports `✗ pooler: message` and
 * still ends the job as `error` (so Retry stays available), but secrets are
 * sealed and persisted first regardless — they must never end up
 * unrecoverable just because this one extra integration had trouble.
 */
import path from "node:path";
import { ensureServerPrepared } from "@/lib/bootstrap/prepare";
import { refreshPooler, type EmitFn } from "@/lib/bootstrap/steps";
import { sealBytes } from "@/lib/servers/seal-bytes";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { open } from "@/lib/crypto";
import { serverLockHolder, tryAcquireServerLock } from "@/lib/jobs/lock";
import { isInstanceSslMode, type InstanceSslMode } from "@/lib/instances/ssl-mode";
import { DEFAULT_NETWORK_ACCESS, readNetworkAccess, type NetworkAccessPolicy } from "@/lib/instances/network-access";
import { formatResourceLimits, instanceSliceName, type ResourceLimits } from "@/lib/instances/resource-limits";
import { endJob, publish, startJob } from "@/lib/jobs/stream";
import { exec, sftpWrite, withConnection } from "@/lib/ssh";
import { waitForHealthy } from "./health";
import { installInstanceSlice } from "./resource-limits";
import { provisionJobId } from "./job-ids";
import { composeProjectName, isValidSlug, remotePathFor, subdomainsFor } from "./naming";
import { assertPoolerNetworkPolicy, readPoolerNetworkState, registerPoolerTenant } from "./pooler";
import { renderInstanceCompose } from "./render";
import { STORED_SETTINGS_INCLUDE, storedRenderSettings, type StoredRenderSettings } from "./stored-settings";
import { generateInstanceSecrets, type InstanceSecrets } from "./secrets";
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
export { removeJobId, restoreJobId, syncJobId } from "./job-ids";
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
  sslMode: InstanceSslMode;
  networkAccess: NetworkAccessPolicy | null;
  resourceLimits: ResourceLimits;
  /**
   * Auth settings, email templates and analytics toggle to render with. A
   * retried instance may already have them saved, and the `up -d` below must
   * not reset them to defaults.
   */
  renderSettings: StoredRenderSettings;
  /**
   * Secrets already stored for this instance, when there are any — retry
   * REUSES them instead of minting new ones. See {@link resolveSecrets}.
   */
  existingSecrets?: InstanceSecrets | null;
}

/**
 * Reuse this instance's stored secrets if it has them; only generate when
 * there is nothing to reuse.
 *
 * Regenerating on retry is silently destructive. `docker compose up -d` does
 * NOT re-initialise an existing Postgres volume, so a fresh POSTGRES_PASSWORD
 * lands in `.env` and every container while `pg_authid` keeps the old one —
 * the whole stack then fails with `password authentication failed for user
 * "postgres"`, and the instance looks broken for a reason nothing in the log
 * explains. Rotating `jwtSecret` compounds it: `anonKey`/`serviceRoleKey` are
 * derived from it, so every client app holding the old keys breaks too.
 *
 * Reuse is also correct for the case retry was designed for — a provision
 * that died before the volume existed re-initialises with these same values.
 */
export async function resolveSecrets(
  existing: InstanceSecrets | null | undefined,
  emit: EmitFn,
): Promise<InstanceSecrets> {
  if (existing) {
    emit("info", "reusing this instance's existing secrets (retry must not rotate them)");
    return existing;
  }
  const generated = await generateInstanceSecrets();
  emit("info", "generated postgres password, JWT secret, anon + service_role keys");
  return generated;
}

/** Decrypt a row's stored secrets, or null when it is not fully provisioned. */
export function readStoredSecrets(row: {
  pgPasswordEnc: Uint8Array | null;
  jwtSecretEnc: Uint8Array | null;
  anonKeyEnc: Uint8Array | null;
  serviceRoleKeyEnc: Uint8Array | null;
}): InstanceSecrets | null {
  if (!row.pgPasswordEnc || !row.jwtSecretEnc || !row.anonKeyEnc || !row.serviceRoleKeyEnc) {
    return null;
  }
  try {
    return {
      pgPassword: open(row.pgPasswordEnc),
      jwtSecret: open(row.jwtSecretEnc),
      anonKey: open(row.anonKeyEnc),
      serviceRoleKey: open(row.serviceRoleKeyEnc),
    };
  } catch {
    // Undecryptable (a rotated master key) — better to generate than to abort,
    // and the operator sees the "generated" line rather than "reusing".
    return null;
  }
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
  /** Set inside the pooler phase's own catch — see its comment below. */
  let poolerFailed: string | null = null;
  /** Why the instance's slice could not be installed; null when it was. */
  let limitsFailed: string | null = null;

  try {
    // `validate` already ran synchronously in startProvision/retryProvision —
    // the phase is emitted so the checklist has its first tick immediately.
    await runPhase(phaseOpts, "validate", async () => {
      emit("info", `slug ${row.slug} → ${row.apiSubdomain} / ${row.studioSubdomain}`);
      emit("info", `project ${row.composeProjectName} at ${row.remotePath}`);
      emit("info", `pooler TLS policy: sslmode=${row.sslMode}`);
    });

    const secrets = await withConnection(row.serverId, async (conn: SshConnection) => {
      // Lazy server preparation. Emits its own `prepare` phase ONLY
      // when the server was not already bootstrapped.
      await ensureServerPrepared(row.serverId, conn, emit, ctx);
      await persistLogTail(row.id, tail);

      const generated = await runPhase(phaseOpts, "secrets", async () =>
        resolveSecrets(row.existingSecrets, emit),
      );

      const rendered = await runPhase(phaseOpts, "render", async () =>
        renderInstanceCompose({
          slug: row.slug,
          project: row.composeProjectName,
          domain,
          secrets: generated,
          remotePath: row.remotePath,
          ...row.renderSettings,
        }),
      );

      await runPhase(phaseOpts, "upload", async () => {
        // The compose file bind-mounts Postgres init-scripts and Kong's
        // declarative config from ./volumes/ (relative to the compose file).
        // These are static — no per-instance secrets to inject, each
        // container substitutes its own env at startup — so they are read
        // once and uploaded verbatim on every provision/retry. Without them
        // `db`'s bind-mount sources are missing and it never becomes healthy,
        // which blocks every service that depends on it.
        const staticFiles = await loadStaticVolumeFiles();
        const realFiles = staticFiles.filter(
          (f) => path.posix.basename(f.relPath) !== ".gitkeep",
        );
        // `.gitkeep` placeholders mark the empty directories (storage/
        // snippets/functions) the compose file bind-mounts — no file content
        // is needed on the remote host, only the directory.
        const emptyDirs = staticFiles
          .filter((f) => path.posix.basename(f.relPath) === ".gitkeep")
          .map((f) => path.posix.dirname(f.relPath));

        // Every directory this phase writes into, created up front with ONE
        // explicit `mkdir -p` over exec — not sftpWrite's own best-effort SFTP
        // mkdir loop, which silently swallows every mkdir error (including
        // genuine ones) so a real failure there previously surfaced only much
        // later, as an unrelated-looking write failure with no clue that the
        // directory was never actually created. A single well-tested shell
        // command, checked explicitly, removes that whole failure class.
        const dirsNeeded = new Set<string>([
          row.remotePath,
          ...realFiles.map((f) => `${row.remotePath}/volumes/${path.posix.dirname(f.relPath)}`),
          ...emptyDirs.map((d) => `${row.remotePath}/volumes/${d}`),
        ]);
        const mkdirRes = await exec(
          conn,
          `mkdir -p ${[...dirsNeeded].map((d) => `'${d}'`).join(" ")}`,
        );
        if (mkdirRes.code !== 0) {
          throw new Error(
            `mkdir -p for ${row.remotePath} failed (code ${mkdirRes.code}): ${mkdirRes.stderr.trim()}`,
          );
        }

        await sftpWrite(
          conn,
          `${row.remotePath}/docker-compose.yml`,
          rendered.composeYaml,
          0o644,
        );
        await sftpWrite(conn, `${row.remotePath}/.env`, rendered.envFile, 0o600);

        for (const file of realFiles) {
          await sftpWrite(
            conn,
            `${row.remotePath}/volumes/${file.relPath}`,
            file.content,
            0o644,
          );
          emit("info", `uploaded volumes/${file.relPath}`);
        }
        emit(
          "info",
          `uploaded docker-compose.yml + .env + ${realFiles.length} support file(s) to ${row.remotePath}`,
        );
      });

      await runPhase(phaseOpts, "start", async () => {
        // Before `up -d`: Docker fixes a container's cgroup at creation, so the
        // slice must exist with its limits before the first container does.
        // Best-effort — an unsupported server still gets a working instance,
        // just an unlimited one, flagged in the panel as not applied.
        try {
          await installInstanceSlice(conn, row.composeProjectName, row.resourceLimits);
          emit(
            "info",
            `resource limits: ${formatResourceLimits(row.resourceLimits)} ` +
              `(${instanceSliceName(row.composeProjectName)})`,
          );
        } catch (err) {
          limitsFailed = err instanceof Error ? err.message : String(err);
          emit("info", `resource limits not applied — ${limitsFailed}`);
        }

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

      // Best-effort from the JOB's perspective, unlike every phase above:
      // Kong/Studio/db are already up and health-checked at this point, so
      // the instance is fully usable via its REST API regardless of whether
      // the pooler (an ADDITIONAL capability layered on top — direct
      // Postgres wire-protocol access) registers successfully. A failure
      // here must never leave the instance's own secrets unsaved (they'd be
      // unrecoverable — see readStoredSecrets/resolveSecrets above for why
      // that specifically must never happen) just because a separate,
      // optional integration had trouble. The phase still reports its own
      // `✗ pooler: message` via runPhase; only the *job's* outcome is
      // decoupled from it, below.
      try {
        await runPhase(phaseOpts, "pooler", async () => {
          if (row.networkAccess) {
            await prisma.dbInstance.update({ where: { id: row.id }, data: {
              networkAccessAppliedAt: null,
              networkAccessError: "Waiting for the pooler to confirm the saved policy.",
            } });
          }
          if (row.sslMode === "require") {
            // Older bootstrapped servers may still be running the pre-TLS
            // pooler template. Converge it before registering a tenant whose
            // policy would otherwise require TLS from a listener that cannot
            // negotiate it.
            await refreshPooler(conn, emit, row.serverId);
            emit("info", "shared pooler TLS listener is ready");
          }
          await registerPoolerTenant(conn, {
            serverId: row.serverId,
            project: row.composeProjectName,
            pgPassword: generated.pgPassword,
            sslMode: row.sslMode,
            networkAccess: row.networkAccess,
          });
          if (row.networkAccess) {
            assertPoolerNetworkPolicy(await readPoolerNetworkState(conn), row.composeProjectName, row.networkAccess);
            await prisma.dbInstance.update({ where: { id: row.id }, data: {
              networkAccessAppliedAt: new Date(), networkAccessError: null,
            } });
          }
          emit(
            "info",
            row.networkAccess?.mode === "blocked"
              ? "External database connections blocked — configure Network access in Manage."
              : `registered with the shared pooler as postgres.${row.composeProjectName} (sslmode=${row.sslMode})`,
          );
        });
      } catch (err) {
        poolerFailed = err instanceof Error ? err.message : String(err);
      }

      return generated;
    });

    await prisma.dbInstance.update({
      where: { id: row.id },
      data: {
        pgPasswordEnc: sealBytes(secrets.pgPassword),
        jwtSecretEnc: sealBytes(secrets.jwtSecret),
        anonKeyEnc: sealBytes(secrets.anonKey),
        serviceRoleKeyEnc: sealBytes(secrets.serviceRoleKey),
        // A pooler failure still leaves a fully usable instance (see above)
        // — status: error only to keep Retry available for the pooler step
        // itself; it does not mean the containers or these secrets are bad.
        status: poolerFailed ? "error" : "running",
        healthCheckedAt: new Date(),
        resourceLimitsAppliedAt: limitsFailed ? null : new Date(),
        resourceLimitsError: limitsFailed,
        lastActionLog: tail.text(),
      },
    });
    await audit({
      userId: ctx.userId,
      userEmail: ctx.userEmail,
      action: poolerFailed ? "instance.provision.failed" : "instance.provision",
      targetType: "db_instance",
      targetId: row.id,
      metadata: poolerFailed
        ? { slug: row.slug, server: row.serverId, sslMode: row.sslMode, error: poolerFailed }
        : { slug: row.slug, server: row.serverId, sslMode: row.sslMode },
    }).catch((auditErr: unknown) => {
      console.error("[provision] failed to write audit row:", auditErr);
    });
    endJob(jobId, poolerFailed ? "error" : "ok");
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
  sslMode: InstanceSslMode;
  userId: string;
  userEmail: string;
}): Promise<StartProvisionResult> {
  const ctx: ProvisionCtx = { userId: input.userId, userEmail: input.userEmail };
  const name = input.name?.trim() ?? "";
  const slug = input.slug?.trim() ?? "";

  if (!name) return { invalid: "Instance name is required." };
  if (!isInstanceSslMode(input.sslMode)) {
    return { invalid: "SSL mode must be either 'require' or 'disable'." };
  }
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
        sslMode: input.sslMode,
        networkAccess: DEFAULT_NETWORK_ACCESS,
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
      sslMode: input.sslMode,
      networkAccess: DEFAULT_NETWORK_ACCESS,
      resourceLimits: { cpuLimit: created.cpuLimit, memoryLimitMb: created.memoryLimitMb },
      // Nothing is stored yet for a new row — renders exactly the defaults.
      renderSettings: storedRenderSettings({ id: created.id }),
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
  let instance = await prisma.dbInstance.findUnique({
    where: { id: instanceId },
    include: STORED_SETTINGS_INCLUDE,
  });
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
    const current = await prisma.dbInstance.findUnique({
      where: { id: instanceId },
      include: STORED_SETTINGS_INCLUDE,
    });
    if (!current || current.deletedAt || current.status !== "error") {
      release();
      return { invalid: "The instance is no longer available for provisioning retry." };
    }
    instance = current;
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
      sslMode: instance.sslMode,
      networkAccess: readNetworkAccess(instance.networkAccess),
      resourceLimits: { cpuLimit: instance.cpuLimit, memoryLimitMb: instance.memoryLimitMb },
      renderSettings: storedRenderSettings(instance),
      // Retry keeps this instance's identity — see resolveSecrets.
      existingSecrets: readStoredSecrets(instance),
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
