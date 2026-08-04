/**
 * Route protection.
 *
 * PATTERN CHOICE — Auth.js v5 split config: importing lib/auth.ts here would
 * pull Prisma + bcryptjs into the middleware bundle, which breaks on the
 * edge runtime Next.js compiles middleware for. So we instantiate NextAuth
 * from the lean, edge-safe auth.config.ts (no providers / no DB) — enough to
 * verify the 'wharf.session' JWT cookie, which is all gating needs.
 *
 * Public: /login, /api/auth/* (NextAuth handlers + future forwardAuth
 * /api/auth/verify, which does its own session check), /api/healthz,
 * /dev/kit. Static assets (_next/*, favicon, files with extensions) are
 * excluded via the matcher below.
 */
import NextAuth from "next-auth";
import { NextResponse } from "next/server";
import authConfig from "@/auth.config";

const { auth } = NextAuth(authConfig);

/**
 * Content-Security-Policy, built at REQUEST time.
 *
 * It lives here rather than in next.config.ts `headers()` on purpose: that
 * hook is evaluated during `next build` and frozen into the routes manifest,
 * so a build that ran without INSTANCE_DOMAIN / NEXT_PUBLIC_GATEWAY_WS_URL
 * would ship a policy that blocks the Studio iframe and the terminal socket —
 * with no server-side error and nothing in the logs. Building it per request
 * means changing those settings takes a restart, not a rebuild.
 *
 * Two app-specific allowances:
 *  - frame-src permits the instance apex (the Manage view embeds each
 *    instance's Studio);
 *  - connect-src permits the Terminal Gateway's WebSocket origin.
 * frame-ancestors stays 'none': the panel embeds Studio, never the reverse.
 *
 * 'unsafe-inline'/'unsafe-eval' on script-src are required by Next's inlined
 * bootstrap and streaming RSC payloads — see docs/security-review.md §7.
 */
function contentSecurityPolicy(): string {
  const instanceDomain = process.env.INSTANCE_DOMAIN?.trim();
  // NEXT_PUBLIC_* values are inlined at BUILD time by Next even in server
  // code, so they cannot be changed by a restart. GATEWAY_WS_URL is the
  // server-side override; the NEXT_PUBLIC_ one remains the source for the
  // browser bundle and acts as the fallback here.
  const gatewayWs =
    process.env.GATEWAY_WS_URL?.trim() ||
    process.env.NEXT_PUBLIC_GATEWAY_WS_URL?.trim();

  const frameSrc = ["'self'"];
  if (instanceDomain) frameSrc.push(`https://*.${instanceDomain}`);

  const connectSrc = ["'self'"];
  if (gatewayWs) connectSrc.push(gatewayWs);
  else connectSrc.push("ws://localhost:*", "wss://localhost:*");

  return [
    "default-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `frame-src ${frameSrc.join(" ")}`,
    `connect-src ${connectSrc.join(" ")}`,
  ].join("; ");
}

/** Headers applied to every response this middleware returns. */
function withSecurityHeaders(res: NextResponse): NextResponse {
  res.headers.set("Content-Security-Policy", contentSecurityPolicy());
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  res.headers.set("X-Frame-Options", "DENY");
  res.headers.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=()",
  );
  res.headers.set(
    "Strict-Transport-Security",
    "max-age=31536000; includeSubDomains",
  );
  return res;
}

const PUBLIC_PATHS = [
  /^\/login$/,
  /^\/api\/auth(\/|$)/,
  /^\/api\/healthz$/,
  /^\/dev\/kit(\/|$)/,
  // Invite / password-set flow: reached by a user who has no session yet.
  // The token itself is the credential (single-use, 48h, hashed at rest).
  /^\/invite(\/|$)/,
  /^\/api\/users\/set-password$/,
  // Fetched by GoTrue itself (a machine, no session cookie) at container
  // startup to load a custom email template body — necessarily
  // unauthenticated, the same category of exception as /api/auth/verify.
  // Only ever returns template HTML, never any other instance field.
  /^\/api\/db-instances\/[^/]+\/email-template\/[^/]+$/,
  // Also called by GoTrue itself — the send-SMS hook, for providers
  // it has no native driver for. Unauthenticated for the same reason as the
  // route above, but NOT trusting the instance id: the route verifies a
  // standard-webhooks signature before it will send anything.
  /^\/api\/db-instances\/[^/]+\/sms-hook$/,
  // Integration guides. Public on purpose: the person doing an
  // MSG91/DLT setup is often at a client or an agency and has no WHARF
  // account. Static content only — nothing under /docs reads an instance,
  // a setting or a secret.
  /^\/docs(\/|$)/,
];

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Same-origin guard for state-changing API calls.
 *
 * The session cookie is SameSite=lax, which already blocks cross-site POSTs
 * from most contexts; this is defence in depth against the cases lax does not
 * cover (and against future cookie-policy drift).
 *
 * Browsers always send Sec-Fetch-Site, and send Origin on non-GET requests —
 * so a cross-site request is recognisable and refused. Non-browser clients
 * (curl, scripts) send neither and are allowed through: they would need a
 * stolen session cookie to get this far, which CSRF protection does not
 * address anyway.
 */
function isCrossSite(req: Request, selfOrigin: string): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site) return site !== "same-origin" && site !== "none";
  const origin = req.headers.get("origin");
  if (origin) return origin !== selfOrigin;
  return false;
}

export default auth((req) => {
  const { pathname, search } = req.nextUrl;
  const signedIn = !!req.auth;

  if (
    pathname.startsWith("/api/") &&
    !SAFE_METHODS.has(req.method) &&
    isCrossSite(req, req.nextUrl.origin)
  ) {
    return withSecurityHeaders(
      NextResponse.json({ error: "Cross-origin request refused." }, { status: 403 }),
    );
  }

  // Already signed in on /login → straight to the app.
  if (signedIn && pathname === "/login") {
    return withSecurityHeaders(
      NextResponse.redirect(new URL("/databases", req.nextUrl)),
    );
  }

  if (signedIn || PUBLIC_PATHS.some((re) => re.test(pathname))) {
    return withSecurityHeaders(NextResponse.next());
  }

  const loginUrl = new URL("/login", req.nextUrl);
  loginUrl.searchParams.set("returnTo", pathname + search);
  return withSecurityHeaders(NextResponse.redirect(loginUrl));
});

export const config = {
  // Skip Next internals, favicon and anything with a static-asset extension.
  matcher: [
    "/((?!_next/|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|map|txt|xml|woff2?)$).*)",
  ],
};
