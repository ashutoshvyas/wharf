/**
 * POST /api/db-instances/:id/sync-source/test — read-only probe of
 * the configured source: `select current_database(), version()` run from the
 * instance's own db container, so it proves the exact path a sync will use
 * (egress from THAT server, that TLS mode, those credentials) rather than
 * something the panel can reach.
 *
 * Nothing is written anywhere, so this is safe to press repeatedly — but it
 * does take the target server's single-flight lock for the second or so the
 * probe runs. Admin-only (`instance.restore`), like every sync-source route.
 *
 * 200 {ok, detail}   probe ran; `ok:false` carries the source's own error text
 * 404                unknown or soft-deleted instance
 * 409 {error}        no source configured, instance not running, or lock held
 */
import { NextResponse } from "next/server";
import { apiError, requireApiRole, withErrorHandling } from "@/lib/api-helpers";
import { prisma } from "@/lib/db";
import { testSyncSource } from "@/lib/provision/sync";

type Ctx = { params: Promise<{ id: string }> };

export const dynamic = "force-dynamic";

export const POST = withErrorHandling(async (_req: Request, { params }: Ctx) => {
  await requireApiRole("instance.restore");
  const { id } = await params;

  const instance = await prisma.dbInstance.findFirst({
    where: { id, deletedAt: null },
    select: { id: true },
  });
  if (!instance) return apiError(404, "Database instance not found");

  const result = await testSyncSource(id);

  if ("busy" in result) {
    return apiError(409, `Server is busy — a '${result.busy}' job is running.`);
  }
  if ("invalid" in result) return apiError(409, result.invalid);
  return NextResponse.json(result);
});
