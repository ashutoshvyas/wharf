/**
 * POST /api/db-instances/:id/sync — pull the configured live source
 * into this instance, replacing its data. Admin-only (`instance.restore`,
 * the same action as an uploaded-file restore: this is the same overwrite,
 * just fed from a live database).
 *
 * Unlike …/restore, the body is plain JSON — the dump never passes through
 * the panel, so nothing large is uploaded here.
 *
 * 202 {jobId}   sync started — stream it via …/sync-log
 * 400           missing/invalid confirmName
 * 404           unknown or soft-deleted instance
 * 409 {error}   wrong status, no source configured, incomplete source
 *               credentials, or the server lock is held
 *
 * The sync engine audits the lifecycle event itself — no audit here.
 */
import { NextResponse } from "next/server";
import { apiError, requireApiRole, withErrorHandling } from "@/lib/api-helpers";
import { prisma } from "@/lib/db";
import { startSyncSchema } from "@/lib/instances/sync-source-schema";
import { startSync } from "@/lib/provision/sync";

type Ctx = { params: Promise<{ id: string }> };

export const dynamic = "force-dynamic";

export const POST = withErrorHandling(async (req: Request, { params }: Ctx): Promise<Response> => {
  const { session } = await requireApiRole("instance.restore");
  const { id } = await params;

  const raw = await req.json().catch(() => null);
  if (raw === null || typeof raw !== "object") {
    return apiError(400, "Invalid request — body must be a JSON object");
  }
  const { confirmName } = startSyncSchema.parse(raw);

  const instance = await prisma.dbInstance.findFirst({
    where: { id, deletedAt: null },
    select: { id: true, name: true },
  });
  if (!instance) return apiError(404, "Database instance not found");

  if (confirmName !== instance.name) {
    return apiError(400, "Confirmation does not match the instance name");
  }

  const result = await startSync(
    id,
    { userId: session.user.id, userEmail: session.user.email },
    confirmName,
  );

  if ("busy" in result) {
    return apiError(409, `Server is busy — a '${result.busy}' job is running.`);
  }
  if ("invalid" in result) return apiError(409, result.invalid);
  return NextResponse.json({ jobId: result.jobId }, { status: 202 });
});
