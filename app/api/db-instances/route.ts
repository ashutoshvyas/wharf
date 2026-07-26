/**
 * /api/db-instances — list + provision.
 * GET: viewer+ (`instances.read`) · POST: operator+ (`instance.provision`).
 * See docs/api.md and docs/provisioning-contract.md §1/§3.
 *
 * POST hands off to the provisioning engine and returns immediately (202) —
 * the job is streamed via GET /api/db-instances/:id/provision-log. The engine
 * writes its own audit trail (`instance.provision`), so this route does not
 * double-audit.
 */
import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { apiError, requireApiRole, withErrorHandling } from "@/lib/api-helpers";
import { prisma } from "@/lib/db";
import { createInstanceSchema } from "@/lib/instances/schema";
import { INSTANCE_INCLUDE, serializeInstance } from "@/lib/instances/serialize";
import { startProvision } from "@/lib/provision/pipeline";

export const GET = withErrorHandling(async (req: Request): Promise<Response> => {
  await requireApiRole("instances.read");

  const serverId = new URL(req.url).searchParams.get("serverId");
  const where: Prisma.DbInstanceWhereInput = { deletedAt: null };
  if (serverId) where.serverId = serverId;

  const instances = await prisma.dbInstance.findMany({
    where,
    orderBy: { createdAt: "desc" },
    include: INSTANCE_INCLUDE,
  });
  return NextResponse.json(instances.map(serializeInstance));
});

export const POST = withErrorHandling(async (req: Request): Promise<Response> => {
  const { session } = await requireApiRole("instance.provision");

  const raw = await req.json().catch(() => null);
  if (raw === null || typeof raw !== "object") {
    return apiError(400, "Invalid request — body must be a JSON object");
  }
  const body = createInstanceSchema.parse(raw);

  const result = await startProvision({
    serverId: body.serverId,
    name: body.name,
    slug: body.slug,
    userId: session.user.id,
    userEmail: session.user.email,
  });

  if ("invalid" in result) return apiError(400, result.invalid);
  if ("busy" in result) {
    return apiError(409, `Server is busy — a '${result.busy}' job is running.`);
  }
  return NextResponse.json(
    { id: result.instanceId, jobId: result.jobId },
    { status: 202 },
  );
});
