/**
 * Bootstrap constants — shared names for everything the Traefik
 * artifacts establish on a managed server. Provisioning imports
 * these when rendering Supabase compose labels so the router middleware and
 * network names can never drift from what bootstrap deployed.
 */

/**
 * Traefik middleware reference for gating Studio routers
 * (`traefik.http.routers.<r>.middlewares=wharf-auth@file`). Defined by
 * templates/traefik/dynamic/wharf-auth.yml via the file provider.
 */
export const WHARF_AUTH_MIDDLEWARE = "wharf-auth@file";

/**
 * Traefik middleware that lets the panel embed Studio in an iframe
 * (components/databases/manage-view.tsx, spec §6.3). Self-hosted Studio ships
 * its own frame-blocking headers (X-Frame-Options / CSP frame-ancestors
 * 'none') by default — confirmed live: without this, the browser blocks the
 * embed with "Framing '<studio url>' violates ... frame-ancestors 'none'".
 * Defined by templates/traefik/dynamic/wharf-auth.yml via the file provider,
 * chained onto the studio router alongside WHARF_AUTH_MIDDLEWARE.
 */
export const WHARF_STUDIO_FRAME_MIDDLEWARE = "wharf-studio-frame@file";

/** Shared external Docker network joining Traefik and every instance. */
export const TRAEFIK_NETWORK = "traefik";

/** Remote directory holding the Traefik compose + config on managed servers. */
export const TRAEFIK_REMOTE_DIR = "/opt/wharf/traefik";

/**
 * Shared external Docker network joining the one per-server Supavisor pooler
 * and every instance's `db` service. Only `db` joins this network (never
 * kong/studio), and Supavisor's own metadata
 * Postgres stays off it entirely (see templates/pooler/docker-compose.yml) —
 * but every tenant `db` on a server does now share one Docker network with
 * every other tenant's `db`, which the design doc calls out explicitly as a
 * narrowed (not eliminated) version of the "Postgres unreachable from other
 * tenants" invariant `lib/provision/render.ts` otherwise guarantees: reaching
 * another tenant's `db` container still requires that tenant's own Postgres
 * credentials, which a peer container never has.
 */
export const POOLER_NETWORK = "wharf-pooler";

/** Remote directory holding the shared pooler's compose + config. */
export const POOLER_REMOTE_DIR = "/opt/wharf/pooler";

/** Host ports the shared pooler publishes — session mode and transaction mode. */
export const POOLER_SESSION_PORT = 5432;
export const POOLER_TRANSACTION_PORT = 6543;

/** Supavisor's admin HTTP API — bound to loopback only, never published publicly. */
export const POOLER_ADMIN_PORT = 4000;
