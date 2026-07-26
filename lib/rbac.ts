/**
 * WHARF RBAC — the single role matrix.
 *
 * This file is the ONLY place role → action permissions are defined
 * (architecture §5 route table + §6). API routes enforce via requireRole();
 * UI components mirror via can() and HIDE (never disable) forbidden actions
 * (design §6). Do not add inline role checks anywhere else.
 */

export type Role = "admin" | "operator" | "viewer";

export type Action =
  | "servers.read"
  | "servers.write"
  | "server.bootstrap"
  | "server.delete"
  | "server.check"
  | "terminal"
  | "websites.read"
  | "websites.write"
  | "instances.read"
  | "instance.provision"
  | "instance.stopstart"
  | "instance.retry"
  | "instance.remove"
  | "secrets.reveal"
  | "audit.read"
  | "users";

const ALL: Role[] = ["admin", "operator", "viewer"];
const OPERATOR_UP: Role[] = ["admin", "operator"];
const ADMIN_ONLY: Role[] = ["admin"];

const MATRIX: Record<Action, Role[]> = {
  "servers.read": ALL,
  "servers.write": ADMIN_ONLY,
  "server.bootstrap": ADMIN_ONLY,
  "server.delete": ADMIN_ONLY,
  "server.check": OPERATOR_UP,
  terminal: OPERATOR_UP,
  "websites.read": ALL,
  "websites.write": OPERATOR_UP,
  "instances.read": ALL,
  "instance.provision": OPERATOR_UP,
  "instance.stopstart": OPERATOR_UP,
  "instance.retry": OPERATOR_UP,
  "instance.remove": ADMIN_ONLY,
  "secrets.reveal": OPERATOR_UP,
  "audit.read": ALL,
  users: ADMIN_ONLY,
};

export function can(role: Role | undefined | null, action: Action): boolean {
  if (!role) return false;
  return MATRIX[action].includes(role);
}

export class ForbiddenError extends Error {
  readonly status = 403;
  constructor(action: Action) {
    super(`Forbidden: requires ${MATRIX[action].join("|")} for ${action}`);
    this.name = "ForbiddenError";
  }
}

/**
 * Guard for API handlers — first line of every route.
 * Throws ForbiddenError (mapped to a 403 response by the route error helper).
 */
export function requireRole(
  session: { user?: { role?: Role } } | null | undefined,
  action: Action,
): Role {
  const role = session?.user?.role;
  if (!role || !can(role, action)) throw new ForbiddenError(action);
  return role;
}
