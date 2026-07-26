/**
 * POST /api/db-instances/:id/retry — re-run the idempotent
 * provisioning pipeline for an instance stuck in `error`. Operator+
 * (`instance.retry`). `error` is terminal until an explicit retry or remove —
 * nothing is ever auto-retried (contract §2).
 *
 * 202 {jobId}   retry started — stream it via …/provision-log
 * 404           unknown or soft-deleted instance
 * 409 {error}   wrong status (not `error`) OR the server lock is held
 *
 * The engine audits the lifecycle event itself — no audit here.
 */
import { NextResponse } from "next/server";
import { apiError, requireApiRole, withErrorHandling } from "@/lib/api-helpers";
import { prisma } from "@/lib/db";
import { retryProvision } from "@/lib/provision/pipeline";

type Ctx = { params: Promise<{ id: string }> };

export const POST = withErrorHandling(
  async (_req: Request, { params }: Ctx): Promise<Response> => {
    const { session } = await requireApiRole("instance.retry");
    const { id } = await params;

    const existing = await prisma.dbInstance.findFirst({
      where: { id, deletedAt: null },
      select: { id: true },
    });
    if (!existing) return apiError(404, "Database instance not found");

    const result = await retryProvision(id, {
      userId: session.user.id,
      userEmail: session.user.email,
    });

    // `invalid` here means "not retryable from this status" — a state
    // conflict (409), not a malformed request (400).
    if ("invalid" in result) return apiError(409, result.invalid);
    if ("busy" in result) {
      return apiError(409, `Server is busy — a '${result.busy}' job is running.`);
    }
    return NextResponse.json({ jobId: result.jobId }, { status: 202 });
  },
);
