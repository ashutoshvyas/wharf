/**
 * POST /api/db-instances/:id/restore — load an uploaded Postgres
 * backup into an existing, running instance. Admin-only (`instance.restore`,
 * same tier as remove — this overwrites live data in place).
 *
 * The body is the raw file bytes (not JSON — `confirmName` travels as a
 * query param and the original filename as `X-Backup-Filename`, since the
 * request body is reserved for the upload itself).
 *
 * 202 {jobId}   restore started — stream it via …/restore-log
 * 400           missing confirmName / filename, or the body was empty
 * 404           unknown or soft-deleted instance
 * 409 {error}   wrong status, bad file, confirmName mismatch, or the
 *               server lock is held
 *
 * The restore engine audits the lifecycle event itself — no audit here.
 */
import { NextResponse } from "next/server";
import { apiError, requireApiRole, withErrorHandling } from "@/lib/api-helpers";
import { prisma } from "@/lib/db";
import { startRestore } from "@/lib/provision/restore";

type Ctx = { params: Promise<{ id: string }> };

export const dynamic = "force-dynamic";

export const POST = withErrorHandling(async (req: Request, { params }: Ctx): Promise<Response> => {
  const { session } = await requireApiRole("instance.restore");
  const { id } = await params;

  const confirmName = new URL(req.url).searchParams.get("confirmName");
  if (!confirmName) return apiError(400, "confirmName query param is required");

  const filename = req.headers.get("x-backup-filename");
  if (!filename) return apiError(400, "X-Backup-Filename header is required");

  const bytes = await req.arrayBuffer();
  if (bytes.byteLength === 0) return apiError(400, "Upload body is empty");

  const instance = await prisma.dbInstance.findFirst({
    where: { id, deletedAt: null },
    select: { id: true, name: true },
  });
  if (!instance) return apiError(404, "Database instance not found");

  if (confirmName !== instance.name) {
    return apiError(400, "Confirmation does not match the instance name");
  }

  const result = await startRestore(
    id,
    { userId: session.user.id, userEmail: session.user.email },
    confirmName,
    { buffer: Buffer.from(bytes), filename },
  );

  if ("busy" in result) {
    return apiError(409, `Server is busy — a '${result.busy}' job is running.`);
  }
  if ("invalid" in result) return apiError(409, result.invalid);
  return NextResponse.json({ jobId: result.jobId }, { status: 202 });
});
