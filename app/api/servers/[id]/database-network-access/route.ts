import { NextResponse } from "next/server";
import { apiError, requireApiRole, withErrorHandling } from "@/lib/api-helpers";
import { audit } from "@/lib/audit";
import { enableNetworkAccessSchema } from "@/lib/instances/network-access";
import { enableServerNetworkAccess } from "@/lib/provision/network-access";

type Ctx = { params: Promise<{ id: string }> };

export const POST = withErrorHandling(async (req: Request, { params }: Ctx) => {
  const { session } = await requireApiRole("instance.network-access.write");
  const { id } = await params;
  const body = enableNetworkAccessSchema.parse(await req.json().catch(() => null));
  await audit({ userId: session.user.id, userEmail: session.user.email,
    action: "server.network-access.enable", targetType: "server", targetId: id,
    metadata: { baselineAllowedCidrs: body.baselineAllowedCidrs } });
  const result = await enableServerNetworkAccess(id, body.confirmName, body.baselineAllowedCidrs);
  if ("notFound" in result) return apiError(404, "Server not found");
  if ("busy" in result) return apiError(409, `Server is busy — a '${result.busy}' job is running.`);
  if ("invalid" in result) return apiError(409, result.invalid);
  return NextResponse.json(result);
});
