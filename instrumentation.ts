/**
 * Next.js instrumentation hook — runs once per server process at
 * boot, before the first request is served.
 *
 * Two jobs:
 *  1. Configuration validation — surfaces domain/cookie
 *     misconfiguration that would otherwise only show up as "Studio keeps
 *     bouncing me to login" with nothing in the logs.
 *  2. Crash recovery — the provisioning engine keeps job state in
 *     memory (lib/jobs/stream), so a restart mid-provision/mid-teardown
 *     strands rows in `provisioning`/`removing` forever. sweepStaleJobs()
 *     flips those to `error` with an "interrupted" note so the user can Retry
 *     or Remove (architecture §4.3).
 *
 * Two guards, both deliberate:
 *  - nodejs runtime only — the edge runtime has no Prisma/SSH and would throw;
 *  - never rethrow — a database hiccup at boot must not take down the panel.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  try {
    const { checkConfig, reportConfigProblems } = await import("@/lib/config-check");
    reportConfigProblems(checkConfig());
  } catch (err) {
    console.error("[instrumentation] config check failed:", err);
  }

  try {
    const { sweepStaleJobs } = await import("@/lib/instances/recovery");
    await sweepStaleJobs();
  } catch (err) {
    console.error("[instrumentation] stale-job sweep failed:", err);
  }
}
