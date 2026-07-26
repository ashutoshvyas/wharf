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
