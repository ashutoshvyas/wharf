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

/** Shared external Docker network joining Traefik and every instance. */
export const TRAEFIK_NETWORK = "traefik";

/** Remote directory holding the Traefik compose + config on managed servers. */
export const TRAEFIK_REMOTE_DIR = "/opt/wharf/traefik";
