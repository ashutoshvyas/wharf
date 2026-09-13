import { NextResponse } from "next/server";
import { apiError, requireApiRole, withErrorHandling } from "@/lib/api-helpers";
import { prisma } from "@/lib/db";
import { startCloneSchema } from "@/lib/instances/clone-schema";
import { startClone } from "@/lib/provision/clone";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Copy this live source into a different existing destination. */
export const POST = withErrorHandling(async (
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> => {
  const { session } = await requireApiRole("instance.restore");
  const { id } = await params;
  const raw = await req.json().catch(() => null);
  const parsed = startCloneSchema.safeParse(raw);
  if (!parsed.success) return apiError(400, parsed.error.issues.map((issue) => issue.message).join("; "));
  const { targetInstanceId, confirmName } = parsed.data;
  if (id === targetInstanceId) return apiError(400, "Source and destination must be different databases");

  const [source, target] = await Promise.all([
    prisma.dbInstance.findFirst({ where: { id, deletedAt: null }, select: { id: true } }),
    prisma.dbInstance.findFirst({ where: { id: targetInstanceId, deletedAt: null }, select: { id: true, name: true } }),
  ]);
  if (!source) return apiError(404, "Source database not found");
  if (!target) return apiError(404, "Destination database not found");
  if (confirmName !== target.name) return apiError(400, "Confirmation does not match the destination database name");

  const result = await startClone(
    id,
    targetInstanceId,
    { userId: session.user.id, userEmail: session.user.email },
    confirmName,
  );
  if ("busy" in result) return apiError(409, `Server is busy — a '${result.busy}' job is running.`);
  if ("invalid" in result) return apiError(409, result.invalid);
  return NextResponse.json({ jobId: result.jobId, targetInstanceId }, { status: 202 });
});
