/**
 * Job-id helpers (contract §4) — deliberately dependency-free.
 *
 * These live apart from pipeline.ts because modules that only need to *name*
 * a job (crash recovery, route handlers, the instrumentation hook) must not
 * drag in the pipeline's transitive `lib/ssh` → `ssh2` native-addon graph.
 * Importing that chain from anything Next compiles for the edge runtime
 * fails the build ("Node.js binary module … is not supported in the browser").
 */

export function provisionJobId(instanceId: string): string {
  return `provision:${instanceId}`;
}

export function removeJobId(instanceId: string): string {
  return `remove:${instanceId}`;
}

export function restoreJobId(instanceId: string): string {
  return `restore:${instanceId}`;
}

/** A restore whose source is a live database rather than a file. */
export function syncJobId(instanceId: string): string {
  return `sync:${instanceId}`;
}

/** A clone job belongs to its destination; the source remains running. */
export function cloneJobId(instanceId: string): string {
  return `clone:${instanceId}`;
}
