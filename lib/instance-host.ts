/**
 * True when `hostname` is a WHARF-managed instance subdomain: under
 * INSTANCE_DOMAIN and not the panel's own host.
 *
 * Shared by the forwardAuth gate (app/api/auth/verify/route.ts) and
 * the login flow's returnTo handling (app/(auth)/actions.ts,
 * auth.config.ts): both need to trust a cross-origin redirect target
 * pointing at Studio (studio-{slug}.INSTANCE_DOMAIN is a different origin
 * than the panel) without that becoming a general-purpose open redirect.
 * Anything that isn't under our own apex, or that IS the panel's own host,
 * is refused — the panel never legitimately needs to redirect anywhere else.
 */
export function isTrustedInstanceHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  const apex = (process.env.INSTANCE_DOMAIN ?? "").trim().toLowerCase();
  if (!apex || !(host === apex || host.endsWith(`.${apex}`))) return false;

  let panelHost = "";
  try {
    panelHost = new URL(process.env.PANEL_URL ?? "").hostname.toLowerCase();
  } catch {
    panelHost = "";
  }
  return host !== panelHost;
}
