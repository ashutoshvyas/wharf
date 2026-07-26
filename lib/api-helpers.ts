/**
 * API route helpers — the standard shape for every WHARF API route
 * from M2 on. Compose the two exports:
 *
 *   import { NextResponse } from "next/server";
 *   import { requireApiRole, withErrorHandling } from "@/lib/api-helpers";
 *
 *   export const GET = withErrorHandling(async () => {
 *     const { session, role } = await requireApiRole("servers.read");
 *     const servers = await prisma.server.findMany();
 *     return NextResponse.json(servers);
 *   });
 *
 * withErrorHandling maps:
 *   ForbiddenError (lib/rbac)  → 403 {error}
 *   ZodError                   → 400 {error} (issue summary)
 *   anything else              → 500 {error: "Internal server error"}
 *                                (real message logged server-side only)
 */
import { NextResponse } from "next/server";
import { ZodError } from "zod";
import type { Session } from "next-auth";
import { auth } from "@/lib/auth";
import { ForbiddenError, requireRole, type Action, type Role } from "@/lib/rbac";

export function apiError(status: number, message: string): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

/**
 * First line of every protected route: resolves the session and enforces the
 * RBAC matrix for `action`. Throws ForbiddenError (caught by
 * withErrorHandling → 403) when unauthenticated or under-privileged.
 */
export async function requireApiRole(
  action: Action,
): Promise<{ session: Session; role: Role }> {
  const session = await auth();
  const role = requireRole(session, action);
  // requireRole throwing on a null session guarantees session is non-null here.
  return { session: session as Session, role };
}

type RouteHandler<Args extends unknown[]> = (
  ...args: Args
) => Promise<Response> | Response;

export function withErrorHandling<Args extends unknown[]>(
  handler: RouteHandler<Args>,
): (...args: Args) => Promise<Response> {
  return async (...args) => {
    try {
      return await handler(...args);
    } catch (err) {
      if (err instanceof ForbiddenError) {
        return apiError(403, err.message);
      }
      if (err instanceof ZodError) {
        const detail = err.issues
          .map((i) => `${i.path.map(String).join(".") || "input"}: ${i.message}`)
          .join("; ");
        return apiError(400, `Invalid request — ${detail}`);
      }
      console.error("[api] unhandled error:", err);
      return apiError(500, "Internal server error");
    }
  };
}
