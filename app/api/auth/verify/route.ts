/**
 * GET /api/auth/verify — the forwardAuth endpoint Traefik calls
 * before letting a request reach an instance's Studio container.
 *
 * Flow (architecture §4.5):
 *   browser → https://studio-{slug}.{domain}
 *     → Traefik `wharf-auth@file` middleware → GET here, forwarding the
 *       browser's headers (including the wharf.session cookie)
 *     → 200  ⇒ Traefik passes the request through to Studio
 *     → 401  ⇒ Traefik returns our response; the Location header sends the
 *              user to the panel login with a returnTo back to Studio.
 *
 * PERFORMANCE: this fires on EVERY Studio request — html, js chunks, fonts,
 * API calls. It therefore does pure JWE verification with no database access
 * (the role travels in the session token, see auth.config.ts callbacks).
 *
 * COOKIE DOMAIN: the browser only sends `wharf.session` to studio-*.domain
 * when COOKIE_DOMAIN is the shared apex (e.g. ".wharf.example.com"). Without that
 * this endpoint correctly sees no cookie and denies everything — which is
 * why configuration validation checks the setting at boot.
 *
 * SECURITY: fail closed. Any parse/verify/role problem is a 401; the token
 * value is never logged, and no decoded claim other than the email is echoed
 * (as X-Wharf-User, which Traefik is configured to forward to Studio).
 */
import { decode } from "@auth/core/jwt";
import { isTrustedInstanceHost } from "@/lib/instance-host";
import { can, type Role } from "@/lib/rbac";

/** Both names Auth.js may have issued the session cookie under. */
const COOKIE_NAMES = ["wharf.session", "__Secure-wharf.session"] as const;

export const dynamic = "force-dynamic";

function parseCookies(header: string | null): Map<string, string> {
  const jar = new Map<string, string>();
  if (!header) return jar;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 1) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name) jar.set(name, decodeURIComponent(value));
  }
  return jar;
}

/**
 * Rebuild the URL the user actually asked for from Traefik's forwarded
 * headers, so login can bounce them back to Studio afterwards.
 *
 * SECURITY: x-forwarded-host/-uri reach us over two hops (Traefik's
 * forwardAuth subrequest, then the panel's own reverse proxy in front of
 * this app) — either one could hand us an attacker- or misconfiguration-
 * supplied value, and this feeds straight into a Location header. Trust it
 * only when the host is under our own INSTANCE_DOMAIN apex and isn't the
 * panel's own host (the panel never legitimately reaches this endpoint via
 * forwardAuth — only instance subdomains, studio- prefixed or bare, do);
 * anything else is dropped rather than trusted, so this can never become an
 * open redirect.
 * (Found live: a reverse proxy in front of the panel unconditionally
 * rewrote x-forwarded-host to its own $host before this route ever saw it,
 * producing a returnTo that pointed at the panel's own root instead of the
 * Studio subdomain the visitor actually asked for.)
 */
function originalUrl(req: Request): string | null {
  const h = req.headers;
  const host = h.get("x-forwarded-host") ?? h.get("x-forwarded-server");
  if (!host) return null;

  const hostname = host.split(":")[0]!.toLowerCase();
  if (!isTrustedInstanceHost(hostname)) return null;

  const proto = h.get("x-forwarded-proto") ?? "https";
  const uri = h.get("x-forwarded-uri") ?? "/";
  return `${proto}://${host}${uri}`;
}

function deny(req: Request): Response {
  const panelUrl = (process.env.PANEL_URL ?? "").replace(/\/+$/, "");
  const target = originalUrl(req);
  const headers = new Headers({ "Cache-Control": "no-store" });
  if (panelUrl) {
    const login = new URL(`${panelUrl}/login`);
    if (target) login.searchParams.set("returnTo", target);
    headers.set("Location", login.toString());
    // Traefik relays our response verbatim on a non-2xx, so this is what the
    // browser actually receives — and a Location header only triggers
    // navigation on a 3xx status. A 401 here (confirmed live) just renders as
    // a bare "401 Unauthorized" page with the Location silently ignored; 302
    // is a non-2xx (still a deny, as far as forwardAuth is concerned) that
    // browsers do act on.
    return new Response(null, { status: 302, headers });
  }
  // No PANEL_URL configured — nowhere to send them, so there's nothing a
  // redirect would achieve.
  return new Response(null, { status: 401, headers });
}

export async function GET(req: Request): Promise<Response> {
  const secret = process.env.NEXTAUTH_SECRET ?? process.env.AUTH_SECRET;
  if (!secret) return deny(req);

  const jar = parseCookies(req.headers.get("cookie"));

  // Auth.js derives the JWE key from (secret, salt) where the salt is the
  // cookie NAME — so decode with whichever name carried the token.
  let token: string | undefined;
  let salt: string | undefined;
  for (const name of COOKIE_NAMES) {
    const value = jar.get(name);
    if (value) {
      token = value;
      salt = name;
      break;
    }
  }
  if (!token || !salt) return deny(req);

  try {
    const jwt = await decode({ token, secret, salt });
    const role = jwt?.role as Role | undefined;
    // Studio is a management surface: viewers are read-only in the panel and
    // must not reach it (they could mutate data through it).
    if (!jwt || !role || !can(role, "secrets.reveal")) return deny(req);

    const headers = new Headers({ "Cache-Control": "no-store" });
    const email = typeof jwt.email === "string" ? jwt.email : "";
    if (email) headers.set("X-Wharf-User", email);
    return new Response(null, { status: 200, headers });
  } catch {
    // Expired, tampered, or signed with a different secret — all fail closed.
    return deny(req);
  }
}
