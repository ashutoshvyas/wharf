/**
 * /api/users/:id — change role, remove user. Admin only (`users`).
 *
 * Both verbs run their guard INSIDE a transaction that also counts admins, so
 * two concurrent "demote the other admin" requests cannot both pass the
 * last-admin check. Guard decisions live in lib/users/guards.ts; conflicts
 * surface as 409 with the message the UI shows verbatim.
 *
 * ISOLATION: the transactions are SERIALIZABLE, not the Postgres default. At
 * Read Committed the count is not enough — two concurrent transactions would
 * each observe "2 admins", neither seeing the other's uncommitted write, and
 * both would commit, leaving zero admins. Serializable makes the second one
 * fail (P2034), which we translate into a retryable 409 rather than a 500.
 */
import { NextResponse } from "next/server";
import { Prisma, type PanelUser } from "@prisma/client";
import {
  apiError,
  requireApiRole,
  withErrorHandling,
} from "@/lib/api-helpers";
import { audit } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { deleteUserConflict, updateRoleConflict } from "@/lib/users/guards";
import { updateUserSchema, type UserRole } from "@/lib/users/schema";
import { serializeUser } from "@/lib/users/serialize";

type Ctx = { params: Promise<{ id: string }> };

interface Conflict {
  status: number;
  message: string;
}

/** Serializable is what makes the last-admin count trustworthy (see header). */
const SERIALIZABLE = {
  isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
} as const;

const WRITE_CONFLICT_MESSAGE =
  "Another admin changed this user at the same moment. Reload and try again.";

/**
 * P2034 = "transaction failed due to a write conflict or deadlock" — the
 * serialization failure we deliberately provoke rather than allow a zero-admin
 * commit. It is a retry signal, not a server fault, so it must not become 500.
 */
function isWriteConflict(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2034"
  );
}

export const PATCH = withErrorHandling(async (req: Request, ctx: Ctx) => {
  const { session } = await requireApiRole("users");
  const { id } = await ctx.params;

  const raw = await req.json().catch(() => null);
  if (raw === null || typeof raw !== "object") {
    return apiError(400, "Invalid request — body must be a JSON object");
  }
  const body = updateUserSchema.parse(raw);

  type PatchOutcome =
    | { error: Conflict }
    | { user: PanelUser; previousRole: UserRole };

  let outcome: PatchOutcome;
  try {
    outcome = await prisma.$transaction(async (tx): Promise<PatchOutcome> => {
      const target = await tx.panelUser.findUnique({ where: { id } });
      if (!target) return { error: { status: 404, message: "User not found" } };

      const adminCount = await tx.panelUser.count({ where: { role: "admin" } });
      const conflict = updateRoleConflict(
        session.user.id,
        { id: target.id, role: target.role },
        body.role,
        adminCount,
      );
      if (conflict) return { error: { status: 409, message: conflict } };

      const user = await tx.panelUser.update({
        where: { id },
        data: { role: body.role },
      });
      return { user, previousRole: target.role };
    }, SERIALIZABLE);
  } catch (err) {
    if (isWriteConflict(err)) return apiError(409, WRITE_CONFLICT_MESSAGE);
    throw err;
  }

  if ("error" in outcome) {
    return apiError(outcome.error.status, outcome.error.message);
  }

  await audit({
    userId: session.user.id,
    userEmail: session.user.email,
    action: "user.update",
    targetType: "user",
    targetId: outcome.user.id,
    metadata: {
      email: outcome.user.email,
      role: outcome.user.role,
      previousRole: outcome.previousRole,
    },
  });

  return NextResponse.json(serializeUser(outcome.user));
});

export const DELETE = withErrorHandling(async (_req: Request, ctx: Ctx) => {
  const { session } = await requireApiRole("users");
  const { id } = await ctx.params;

  type DeleteOutcome = { error: Conflict } | { user: PanelUser };

  let outcome: DeleteOutcome;
  try {
    outcome = await prisma.$transaction(async (tx): Promise<DeleteOutcome> => {
      const target = await tx.panelUser.findUnique({ where: { id } });
      if (!target) return { error: { status: 404, message: "User not found" } };

      const adminCount = await tx.panelUser.count({ where: { role: "admin" } });
      const conflict = deleteUserConflict(
        session.user.id,
        { id: target.id, role: target.role },
        adminCount,
      );
      if (conflict) return { error: { status: 409, message: conflict } };

      await tx.panelUser.delete({ where: { id } });
      return { user: target };
    }, SERIALIZABLE);
  } catch (err) {
    if (isWriteConflict(err)) return apiError(409, WRITE_CONFLICT_MESSAGE);
    throw err;
  }

  if ("error" in outcome) {
    return apiError(outcome.error.status, outcome.error.message);
  }

  await audit({
    userId: session.user.id,
    userEmail: session.user.email,
    action: "user.delete",
    targetType: "user",
    targetId: outcome.user.id,
    metadata: { email: outcome.user.email, role: outcome.user.role },
  });

  return NextResponse.json({ ok: true });
});
