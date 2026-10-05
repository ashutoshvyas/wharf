/**
 * GET /api/servers/:id/bootstrap-log — SSE stream of the
 * server's bootstrap job (`bootstrap:{id}`), with buffered replay for late
 * subscribers. Any authenticated role ('servers.read'). Wire format is
 * documented in lib/jobs/stream.ts; an unknown/expired job id yields a
 * single {done:true, status:"error"} marker.
 */
import { requireApiRole, withErrorHandling } from "@/lib/api-helpers";
import { bootstrapJobId } from "@/lib/bootstrap/run";
import { sseResponse } from "@/lib/jobs/stream";

export const dynamic = "force-dynamic";

export const GET = withErrorHandling(
  async (
    _req: Request,
    { params }: { params: Promise<{ id: string }> },
  ): Promise<Response> => {
    await requireApiRole("servers.read");
    const { id } = await params;
    return sseResponse(bootstrapJobId(id));
  },
);
