/**
 * PanelUser row → API payload serializer.
 *
 * SECURITY: explicit ALLOWLIST. `passwordHash` must NEVER appear here — it
 * holds either a bcrypt credential or a pending-invite sentinel
 * (lib/users/invite.ts), and both are secrets. There is no reveal endpoint
 * for it; it leaves the database only inside the invite-redemption compare.
 */
import type { PanelUser } from "@prisma/client";

export interface SerializedUser {
  id: string;
  email: string;
  role: PanelUser["role"];
  createdAt: Date;
  updatedAt: Date;
}

export function serializeUser(user: PanelUser): SerializedUser {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}
