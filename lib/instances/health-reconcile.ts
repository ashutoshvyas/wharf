/**
 * Periodic instance health check — keeps each instance's stored status in
 * line with what is actually running on its server.
 *
 * Status was otherwise only ever written by WHARF's own jobs, so containers
 * stopped, crashed or removed outside the panel kept showing `running`. Every
 * interval this runs ONE read-only `docker ps -a` per server and classifies
 * each instance (lib/instances/health-observe.ts): all services up →
 * `running`; all stopped → `stopped`; partial, crash-looping, unhealthy,
 * missing, or server unreachable → `error`, with the reason in
 * `lastActionLog` (so "View log" explains it, and Retry repairs it).
 *
 * Deliberately conservative:
 *  - a status changes only after {@link CONFIRMATIONS} consecutive passes
 *    agree, so a restart in progress or one dropped SSH session never flaps it;
 *  - servers with a held lock and instances with a live job are skipped — the
 *    job owns their status;
 *  - the write is conditional on the row being unchanged since it was read,
 *    so a Stop/Start that lands mid-check always wins;
 *  - an `error` set by a job (failed provision/restore/clone) is never
 *    touched — see nextStatus().
 *
 * In-process like the job registry: the panel runs as one pm2 fork process.
 */
import type { InstanceStatus } from "@prisma/client";
import { audit } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { serverLockHolder } from "@/lib/jobs/lock";
import { instanceServices } from "@/lib/provision/render";
import { exec, withConnection } from "@/lib/ssh";
import {
  DOCKER_PS_FORMAT,
  healthLog,
  nextStatus,
  observeInstance,
  parseDockerPs,
  type ContainerState,
  type InstanceServices,
  type Observation,
} from "./health-observe";
import { activeJobKind } from "./serialize";

export const DEFAULT_HEALTH_INTERVAL_MS = 60_000;
/** Floor for HEALTH_CHECK_INTERVAL_MS — each pass opens one SSH session per server. */
const MIN_HEALTH_INTERVAL_MS = 15_000;
/** Consecutive identical observations required before a status changes. */
export const CONFIRMATIONS = 2;
const PROBE_TIMEOUT_MS = 20_000;

/** instanceId → a status change seen on earlier passes, awaiting confirmation. */
const pending = new Map<string, { target: string; count: number }>();

type Row = {
  id: string;
  serverId: string;
  composeProjectName: string;
  status: InstanceStatus;
  lastActionLog: string | null;
  updatedAt: Date;
};

/** One pass over every settled instance. Exported for tests and manual runs. */
export async function runHealthCheck(now: Date = new Date()): Promise<void> {
  const rows: Row[] = await prisma.dbInstance.findMany({
    where: { deletedAt: null, status: { in: ["running", "stopped", "error"] } },
    select: {
      id: true,
      serverId: true,
      composeProjectName: true,
      status: true,
      lastActionLog: true,
      updatedAt: true,
    },
  });

  const seen = new Set(rows.map((r) => r.id));
  for (const id of pending.keys()) if (!seen.has(id)) pending.delete(id);
  if (rows.length === 0) return;

  const byServer = new Map<string, Row[]>();
  for (const row of rows) byServer.set(row.serverId, [...(byServer.get(row.serverId) ?? []), row]);

  const services = await instanceServices();
  const results = await Promise.allSettled(
    [...byServer].map(([serverId, serverRows]) => checkServer(serverId, serverRows, services, now)),
  );
  for (const r of results) {
    if (r.status === "rejected") console.error("[health] server check failed:", r.reason);
  }
}

async function listContainers(serverId: string): Promise<ContainerState[]> {
  const res = await withConnection(serverId, (conn) =>
    exec(
      conn,
      `docker ps -a --filter label=com.docker.compose.project --format '${DOCKER_PS_FORMAT}'`,
      { timeoutMs: PROBE_TIMEOUT_MS },
    ),
  );
  if (res.code !== 0) {
    throw new Error(`docker ps failed (code ${res.code}): ${res.stderr.trim() || "no output"}`);
  }
  return parseDockerPs(res.stdout);
}

async function checkServer(
  serverId: string,
  rows: Row[],
  services: InstanceServices,
  now: Date,
): Promise<void> {
  if (serverLockHolder(serverId)) return;

  let containers: ContainerState[] = [];
  let unreachable: string | null = null;
  try {
    containers = await listContainers(serverId);
  } catch (err) {
    unreachable = err instanceof Error ? err.message : String(err);
  }
  // A job that started while we were looking owns the outcome.
  if (serverLockHolder(serverId)) return;

  const healthy: string[] = [];
  for (const row of rows) {
    if (activeJobKind(row.id)) {
      pending.delete(row.id);
      continue;
    }
    const observed: Observation = unreachable
      ? { state: "unreachable", detail: `server unreachable — ${unreachable}` }
      : observeInstance(
          containers.filter((c) => c.project === row.composeProjectName),
          services,
        );
    if (observed.state === "running") healthy.push(row.id);

    const target = nextStatus(row, observed);
    if (!target) {
      pending.delete(row.id);
      continue;
    }
    const prior = pending.get(row.id);
    const count = prior?.target === target ? prior.count + 1 : 1;
    if (count < CONFIRMATIONS) {
      pending.set(row.id, { target, count });
      continue;
    }
    pending.delete(row.id);

    const { count: changed } = await prisma.dbInstance.updateMany({
      where: { id: row.id, status: row.status, updatedAt: row.updatedAt },
      data: { status: target, lastActionLog: healthLog(now, observed) },
    });
    if (changed === 0) continue;
    console.warn(`[health] ${row.composeProjectName}: ${row.status} → ${target} (${observed.detail})`);
    await audit({
      action: "instance.health.status-change",
      targetType: "db_instance",
      targetId: row.id,
      metadata: { from: row.status, to: target, detail: observed.detail },
    }).catch((err: unknown) => console.error("[health] failed to write audit row:", err));
  }

  if (healthy.length > 0) {
    await prisma.dbInstance.updateMany({
      where: { id: { in: healthy } },
      data: { healthCheckedAt: now },
    });
  }
}

let timer: ReturnType<typeof setInterval> | undefined;
let inFlight = false;

/**
 * Start the periodic check (once per process). HEALTH_CHECK_INTERVAL_MS
 * overrides the 60s default; 0 disables it.
 */
export function startHealthReconciler(): void {
  if (timer) return;
  const raw = process.env.HEALTH_CHECK_INTERVAL_MS;
  const interval = raw === undefined || raw === "" ? DEFAULT_HEALTH_INTERVAL_MS : Number(raw);
  if (!Number.isFinite(interval) || interval <= 0) {
    console.info("[health] periodic instance health check disabled");
    return;
  }
  timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    runHealthCheck()
      .catch((err: unknown) => console.error("[health] check failed:", err))
      .finally(() => {
        inFlight = false;
      });
  }, Math.max(interval, MIN_HEALTH_INTERVAL_MS));
  timer.unref?.();
}

/** Test seam: forget pending confirmations between tests. */
export function __resetHealthState(): void {
  pending.clear();
}
