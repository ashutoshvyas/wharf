import type { DbInstance } from "@prisma/client";
import { prisma } from "@/lib/db";
import { open } from "@/lib/crypto";
import { serverLockHolder, tryAcquireServerLock } from "@/lib/jobs/lock";
import { withConnection } from "@/lib/ssh";
import { installNetworkFirewall } from "@/lib/bootstrap/network-firewall";
import {
  DEFAULT_NETWORK_ACCESS, networkAccessSchema, readNetworkAccess,
  type NetworkAccessDto, type NetworkAccessPolicy, type NetworkAccessResult,
} from "@/lib/instances/network-access";
import { assertPoolerNetworkPolicy, readPoolerNetworkState, registerPoolerTenant } from "./pooler";

type Connection = Parameters<Parameters<typeof withConnection>[1]>[0];
type MutationResult = ({ ok: true } & NetworkAccessResult) | { notFound: true } | { busy: string } | { invalid: string };
const PENDING = "Saved settings have not been applied yet.";
const APPLY_FAILED = "Could not apply and verify these settings on the database server. The previous policy may still be active. Check server connectivity and retry.";

export async function getInstanceNetworkAccess(id: string): Promise<NetworkAccessDto | null> {
  const row = await prisma.dbInstance.findFirst({
    where: { id, deletedAt: null },
    include: { server: { select: { id: true, name: true, poolerFirewallManaged: true } } },
  });
  if (!row) return null;
  const siblings = await prisma.dbInstance.findMany({
    where: { serverId: row.serverId, deletedAt: null },
    select: { id: true, name: true, networkAccess: true },
    orderBy: { name: "asc" },
  });
  return {
    policy: readNetworkAccess(row.networkAccess),
    appliedAt: row.networkAccessAppliedAt?.toISOString() ?? null,
    applyError: row.networkAccessError,
    server: {
      id: row.server.id, name: row.server.name, firewallManaged: row.server.poolerFirewallManaged,
      unconfiguredInstances: siblings.filter((sibling) => sibling.networkAccess === null)
        .map(({ id, name }) => ({ id, name })),
    },
  };
}

function canApply(row: DbInstance, policy: NetworkAccessPolicy): string | null {
  if (!["running", "stopped", "error"].includes(row.status)) {
    return "Wait for the current database operation to finish before changing network access.";
  }
  if (policy.mode !== "blocked" && !row.pgPasswordEnc) {
    return `Finish provisioning ${row.name} before allowing database connections.`;
  }
  return null;
}

async function applyPolicy(conn: Connection, row: DbInstance, policy: NetworkAccessPolicy) {
  await registerPoolerTenant(conn, {
    serverId: row.serverId, project: row.composeProjectName,
    pgPassword: policy.mode === "blocked" ? "" : open(row.pgPasswordEnc!),
    sslMode: row.sslMode, networkAccess: policy,
  });
  assertPoolerNetworkPolicy(await readPoolerNetworkState(conn), row.composeProjectName, policy);
  await prisma.dbInstance.update({ where: { id: row.id }, data: {
    networkAccessAppliedAt: new Date(), networkAccessError: null,
  } });
}

/** Persist intent first so retries/provision/TLS changes never silently restore old access. */
export async function updateInstanceNetworkAccess(id: string, input: NetworkAccessPolicy): Promise<MutationResult> {
  const policy = networkAccessSchema.parse(input);
  const ref = await prisma.dbInstance.findFirst({ where: { id, deletedAt: null }, select: { serverId: true } });
  if (!ref) return { notFound: true };
  const release = tryAcquireServerLock(ref.serverId, "network-access");
  if (!release) return { busy: serverLockHolder(ref.serverId) ?? "another job" };
  try {
    // Re-read under the lock: a settings request must not use a stale policy.
    const row = await prisma.dbInstance.findFirst({ where: { id, deletedAt: null } });
    if (!row) return { notFound: true };
    const invalid = canApply(row, policy);
    if (invalid) return { invalid };
    await prisma.dbInstance.update({ where: { id }, data: {
      networkAccess: policy, networkAccessAppliedAt: null, networkAccessError: PENDING,
    } });
    try {
      await withConnection(ref.serverId, (conn) => applyPolicy(conn, row, policy));
      return { ok: true, applied: true };
    } catch {
      // SSH/pooler exceptions can embed credentials; neither log nor return them.
      await prisma.dbInstance.update({ where: { id }, data: { networkAccessError: APPLY_FAILED } });
      return { ok: true, applied: false, applyError: APPLY_FAILED };
    }
  } finally {
    release();
  }
}

/** Explicit one-time adoption of the SHARED host path, after all tenants are protected. */
export async function enableServerNetworkAccess(
  serverId: string, confirmName: string, baselineAllowedCidrs: string[],
): Promise<MutationResult> {
  const baseline: NetworkAccessPolicy = baselineAllowedCidrs.length
    ? networkAccessSchema.parse({ mode: "restricted", allowedCidrs: baselineAllowedCidrs })
    : DEFAULT_NETWORK_ACCESS;
  const release = tryAcquireServerLock(serverId, "network-access-setup");
  if (!release) return { busy: serverLockHolder(serverId) ?? "another job" };
  try {
    const server = await prisma.server.findUnique({ where: { id: serverId } });
    if (!server) return { notFound: true };
    if (confirmName !== server.name) return { invalid: "The server name does not match." };
    const rows = await prisma.dbInstance.findMany({ where: { serverId, deletedAt: null }, orderBy: { id: "asc" } });
    if (!rows.length) return { invalid: "Add a database to this server first." };
    const policies = rows.map((row) => row.networkAccess == null ? baseline : readNetworkAccess(row.networkAccess));
    for (const [index, row] of rows.entries()) {
      const invalid = canApply(row, policies[index]!);
      if (invalid) return { invalid };
    }
    let failure = "Could not prepare the database server. Check its connection and retry setup.";
    try {
      await withConnection(serverId, async (conn) => {
        const known = new Set(rows.map((row) => row.composeProjectName));
        const unknown = (await readPoolerNetworkState(conn)).filter((row) => !known.has(row.external_id));
        if (unknown.length) {
          failure = "The shared pooler contains databases that WHARF does not manage. Resolve those tenants before enabling server network access.";
          throw new Error(failure);
        }

        // Null legacy policies alone inherit the reviewed baseline. Existing
        // explicit per-instance choices survive setup/retries unchanged.
        await prisma.$transaction(rows.map((row, index) => prisma.dbInstance.update({
          where: { id: row.id },
          data: { networkAccess: policies[index]!, networkAccessAppliedAt: null, networkAccessError: PENDING },
        })));
        failure = "Database policies were saved, but not all could be applied. The shared firewall was not enabled. Retry setup after checking the server.";
        for (const [index, row] of rows.entries()) await applyPolicy(conn, row, policies[index]!);

        // Check the entire pooler immediately before granting the shared path.
        const live = await readPoolerNetworkState(conn);
        if (live.some((row) => !known.has(row.external_id))) throw new Error("Unknown tenant");
        for (const [index, row] of rows.entries()) assertPoolerNetworkPolicy(live, row.composeProjectName, policies[index]!);
        failure = "Database policies are applied, but the host firewall setup did not finish. This requires systemd and Docker's DOCKER-USER chain. Retry setup; cloud-provider firewalls must be configured separately.";
        await installNetworkFirewall(conn);
        failure = "Database policies and the firewall were applied, but WHARF could not record completion. Retry setup to verify it.";
        await prisma.server.update({ where: { id: serverId }, data: { poolerFirewallManaged: true } });
      });
      return { ok: true, applied: true };
    } catch {
      return { ok: true, applied: false, applyError: failure };
    }
  } finally {
    release();
  }
}
