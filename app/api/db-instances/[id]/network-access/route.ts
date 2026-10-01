import { NextResponse } from "next/server";
import { apiError, requireApiRole, withErrorHandling } from "@/lib/api-helpers";
import { audit } from "@/lib/audit";
import { networkAccessSchema } from "@/lib/instances/network-access";
import { getInstanceNetworkAccess, updateInstanceNetworkAccess } from "@/lib/provision/network-access";

type Ctx = { params: Promise<{ id: string }> };

export const GET = withErrorHandling(async (_req: Request, { params }: Ctx) => {
  await requireApiRole("instances.read");
  const result = await getInstanceNetworkAccess((await params).id);
  return result ? NextResponse.json(result, { headers: { "Cache-Control": "no-store" } })
    : apiError(404, "Database instance not found");
});

export const PATCH = withErrorHandling(async (req: Request, { params }: Ctx) => {
  const { session } = await requireApiRole("instance.network-access.write");
  const { id } = await params;
  const policy = networkAccessSchema.parse(await req.json().catch(() => null));
  // Audit the authorized intent even if remote application fails halfway.
  await audit({ userId: session.user.id, userEmail: session.user.email,
    action: "instance.network-access.update", targetType: "db_instance", targetId: id, metadata: { policy } });
  const result = await updateInstanceNetworkAccess(id, policy);
  if ("notFound" in result) return apiError(404, "Database instance not found");
  if ("busy" in result) return apiError(409, `Server is busy — a '${result.busy}' job is running.`);
  if ("invalid" in result) return apiError(409, result.invalid);
  return NextResponse.json(result);
});
