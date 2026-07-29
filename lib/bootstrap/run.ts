/**
 * Bootstrap orchestrator — runs the five idempotent steps
 * (lib/bootstrap/steps.ts) over one SSH connection as a detached job,
 * streaming progress through lib/jobs/stream under job id
 * `bootstrap:{serverId}` and holding the per-server single-flight lock
 * (lib/jobs/lock) for the duration.
 *
 * Outcomes:
 *  - all steps pass → servers.bootstrapped=true, audit 'server.bootstrap',
 *    job ends 'ok';
 *  - any step fails → error line published, audit 'server.bootstrap.failed',
 *    job ends 'error', row untouched (re-run after fixing the cause);
 *  - lock busy → caller gets the holder label for a 409.
 */
import { audit } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { serverLockHolder, tryAcquireServerLock } from "@/lib/jobs/lock";
import { endJob, publish, startJob } from "@/lib/jobs/stream";
import { withConnection } from "@/lib/ssh";
import { runBootstrapSteps } from "./prepare";
import { BOOTSTRAP_STEPS } from "./steps";

export interface BootstrapUserCtx {
  userId: string;
  userEmail: string;
}

export type RunBootstrapResult = { jobId: string } | { busy: string };

export function bootstrapJobId(serverId: string): string {
  return `bootstrap:${serverId}`;
}

/**
 * Kick off a bootstrap job for `serverId`. Returns synchronously: either the
 * job id to stream (`GET …/bootstrap-log`), or the label of whatever job
 * currently holds the server lock. The work itself runs detached.
 */
export function runBootstrap(
  serverId: string,
  userCtx: BootstrapUserCtx,
): RunBootstrapResult {
  const release = tryAcquireServerLock(serverId, "bootstrap");
  if (!release) {
    return { busy: serverLockHolder(serverId) ?? "another job" };
  }

  const jobId = bootstrapJobId(serverId);
  try {
    startJob(jobId);
  } catch (err) {
    release();
    throw err;
  }

  void (async () => {
    try {
      await withConnection(serverId, async (conn) => {
        // Same loop the provisioning pipeline runs (lib/bootstrap/prepare.ts);
        // here the step markers stay top-level `step`/`ok` events because the
        // standalone route has no enclosing phase.
        await runBootstrapSteps(conn, (kind, line) => publish(jobId, kind, line), serverId);
      });

      await prisma.server.update({
        where: { id: serverId },
        data: { bootstrapped: true },
      });
      await audit({
        userId: userCtx.userId,
        userEmail: userCtx.userEmail,
        action: "server.bootstrap",
        targetType: "server",
        targetId: serverId,
        metadata: { steps: BOOTSTRAP_STEPS.length },
      });
      endJob(jobId, "ok");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      publish(jobId, "err", message);
      // Best-effort audit — a failing audit write must not mask the outcome.
      await audit({
        userId: userCtx.userId,
        userEmail: userCtx.userEmail,
        action: "server.bootstrap.failed",
        targetType: "server",
        targetId: serverId,
        metadata: { error: message },
      }).catch((auditErr: unknown) => {
        console.error("[bootstrap] failed to write failure audit row:", auditErr);
      });
      endJob(jobId, "error");
    } finally {
      release();
    }
  })();

  return { jobId };
}
