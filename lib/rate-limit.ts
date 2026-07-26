/**
 * Login rate limiting & lockout.
 *
 * DESIGN DECISION — in-memory store: the panel is deployed as a single
 * long-lived Node process (architecture §2 — provisioning jobs already
 * require this), so a process-local Map is sufficient and correct for v1.
 * This is NOT safe for edge/serverless/multi-replica deployments; if the
 * panel ever scales horizontally, swap the Map for a shared store (Redis /
 * Postgres) behind the same three functions.
 *
 * KEY — normalized (lowercased, trimmed) email. IP-based limiting is
 * deliberately out of scope: NextAuth's `authorize()` context does not
 * expose the client IP cleanly (the request may arrive via proxies whose
 * headers we haven't configured trust for), so keying on email is the
 * reliable option. Limitation: an attacker rotating target emails is not
 * throttled per-source; acceptable for a small-team internal panel.
 *
 * POLICY — 5 failures within a 15-minute sliding window locks the key for
 * 15 minutes from the LAST failure. A successful login clears the key.
 *
 * AUDITING — this module stays pure (no DB imports) so it is trivially
 * unit-testable. `recordFailure` returns `lockoutTriggered: true` exactly
 * once per lockout episode (on the unlocked→locked transition); the caller
 * (lib/auth.ts authorize()) writes the single 'auth.lockout' audit row.
 */

const WINDOW_MS = 15 * 60 * 1000; // sliding failure window
const LOCKOUT_MS = 15 * 60 * 1000; // lock duration, from last failure
const MAX_FAILURES = 5;

interface Entry {
  /** Timestamps (ms) of failures inside the sliding window. */
  failures: number[];
  /** Epoch ms until which the key is locked; 0 = not locked. */
  lockedUntil: number;
}

const store = new Map<string, Entry>();

function normalize(key: string): string {
  return key.trim().toLowerCase();
}

export interface RecordFailureResult {
  locked: boolean;
  /** True only on the unlocked→locked transition — audit 'auth.lockout' then. */
  lockoutTriggered: boolean;
}

export function recordFailure(rawKey: string): RecordFailureResult {
  const key = normalize(rawKey);
  const now = Date.now();
  const entry = store.get(key) ?? { failures: [], lockedUntil: 0 };

  const wasLocked = entry.lockedUntil > now;
  entry.failures = entry.failures.filter((t) => now - t < WINDOW_MS);
  entry.failures.push(now);

  let lockoutTriggered = false;
  if (entry.failures.length >= MAX_FAILURES) {
    entry.lockedUntil = now + LOCKOUT_MS; // lock runs from the last failure
    if (!wasLocked) lockoutTriggered = true;
  }

  store.set(key, entry);
  return { locked: entry.lockedUntil > now, lockoutTriggered };
}

export function isLocked(rawKey: string): boolean {
  const entry = store.get(normalize(rawKey));
  return !!entry && entry.lockedUntil > Date.now();
}

/** Milliseconds until the lock expires (Retry-After hint). 0 when not locked. */
export function remainingMs(rawKey: string): number {
  const entry = store.get(normalize(rawKey));
  if (!entry) return 0;
  return Math.max(0, entry.lockedUntil - Date.now());
}

/** Call on successful login — forgets failures AND any active lock. */
export function clearFailures(rawKey: string): void {
  store.delete(normalize(rawKey));
}

/** Test helper — wipe all limiter state. */
export function resetRateLimiter(): void {
  store.clear();
}
