/**
 * Shared per-server Supavisor pooler — tenant register/deregister.
 *
 * Every instance's `db` joins POOLER_NETWORK under the alias `{project}-db`
 * (lib/provision/render.ts). This module is the other half: telling the one
 * shared Supavisor container on that server about a tenant, via its admin
 * HTTP API (`PUT`/`DELETE /api/tenants/:external_id` — see
 * templates/pooler/VERSIONS.md for the upstream API this targets).
 *
 * Reached with `curl` over the SSH connection the pipeline/teardown already
 * hold — `127.0.0.1:{POOLER_ADMIN_PORT}` from the managed server itself. The
 * admin API is published loopback-only (templates/pooler/docker-compose.yml)
 * and never called from the panel over the network.
 *
 * Once registered, a tenant is reached as
 * `postgres://postgres.{project}:{pgPassword}@{server host}:5432|6543/postgres`.
 */
import { SignJWT } from "jose";
import { POOLER_ADMIN_PORT } from "@/lib/bootstrap/constants";
import { ensurePoolerSecrets } from "@/lib/bootstrap/pooler-secrets";
import { exec } from "@/lib/ssh";

type SshConnection = Parameters<typeof exec>[0];

const ADMIN_BASE = `http://127.0.0.1:${POOLER_ADMIN_PORT}`;

/** Short-lived HS256 bearer the admin API verifies against API_JWT_SECRET. */
async function adminBearer(serverId: string): Promise<string> {
  const { apiJwtSecret } = await ensurePoolerSecrets(serverId);
  const key = new TextEncoder().encode(apiJwtSecret);
  return new SignJWT({ role: "service_role" })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(key);
}

/** Single-quote a value for embedding in the shell command below. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function curlCommand(method: "PUT" | "DELETE", url: string, bearer: string, body?: string): string {
  const parts = ["curl", "-fsS", "-X", method, "-H", shellQuote(`Authorization: Bearer ${bearer}`)];
  if (body !== undefined) {
    parts.push("-H", shellQuote("Content-Type: application/json"), "-d", shellQuote(body));
  }
  parts.push(shellQuote(url));
  return parts.join(" ");
}

export interface PoolerTenantInput {
  /** Owns this server's pooler secrets (lib/bootstrap/pooler-secrets.ts). */
  serverId: string;
  /** The instance's composeProjectName — both the Supavisor external_id and
   *  (via `{project}-db`) the network alias render.ts gave its `db` service. */
  project: string;
  /** This instance's own Postgres superuser password (already generated —
   *  no new secret needed just for the pooler). */
  pgPassword: string;
}

/**
 * `PUT /api/tenants/{project}` — idempotent create-or-update, safe to call
 * again on retry. Throws with the curl failure surfaced verbatim.
 */
export async function registerPoolerTenant(
  conn: SshConnection,
  input: PoolerTenantInput,
): Promise<void> {
  const bearer = await adminBearer(input.serverId);
  const body = JSON.stringify({
    tenant: {
      db_host: `${input.project}-db`,
      db_port: 5432,
      db_database: "postgres",
      default_pool_size: 15,
      default_max_clients: 200,
      users: [
        {
          db_user: "postgres",
          db_password: input.pgPassword,
          pool_size: 15,
          mode_type: "transaction",
          is_manager: true,
        },
      ],
    },
  });
  const res = await exec(
    conn,
    curlCommand("PUT", `${ADMIN_BASE}/api/tenants/${input.project}`, bearer, body),
  );
  if (res.code !== 0) {
    throw new Error(
      `Supavisor tenant registration failed (curl exit ${res.code}): ${(res.stderr || res.stdout).trim()}`,
    );
  }
}

/**
 * `DELETE /api/tenants/{project}`. Callers (lib/provision/teardown.ts) decide
 * whether a failure here should block removal — this function just performs
 * the call and throws on failure like {@link registerPoolerTenant} does.
 */
export async function deregisterPoolerTenant(
  conn: SshConnection,
  serverId: string,
  project: string,
): Promise<void> {
  const bearer = await adminBearer(serverId);
  const res = await exec(conn, curlCommand("DELETE", `${ADMIN_BASE}/api/tenants/${project}`, bearer));
  if (res.code !== 0) {
    throw new Error(
      `Supavisor tenant deregistration failed (curl exit ${res.code}): ${(res.stderr || res.stdout).trim()}`,
    );
  }
}
