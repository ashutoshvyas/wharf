/**
 * GET /api/servers/:id/orphans — compose projects running on the
 * server that no WHARF instance row claims. Admin (`servers.write`).
 *
 * Surfaced on the server detail page; resolution is MANUAL by design
 * (architecture §4.3) — this route never stops, removes or otherwise touches
 * anything on the host. It is a read-only diagnostic over SSH, so it can be
 * slow and it fails loudly (500) when the server is unreachable.
 */
import { NextResponse } from "next/server";
import { apiError, requireApiRole, withErrorHandling } from "@/lib/api-helpers";
import { prisma } from "@/lib/db";
import { findOrphans } from "@/lib/instances/orphans";

export const dynamic = "force-dynamic";

export const GET = withErrorHandling(
  async (
    _req: Request,
    { params }: { params: Promise<{ id: string }> },
  ): Promise<Response> => {
    await requireApiRole("servers.write");
    const { id } = await params;

    const server = await prisma.server.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!server) return apiError(404, "Server not found");

    const orphans = await findOrphans(id);
    return NextResponse.json({ orphans });
  },
);
