/**
 * Per-server single-flight lock: one bootstrap OR provision
 * OR teardown at a time per server (architecture §4.3 "single-flight").
 *
 * In-process by design — the panel is a single long-lived node process
 * (architecture §2; same argument as lib/rate-limit.ts). Not a distributed
 * lock; do not deploy multiple panel replicas without replacing this.
 */

const held = new Map<string, string>(); // serverId -> job label

/** Try to acquire. Returns a release fn, or null if the server is busy. */
export function tryAcquireServerLock(
  serverId: string,
  label: string,
): (() => void) | null {
  if (held.has(serverId)) return null;
  held.set(serverId, label);
  let released = false;
  return () => {
    if (!released) {
      released = true;
      held.delete(serverId);
    }
  };
}

/** What currently holds the lock for a server, if anything. */
export function serverLockHolder(serverId: string): string | null {
  return held.get(serverId) ?? null;
}
