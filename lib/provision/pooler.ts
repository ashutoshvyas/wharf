/**
 * Shared per-server Supavisor pooler — tenant register/deregister.
 *
 * Every instance's `db` joins POOLER_NETWORK under the alias
 * `poolerDbAlias(project)` (lib/provision/naming.ts, used by both
 * lib/provision/render.ts and this file so they can never drift out of
 * sync). This module is the other half: telling the one
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
import { poolerDbAlias } from "./naming";

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

/**
 * Deliberately NOT `curl -f`: that flag discards the response body on a 4xx/5xx,
 * which is exactly the text Supavisor's admin API explains itself with (its
 * `TenantController` renders `{"error": "..."}` for every 400/404/422). `-w`
 * appends the HTTP status on its own trailing line so {@link parseCurlOutput}
 * can split it back out and surface Supavisor's own message instead of a bare
 * "curl exit 22".
 */
function curlCommand(method: "PUT" | "DELETE", url: string, bearer: string, body?: string): string {
  const parts = [
    "curl",
    "-sS",
    "-w",
    // Literal two-char `\n` — curl's own -w format-string parser converts
    // it to a newline; an embedded raw newline byte here would rely on
    // unspecified passthrough behavior instead of curl's documented escape.
    shellQuote("\\n%{http_code}"),
    "-X",
    method,
    "-H",
    shellQuote(`Authorization: Bearer ${bearer}`),
  ];
  if (body !== undefined) {
    parts.push("-H", shellQuote("Content-Type: application/json"), "-d", shellQuote(body));
  }
  parts.push(shellQuote(url));
  return parts.join(" ");
}

/** Split curl's `-w '\n%{http_code}'`-suffixed stdout back into body + status. */
function parseCurlOutput(stdout: string): { httpCode: number; body: string } {
  const idx = stdout.lastIndexOf("\n");
  if (idx < 0) return { httpCode: Number(stdout.trim()) || 0, body: "" };
  return { httpCode: Number(stdout.slice(idx + 1).trim()) || 0, body: stdout.slice(0, idx) };
}

/** Throws with Supavisor's own error body when curl ran but the HTTP call didn't 2xx. */
function assertOk(
  action: string,
  res: { code: number | null; stdout: string; stderr: string },
  opts: { allow404?: boolean } = {},
): void {
  if (res.code !== 0) {
    throw new Error(`Supavisor ${action} failed (curl exit ${res.code}): ${(res.stderr || res.stdout).trim()}`);
  }
  const { httpCode, body } = parseCurlOutput(res.stdout);
  if (httpCode === 404 && opts.allow404) return; // already gone — not a failure
  if (httpCode < 200 || httpCode >= 300) {
    throw new Error(`Supavisor ${action} failed (HTTP ${httpCode}): ${body.trim() || "(empty response body)"}`);
  }
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
      db_host: poolerDbAlias(input.project),
      db_port: 5432,
      db_database: "postgres",
      // Required by Supavisor's own tenant changeset (`validate_required` in
      // Supavisor.Tenants.Tenant) — omitting it makes tenant creation 400.
      // `{}` is exactly what Supavisor's own seeds use for a plain tenant.
      default_parameter_status: {},
      // WHARF already knows this tenant's real Postgres password (it's the
      // instance's own generated pgPassword) — require_user tells Supavisor
      // to validate a connecting client's credentials directly against the
      // `users` entry below. Without it, Supavisor instead tries to verify
      // the manager user via an `auth_query` we never configured, which
      // fails and is the other half of why tenant creation 400ed.
      require_user: true,
      // wharf-pooler is an IPv4-only Docker bridge network; without this,
      // Supavisor's own IP-version auto-detection falls back to a guess
      // whenever it can't resolve db_host (see poolerDbAlias's doc comment —
      // the alias must never contain an underscore for exactly this reason).
      ip_version: "v4",
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
  assertOk("tenant registration", res);
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
  // A 404 means it's already gone (e.g. a retried teardown) — not a failure.
  assertOk("tenant deregistration", res, { allow404: true });
}
