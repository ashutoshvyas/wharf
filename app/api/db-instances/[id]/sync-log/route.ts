/**
 * GET /api/db-instances/:id/sync-log — SSE stream of the live-source
 * sync job for this instance (`sync:{id}`). Any authenticated role
 * (`instances.read`), matching provision-log/restore-log's own read gate.
 *
 * Wire format: lib/jobs/stream.ts; phase protocol mirrors contract §5's
 * `› phase` / `✓ phase` / `✗ phase: detail` convention.
 */
import { requireApiRole, withErrorHandling } from "@/lib/api-helpers";
import { sseResponse } from "@/lib/jobs/stream";
import { syncJobId } from "@/lib/provision/job-ids";

export const dynamic = "force-dynamic";

export const GET = withErrorHandling(
  async (
    _req: Request,
    { params }: { params: Promise<{ id: string }> },
  ): Promise<Response> => {
    await requireApiRole("instances.read");
    const { id } = await params;

    return sseResponse(syncJobId(id));
  },
);
