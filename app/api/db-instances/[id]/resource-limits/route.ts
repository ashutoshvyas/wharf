/**
 * PATCH /api/db-instances/:id/resource-limits — set and apply an instance's
 * whole-stack CPU/memory budget (lib/provision/resource-limits.ts).
 *
 * Changing an applied budget is live and restarts nothing. The first apply on
 * an instance created before per-instance limits recreates its containers
 * inside the slice — the response's `recreated` says whether that happened.
 * Admin-only; the per-server lock keeps it from racing any other job.
 */
import { NextResponse } from "next/server";
import { apiError, requireApiRole, withErrorHandling } from "@/lib/api-helpers";
import { audit } from "@/lib/audit";
import { updateResourceLimitsSchema } from "@/lib/instances/resource-limits";
import { serializeInstance } from "@/lib/instances/serialize";
import { applyResourceLimits } from "@/lib/provision/resource-limits";

type Ctx = { params: Promise<{ id: string }> };

export const PATCH = withErrorHandling(async (req: Request, { params }: Ctx) => {
  const { session } = await requireApiRole("instance.resource-limits.write");
  const { id } = await params;

  const raw = await req.json().catch(() => null);
  if (raw === null || typeof raw !== "object") {
    return apiError(400, "Invalid request — body must be a JSON object");
  }
  const limits = updateResourceLimitsSchema.parse(raw);

  let result: Awaited<ReturnType<typeof applyResourceLimits>>;
  try {
    result = await applyResourceLimits(id, limits);
  } catch (err) {
    // The budget is saved with the failure recorded on the row
    // (resourceLimitsError); surface the reason instead of a bare 500.
    await audit({
      userId: session.user.id,
      userEmail: session.user.email,
      action: "instance.resource-limits.update",
      targetType: "db_instance",
      targetId: id,
      metadata: { ...limits, applied: false },
    });
    const message = err instanceof Error ? err.message : String(err);
    return apiError(502, `Limits saved but not applied — ${message}`);
  }
  if ("notFound" in result) return apiError(404, "Database instance not found");
  if ("busy" in result) {
    return apiError(409, `Server is busy — a '${result.busy}' job is running.`);
  }
  if ("invalid" in result) return apiError(409, result.invalid);

  await audit({
    userId: session.user.id,
    userEmail: session.user.email,
    action: "instance.resource-limits.update",
    targetType: "db_instance",
    targetId: id,
    metadata: { ...limits, applied: true, recreated: result.recreated },
  });

  return NextResponse.json({ ...serializeInstance(result.instance), recreated: result.recreated });
});
