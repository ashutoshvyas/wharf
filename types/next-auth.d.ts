/**
 * Auth.js v5 module augmentation — session.user carries the RBAC
 * role (typed from lib/rbac, the single source of truth) plus the user id.
 */
import type { DefaultSession } from "next-auth";
import type { Role } from "@/lib/rbac";

declare module "next-auth" {
  interface User {
    role: Role;
  }

  interface Session {
    user: {
      id: string;
      email: string;
      role: Role;
    } & DefaultSession["user"];
  }
}

// v5 beta quirk: next-auth/jwt is a bare `export * from "@auth/core/jwt"`,
// so the JWT interface used by the callbacks lives in @auth/core/jwt —
// augmenting "next-auth/jwt" would create a fresh, unmerged interface.
declare module "@auth/core/jwt" {
  interface JWT {
    id: string;
    role: Role;
  }
}
