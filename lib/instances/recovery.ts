/**
 * Crash consistency + orphan detection — architecture §4.3.
 *
 * The provisioning engine runs in-process, so a panel restart mid-job leaves
 * two kinds of debris:
 *
 *  1. DB rows stuck in `provisioning` / `removing` / `restoring` with no job
 *     behind them —
 *     the in-memory job registry (lib/jobs/stream) died with the process.
 *     {@link sweepStaleJobs} marks those `error` with an "interrupted" note so
 *     the row becomes actionable again (Retry re-runs the idempotent pipeline).
 *     Called once at boot from the root `instrumentation.ts`.
 *
 *  2. Compose projects on a server with no matching row — e.g. the process
 *     died after `docker compose up -d` but before the row was finalized, or
 *     a row was purged by hand. {@link findOrphans} reports them; resolution
 *     is deliberately MANUAL (§4.3) — nothing here ever deletes anything on a
 *     remote host.
 */
import { audit } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { isJobActive } from "@/lib/jobs/stream";
import { cloneJobId, provisionJobId, removeJobId, restoreJobId, syncJobId } from "@/lib/provision/job-ids";

/** A job untouched for this long with no live stream is presumed dead. */
export const STALE_AFTER_MS = 10 * 60 * 1000;

/** Appended to `lastActionLog` so the reason is visible in the UI log pane. */
export const INTERRUPTED_NOTE =
  "\n✗ interrupted — panel restarted before this job finished";

/** Compose projects WHARF owns are named `sb_` + 4 hex (contract §7). */

/**
 * Mark every instance stuck mid-job by a panel restart as `error`.
 *
 * A row qualifies when it is `provisioning` or `removing`, has not been
 * touched for {@link STALE_AFTER_MS}, AND has no live job for either of its
 * job ids — the liveness check is what makes this safe to call on a running
 * panel (a genuinely long provision is never swept out from under itself).
 *
 * Returns the number of rows swept. Never throws for a single-row failure:
 * one bad row must not block recovery of the rest.
 */
export async function sweepStaleJobs(): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_AFTER_MS);

  const candidates = await prisma.dbInstance.findMany({
    where: {
      // Restore, external sync, and managed clone share this status and
      // each has its own job id, checked for liveness below.
      status: { in: ["provisioning", "removing", "restoring"] },
      updatedAt: { lt: cutoff },
    },
    select: { id: true, status: true, lastActionLog: true },
  });

  let swept = 0;
  for (const row of candidates) {
    const live = [provisionJobId, removeJobId, restoreJobId, syncJobId, cloneJobId].some((jobId) =>
      isJobActive(jobId(row.id)),
    );
    if (live) continue;
    try {
      await prisma.dbInstance.update({
        where: { id: row.id },
        data: {
          status: "error",
          lastActionLog: (row.lastActionLog ?? "") + INTERRUPTED_NOTE,
        },
      });
      await audit({
        action: "instance.job.interrupted",
        targetType: "db_instance",
        targetId: row.id,
        metadata: { previousStatus: row.status },
      });
      swept += 1;
    } catch (err) {
      console.error(`[recovery] failed to sweep instance ${row.id}:`, err);
    }
  }

  if (swept > 0) {
    console.warn(`[recovery] marked ${swept} interrupted instance job(s) as error`);
  }
  return swept;
}
