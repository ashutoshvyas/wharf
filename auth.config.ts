/**
 * Shared (edge-safe) Auth.js v5 config — the "split config" half.
 *
 * middleware.ts must run on the edge runtime, where Prisma and bcryptjs
 * cannot load. This file therefore contains everything EXCEPT the
 * Credentials provider's authorize() (which hits the DB): session strategy,
 * cookie shape, JWT/session callbacks, pages. lib/auth.ts spreads this and
 * adds the provider; middleware.ts instantiates NextAuth from this file
 * alone — enough to verify the session JWT cookie.
 *
 * COOKIE DOMAIN (architecture §4.5): in production COOKIE_DOMAIN must be
 * the apex (e.g. ".wharf.example.com") so Traefik forwardAuth on studio-*.domain
 * receives the panel session cookie. Empty/unset → host-only cookie (dev).
 */
import type { NextAuthConfig } from "next-auth";

const useSecureCookies = (process.env.NEXTAUTH_URL ?? "").startsWith("https");

export default {
  // Auth.js v5 reads AUTH_SECRET by default; we standardized on
  // NEXTAUTH_SECRET in .env.example (shared with the gateway), so wire it
  // explicitly.
  secret: process.env.NEXTAUTH_SECRET ?? process.env.AUTH_SECRET,
  trustHost: true,
  session: { strategy: "jwt", maxAge: 12 * 60 * 60 },
  pages: { signIn: "/login" },
  cookies: {
    sessionToken: {
      name: "wharf.session",
      options: {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: useSecureCookies,
        domain: process.env.COOKIE_DOMAIN || undefined,
      },
    },
  },
  callbacks: {
    jwt({ token, user }) {
      // `user` is only present on sign-in — persist id/email/role onto the
      // token so the gateway and forwardAuth can verify without a DB trip.
      if (user) {
        token.id = user.id as string;
        token.email = user.email;
        token.role = user.role;
      }
      return token;
    },
    session({ session, token }) {
      session.user.id = token.id;
      session.user.role = token.role;
      if (token.email) session.user.email = token.email;
      return session;
    },
  },
  providers: [], // Credentials provider added in lib/auth.ts (needs Node runtime)
} satisfies NextAuthConfig;
