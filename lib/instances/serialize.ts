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
 */

/**
 * Prisma `include` matching the embedded `server` ref below — shared by every
 * /api/db-instances handler so list/detail/action responses are shaped alike.
 * Lives here (not in a route file) because App Router route modules may only
 * export handlers and route config.
 */
export const INSTANCE_INCLUDE = {
  server: { select: { id: true, name: true } },
} as const;

interface ServerRef {
  id: string;
  name: string;
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
  status: string;
  lastActionLog: string | null;
  healthCheckedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  server?: ServerRef | null;
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
  status: string;
  lastActionLog: string | null;
  healthCheckedAt: string | null;
  createdAt: string;
  updatedAt: string;
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
    status: instance.status,
    lastActionLog: instance.lastActionLog ?? null,
    healthCheckedAt: instance.healthCheckedAt
      ? instance.healthCheckedAt.toISOString()
      : null,
    createdAt: instance.createdAt.toISOString(),
    updatedAt: instance.updatedAt.toISOString(),
  };
  // `server` is embedded only when the relation was actually included —
  // omitted (not null) otherwise, per contract §1 ("when included").
  if (instance.server != null) {
    out.server = { id: instance.server.id, name: instance.server.name };
  }
  return out;
}
