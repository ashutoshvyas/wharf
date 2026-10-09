/**
 * Database-instance row → API payload serializer.
 *
 * SECURITY: explicit ALLOWLIST, exactly the shape in
 * docs/provisioning-contract.md §1. The encrypted columns
 * (`pgPasswordEnc`, `anonKeyEnc`, `serviceRoleKeyEnc`, `jwtSecretEnc`) and any
 * decrypted value MUST NEVER appear here — key material is returned only by
 * the audited reveal endpoint (GET /api/db-instances/:id/secrets).
 *
 * `deletedAt` is deliberately absent too: soft-deleted rows are filtered out
 * before serialization (excluded from lists, 404 on read), so the wire shape
 * never has to express "removed".
 *
 * `activeJob` is the one DERIVED field: `status` alone no longer
 * identifies which engine is running, because restore.ts, sync.ts and clone.ts share
 * the `restoring` status but stream under different job ids. The fleet card
 * needs to know which log to follow, so the job registry (in-process, same
 * argument as lib/rate-limit.ts) is consulted here. `null` means no live job
 * in THIS process — after a panel restart that is also the honest answer,
 * and lib/instances/recovery.ts sweeps such rows into `error`.
 */
import { isJobActive } from "@/lib/jobs/stream";
import {
  cloneJobId,
  provisionJobId,
  removeJobId,
  restoreJobId,
  syncJobId,
} from "@/lib/provision/job-ids";
import type { InstanceSslMode } from "./ssl-mode";

/**
 * Prisma `include` matching the embedded `server` ref below — shared by every
 * /api/db-instances handler so list/detail/action responses are shaped alike.
 * Lives here (not in a route file) because App Router route modules may only
 * export handlers and route config.
 */
export const INSTANCE_INCLUDE = {
  server: { select: { id: true, name: true, host: true } },
} as const;

interface ServerRef {
  id: string;
  name: string;
  host: string;
}

/**
 * Structural input type — a Prisma `DbInstance` row, optionally with the
 * `server` relation included. Extra fields (including the *Enc columns) are
 * accepted and ignored.
 */
export interface DbInstanceRecord {
  id: string;
  name: string;
  slug: string;
  serverId: string;
  composeProjectName: string;
  remotePath: string;
  apiSubdomain: string;
  studioSubdomain: string;
  sslMode: InstanceSslMode;
  cpuLimit: number | null;
  memoryLimitMb: number | null;
  resourceLimitsAppliedAt: Date | null;
  resourceLimitsError: string | null;
  status: string;
  lastActionLog: string | null;
  healthCheckedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  server?: ServerRef | null;
}

/** Which engine currently holds a live job for this instance. */
export type ActiveJobKind = "provision" | "remove" | "restore" | "sync" | "clone";

const JOB_KINDS: readonly [ActiveJobKind, (id: string) => string][] = [
  ["provision", provisionJobId],
  ["remove", removeJobId],
  ["restore", restoreJobId],
  ["sync", syncJobId],
  ["clone", cloneJobId],
];

export function activeJobKind(instanceId: string): ActiveJobKind | null {
  for (const [kind, jobId] of JOB_KINDS) {
    if (isJobActive(jobId(instanceId))) return kind;
  }
  return null;
}

export interface SerializedDbInstance {
  id: string;
  name: string;
  slug: string;
  serverId: string;
  composeProjectName: string;
  remotePath: string;
  apiSubdomain: string;
  studioSubdomain: string;
  sslMode: InstanceSslMode;
  /** Whole-instance budget; null = unlimited (lib/instances/resource-limits.ts). */
  cpuLimit: number | null;
  memoryLimitMb: number | null;
  /** Null until the server confirms the budget — see resourceLimitsError for why not. */
  resourceLimitsAppliedAt: string | null;
  resourceLimitsError: string | null;
  status: string;
  lastActionLog: string | null;
  healthCheckedAt: string | null;
  createdAt: string;
  updatedAt: string;
  activeJob: ActiveJobKind | null;
  server?: ServerRef;
}

export function serializeInstance(
  instance: DbInstanceRecord,
): SerializedDbInstance {
  const out: SerializedDbInstance = {
    id: instance.id,
    name: instance.name,
    slug: instance.slug,
    serverId: instance.serverId,
    composeProjectName: instance.composeProjectName,
    remotePath: instance.remotePath,
    apiSubdomain: instance.apiSubdomain,
    studioSubdomain: instance.studioSubdomain,
    sslMode: instance.sslMode,
    cpuLimit: instance.cpuLimit,
    memoryLimitMb: instance.memoryLimitMb,
    resourceLimitsAppliedAt: instance.resourceLimitsAppliedAt?.toISOString() ?? null,
    resourceLimitsError: instance.resourceLimitsError,
    status: instance.status,
    lastActionLog: instance.lastActionLog ?? null,
    healthCheckedAt: instance.healthCheckedAt
      ? instance.healthCheckedAt.toISOString()
      : null,
    createdAt: instance.createdAt.toISOString(),
    updatedAt: instance.updatedAt.toISOString(),
    activeJob: activeJobKind(instance.id),
  };
  // `server` is embedded only when the relation was actually included —
  // omitted (not null) otherwise, per contract §1 ("when included").
  if (instance.server != null) {
    out.server = { id: instance.server.id, name: instance.server.name, host: instance.server.host };
  }
  return out;
}
