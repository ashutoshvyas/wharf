/**
 * POST /api/servers/:id/check — SSH reachability probe.
 *
 * Requires 'server.check' (admin|operator). Rate limited to one check per
 * server per 10s via a process-local Map (the panel is a single long-lived
 * Node process — architecture §2; same reasoning as lib/rate-limit.ts).
 * `servers.reachable` persistence is handled inside lib/ssh withConnection.
 */
import { NextResponse } from "next/server";
import { apiError, requireApiRole, withErrorHandling } from "@/lib/api-helpers";
import { prisma } from "@/lib/db";
import { checkReachable } from "@/lib/ssh";

const RATE_LIMIT_MS = 10_000;
const lastCheckAt = new Map<string, number>();

export const POST = withErrorHandling(
  async (
    _req: Request,
    { params }: { params: Promise<{ id: string }> },
  ): Promise<Response> => {
    await requireApiRole("server.check");
    const { id } = await params;

    const server = await prisma.server.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!server) return apiError(404, "Server not found");

    const now = Date.now();
    const last = lastCheckAt.get(id) ?? 0;
    const elapsed = now - last;
    if (elapsed < RATE_LIMIT_MS) {
      const retryAfterSec = Math.ceil((RATE_LIMIT_MS - elapsed) / 1000);
      return apiError(
        429,
        `Reachability check rate limited — retry after ${retryAfterSec}s.`,
      );
    }
    lastCheckAt.set(id, now);

    const result = await checkReachable(id);
    return NextResponse.json(
      result.ok
        ? { ok: true, ms: result.ms, reachable: true }
        : { ok: false, error: result.error, reachable: false },
    );
  },
);
