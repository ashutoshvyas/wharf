/**
 * POST /api/db-instances/:id/start — `docker compose start` over SSH,
 * the inverse of …/stop. Operator+ (`instance.stopstart`).
 *
 * 200 DTO       started — the refreshed instance row
 * 404           unknown or soft-deleted instance
 * 409 {error}   the target server's single-flight lock is held
 *
 * BUSY DETECTION: the engine signals a held lock by throwing a plain Error
 * whose message contains "busy" (contract §3). We re-throw anything else so
 * genuine SSH/compose failures still surface as 500 via withErrorHandling.
 * The engine audits the lifecycle event itself — no audit here.
 */
import { NextResponse } from "next/server";
import { apiError, requireApiRole, withErrorHandling } from "@/lib/api-helpers";
import { prisma } from "@/lib/db";
import { INSTANCE_INCLUDE, serializeInstance } from "@/lib/instances/serialize";
import { startInstance } from "@/lib/provision/pipeline";

type Ctx = { params: Promise<{ id: string }> };

export const POST = withErrorHandling(
  async (_req: Request, { params }: Ctx): Promise<Response> => {
    const { session } = await requireApiRole("instance.stopstart");
    const { id } = await params;

    const existing = await prisma.dbInstance.findFirst({
      where: { id, deletedAt: null },
      select: { id: true },
    });
    if (!existing) return apiError(404, "Database instance not found");

    try {
      await startInstance(id, {
        userId: session.user.id,
        userEmail: session.user.email,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/busy/i.test(message)) return apiError(409, message);
      throw err;
    }

    const instance = await prisma.dbInstance.findFirst({
      where: { id, deletedAt: null },
      include: INSTANCE_INCLUDE,
    });
    if (!instance) return apiError(404, "Database instance not found");
    return NextResponse.json(serializeInstance(instance));
  },
);
