import { apiError, requireApiRole, withErrorHandling } from "@/lib/api-helpers";
import { prisma } from "@/lib/db";
import { sseResponse } from "@/lib/jobs/stream";
import { cloneJobId } from "@/lib/provision/job-ids";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Clone progress is attached to the destination being restored. */
export const GET = withErrorHandling(async (
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> => {
  await requireApiRole("instances.read");
  const { id } = await params;
  const target = await prisma.dbInstance.findFirst({ where: { id, deletedAt: null }, select: { id: true } });
  if (!target) return apiError(404, "Destination database not found");
  return sseResponse(cloneJobId(id));
});
