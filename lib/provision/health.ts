/**
 * Instance health checks — architecture §4.3 step 5.
 *
 * Every probe runs INSIDE the target server over the SSH connection the
 * pipeline already holds. Nothing here touches the public hostname, so a
 * freshly provisioned instance is declared healthy long before DNS propagates
 * or Let's Encrypt has issued a certificate.
 */
import type { EmitFn } from "@/lib/bootstrap/steps";
import { exec } from "@/lib/ssh";

/** The connection handle lib/ssh hands out (ssh2 Client, never imported here). */
type SshConnection = Parameters<typeof exec>[0];

/** Backoff schedule between attempts: 5s, 10s, then 15s forever. */
const BACKOFF_MS = [5_000, 10_000, 15_000] as const;

/** Total wall-clock budget for the whole wait (architecture §4.3: 3–5 min). */
export const HEALTH_TIMEOUT_MS = 300_000;

/** Per-probe exec timeout — a wedged container must not eat the whole budget. */
const PROBE_TIMEOUT_MS = 20_000;

/** Lines of container log appended to the job when we give up. */
const FAILURE_LOG_LINES = 20;

/**
 * Test seam: unit tests replace `sleep` so the backoff schedule costs nothing.
 * The elapsed-time accounting below deliberately uses the *planned* delays as
 * a floor, so the 300s cap is honoured even when sleeping is instant.
 */
export const __testing = {
  sleep: (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)),
};

/** Tolerant exec: SSH/timeout failures surface as a non-zero result. */
async function probe(
  conn: SshConnection,
  cmd: string,
): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await exec(conn, cmd, { timeoutMs: PROBE_TIMEOUT_MS });
    const detail = (res.stdout.trim() || res.stderr.trim()).split("\n")[0] ?? "";
    return { ok: res.code === 0, detail };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

function pgCommand(project: string): string {
  return `docker compose -p ${project} exec -T db pg_isready -U postgres`;
}

/**
 * Kong probe — `kong health` rather than an HTTP request.
 *
 * Why: an HTTP probe would have to run from inside the project network with a
 * client the image is not guaranteed to ship (the Kong image has no curl/wget
 * on the PATH in recent tags), and would have to guess a route that exists on
 * a fresh stack. `kong health` is Kong's own supported liveness command: it
 * checks that the Nginx master + worker processes for this node are actually
 * running and exits non-zero otherwise — exactly the "did the container come
 * up for real" signal we want, with no extra tooling and no route assumptions.
 */
function kongCommand(project: string): string {
  return `docker compose -p ${project} exec -T kong kong health`;
}

/**
 * Poll Postgres then Kong until both report healthy, or throw after
 * {@link HEALTH_TIMEOUT_MS}. Emits one `info` line per attempt; on terminal
 * failure the last {@link FAILURE_LOG_LINES} log lines of each unhealthy
 * service are appended as `info` before throwing, so the persisted log tail
 * explains *why* it never came up.
 */
export async function waitForHealthy(
  conn: SshConnection,
  project: string,
  emit: EmitFn,
): Promise<void> {
  const started = Date.now();
  let planned = 0; // sum of the delays we have already waited
  let attempt = 0;

  for (;;) {
    attempt += 1;
    const pg = await probe(conn, pgCommand(project));
    const kong = pg.ok ? await probe(conn, kongCommand(project)) : { ok: false, detail: "skipped" };

    if (pg.ok && kong.ok) {
      emit("info", `attempt ${attempt}: postgres accepting connections, kong healthy`);
      return;
    }
    emit(
      "info",
      `attempt ${attempt}: postgres ${pg.ok ? "ok" : `not ready (${pg.detail || "no output"})`}` +
        `, kong ${kong.ok ? "ok" : `not ready (${kong.detail || "no output"})`}`,
    );

    const delay = BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)]!;
    const elapsed = Math.max(Date.now() - started, planned);
    if (elapsed + delay >= HEALTH_TIMEOUT_MS) {
      const unhealthy = [!pg.ok ? "db" : null, !kong.ok ? "kong" : null].filter(
        (s): s is string => s !== null,
      );
      for (const service of unhealthy) {
        emit("info", `── last ${FAILURE_LOG_LINES} log lines of ${service} ──`);
        const logs = await exec(
          conn,
          `docker compose -p ${project} logs --tail ${FAILURE_LOG_LINES} ${service}`,
          { timeoutMs: PROBE_TIMEOUT_MS },
        ).catch((err: unknown) => ({
          stdout: "",
          stderr: err instanceof Error ? err.message : String(err),
        }));
        for (const raw of `${logs.stdout}\n${logs.stderr}`.split("\n")) {
          const line = raw.trim();
          if (line) emit("info", line);
        }
      }
      throw new Error(
        `timed out after ${Math.round(HEALTH_TIMEOUT_MS / 1000)}s — ` +
          `unhealthy: ${unhealthy.join(", ")}. See the container logs above.`,
      );
    }
    planned += delay;
    await __testing.sleep(delay);
  }
}
