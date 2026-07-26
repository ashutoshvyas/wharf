/**
 * Lockout guards for the Users API.
 *
 * Three rules, all returning a 409 conflict message (null = allowed):
 *
 *  1. You cannot delete your own account.
 *  2. You cannot change your own role — otherwise the only admin could demote
 *     themselves out of the admin screen mid-request.
 *  3. The panel must always retain at least one admin. Deleting the last
 *     admin, or demoting them, is refused. The admin count MUST be read
 *     inside the same transaction as the write, so two concurrent demotions
 *     cannot both observe "2 admins" and land the panel on zero.
 *
 * These are pure functions so the decision table is unit-testable without a
 * database; the routes supply `adminCount` from a transactional count().
 */
import type { UserRole } from "./schema";

export const SELF_DELETE_MESSAGE =
  "You cannot remove your own account — ask another admin to do it.";

export const SELF_ROLE_MESSAGE =
  "You cannot change your own role — ask another admin to do it.";

export const LAST_ADMIN_DELETE_MESSAGE =
  "This is the last admin — the panel must always have one. Promote another user first.";

export const LAST_ADMIN_DEMOTE_MESSAGE =
  "This is the last admin — the panel must always have one. Promote another user first.";

export interface TargetUser {
  id: string;
  role: UserRole;
}

/**
 * Guard for DELETE /api/users/:id.
 * @param adminCount number of admin rows, counted in the deleting transaction.
 */
export function deleteUserConflict(
  actorId: string,
  target: TargetUser,
  adminCount: number,
): string | null {
  if (actorId === target.id) return SELF_DELETE_MESSAGE;
  if (target.role === "admin" && adminCount <= 1) {
    return LAST_ADMIN_DELETE_MESSAGE;
  }
  return null;
}

/**
 * Guard for PATCH /api/users/:id (role change).
 * @param adminCount number of admin rows, counted in the updating transaction.
 */
export function updateRoleConflict(
  actorId: string,
  target: TargetUser,
  nextRole: UserRole,
  adminCount: number,
): string | null {
  if (actorId === target.id) return SELF_ROLE_MESSAGE;
  // A no-op "change" is harmless even for the last admin.
  if (target.role === nextRole) return null;
  if (target.role === "admin" && nextRole !== "admin" && adminCount <= 1) {
    return LAST_ADMIN_DEMOTE_MESSAGE;
  }
  return null;
}
