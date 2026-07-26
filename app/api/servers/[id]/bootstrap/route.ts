/**
 * POST /api/servers/:id/bootstrap — start the idempotent
 * Docker/Traefik bootstrap job for a server. Admin-only ('server.bootstrap').
 *
 * 202 {jobId}   job started — stream it via GET …/bootstrap-log
 * 404           unknown server
 * 409 {error}   server busy (lock held by another job; label in message)
 *
 * A server marked unreachable is still allowed through: bootstrap needs
 * working SSH anyway, so the attempt either succeeds (and flips reachable
 * back) or fails visibly in the job log.
 */
import { NextResponse } from "next/server";
import { apiError, requireApiRole, withErrorHandling } from "@/lib/api-helpers";
import { runBootstrap } from "@/lib/bootstrap/run";
import { prisma } from "@/lib/db";

export const POST = withErrorHandling(
  async (
    _req: Request,
    { params }: { params: Promise<{ id: string }> },
  ): Promise<Response> => {
    const { session } = await requireApiRole("server.bootstrap");
    const { id } = await params;

    const server = await prisma.server.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!server) return apiError(404, "Server not found");

    const result = runBootstrap(id, {
      userId: session.user.id,
      userEmail: session.user.email,
    });
    if ("busy" in result) {
      return apiError(409, `Server is busy — a '${result.busy}' job is running.`);
    }
    return NextResponse.json({ jobId: result.jobId }, { status: 202 });
  },
);
