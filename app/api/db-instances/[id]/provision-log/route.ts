/**
 * GET /api/db-instances/:id/provision-log — SSE stream of whichever
 * job currently owns this instance: `provision:{id}` (provision or retry) or
 * `remove:{id}` (teardown). Any authenticated role (`instances.read`).
 *
 * Selection rule: prefer the ACTIVE job; if neither is active fall back to
 * `provision:{id}` so a just-finished run still replays its buffer (ended jobs
 * are retained for an hour, lib/jobs/stream). When no such job exists at all
 * the helper emits the terminal `{"done":true,"status":"error","line":"No such
 * job"}` marker — the UI reads that as "idle".
 *
 * Wire format: lib/jobs/stream.ts; phase protocol: contract §5.
 */
import { requireApiRole, withErrorHandling } from "@/lib/api-helpers";
import { isJobActive, sseResponse } from "@/lib/jobs/stream";
import { provisionJobId, removeJobId } from "@/lib/provision/pipeline";

export const dynamic = "force-dynamic";

export const GET = withErrorHandling(
  async (
    _req: Request,
    { params }: { params: Promise<{ id: string }> },
  ): Promise<Response> => {
    await requireApiRole("instances.read");
    const { id } = await params;

    const provisionId = provisionJobId(id);
    const removeId = removeJobId(id);

    return sseResponse(isJobActive(removeId) ? removeId : provisionId);
  },
);
