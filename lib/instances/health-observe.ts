/**
 * Observed instance health — the pure half of the periodic health check
 * (lib/instances/health-reconcile.ts). Classifies an instance from the
 * server's `docker ps` output and decides whether its stored status should
 * change. Client-safe (the card reads HEALTH_LOG_PREFIX).
 */

/** Marks a `lastActionLog` written by the health check, not by a job. */
export const HEALTH_LOG_PREFIX = "Health check";

/** One line of `docker ps -a` for a compose-managed container. */
export interface ContainerState {
  project: string;
  service: string;
  /** Docker's State: running, exited, restarting, created, paused, dead, removing. */
  state: string;
  /** Docker's human Status, e.g. "Up 2 hours (unhealthy)" or "Exited (137) 3 minutes ago". */
  status: string;
}

/** `docker ps -a` format that {@link parseDockerPs} reads, tab-separated. */
export const DOCKER_PS_FORMAT =
  '{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.service"}}\t{{.State}}\t{{.Status}}';

export function parseDockerPs(stdout: string): ContainerState[] {
  const out: ContainerState[] = [];
  for (const line of stdout.split("\n")) {
    const [project, service, state, status] = line.split("\t");
    if (!project || !service || !state) continue;
    out.push({ project, service, state, status: status ?? "" });
  }
  return out;
}

/** Which services an instance runs, from the vendored template (render.ts). */
export interface InstanceServices {
  /** Long-running services every instance has. */
  core: string[];
  /** Long-running, profile-gated services (analytics) — checked only when present. */
  optional: string[];
}

export type ObservedState = "running" | "stopped" | "degraded" | "missing" | "unreachable";

export interface Observation {
  state: ObservedState;
  detail: string;
}

function problemOf(c: ContainerState): string | null {
  if (c.state === "running") {
    if (/\(unhealthy\)/i.test(c.status)) return `${c.service} unhealthy`;
    if (/\(paused\)/i.test(c.status)) return `${c.service} paused`;
    return null;
  }
  if (c.state === "restarting") return `${c.service} restarting repeatedly`;
  const exit = /Exited \((\d+)\)/.exec(c.status);
  return exit ? `${c.service} exited (code ${exit[1]})` : `${c.service} ${c.state}`;
}

/** Classify one instance from its containers. One-shot init services are ignored. */
export function observeInstance(containers: ContainerState[], services: InstanceServices): Observation {
  const watched = new Set([...services.core, ...services.optional]);
  const relevant = containers.filter((c) => watched.has(c.service));
  if (relevant.length === 0) {
    return { state: "missing", detail: "no containers found for this instance on the server" };
  }

  const anyUp = relevant.some((c) => c.state === "running" || c.state === "restarting");
  if (!anyUp) {
    return { state: "stopped", detail: `all ${relevant.length} containers are stopped` };
  }

  const present = new Set(relevant.map((c) => c.service));
  const problems = [
    ...relevant.map(problemOf).filter((p): p is string => p !== null),
    ...services.core.filter((s) => !present.has(s)).map((s) => `${s} missing`),
  ];
  if (problems.length === 0) return { state: "running", detail: "all services running" };
  return { state: "degraded", detail: problems.sort().join("; ") };
}

/** The status an observation implies. */
export function statusFor(observed: ObservedState): "running" | "stopped" | "error" {
  if (observed === "running") return "running";
  if (observed === "stopped") return "stopped";
  return "error";
}

/**
 * The status change, if any, the health check may make to a row.
 *
 * Only settled rows are touched: `running` and `stopped` always, `error`
 * only when the health check set it (its log carries HEALTH_LOG_PREFIX) — a
 * failed provision, restore or clone keeps its own error and Retry. An
 * unreachable server only downgrades `running`: a stopped instance is not
 * serving anything either way.
 */
export function nextStatus(
  row: { status: string; lastActionLog: string | null },
  observed: Observation,
): "running" | "stopped" | "error" | null {
  const ownsError = row.status === "error" && (row.lastActionLog ?? "").startsWith(HEALTH_LOG_PREFIX);
  if (row.status !== "running" && row.status !== "stopped" && !ownsError) return null;
  if (observed.state === "unreachable" && row.status !== "running") return null;
  const target = statusFor(observed.state);
  return target === row.status ? null : target;
}

export function healthLog(at: Date, observed: Observation): string {
  const detail = observed.state === "running" ? "all services running again" : observed.detail;
  return `${HEALTH_LOG_PREFIX} at ${at.toISOString()}: ${detail}`;
}
