/**
 * /api/db-instances/:id — read + permanent remove.
 * GET: viewer+ (`instances.read`) · DELETE: **admin** (`instance.remove`).
 *
 * DELETE is the destructive teardown (`docker compose down -v` → `rm -rf
 * remotePath` → soft-delete, architecture §4.3) and is gated behind a
 * type-the-name confirmation enforced server-side: `confirmName` must equal
 * the stored `name`. The teardown engine audits `instance.remove` itself.
 */
import { NextResponse } from "next/server";
import { apiError, requireApiRole, withErrorHandling } from "@/lib/api-helpers";
import { prisma } from "@/lib/db";
import { removeSchema } from "@/lib/instances/schema";
import { INSTANCE_INCLUDE, serializeInstance } from "@/lib/instances/serialize";
import { startRemove } from "@/lib/provision/teardown";

type Ctx = { params: Promise<{ id: string }> };

export const GET = withErrorHandling(
  async (_req: Request, { params }: Ctx): Promise<Response> => {
    await requireApiRole("instances.read");
    const { id } = await params;

    const instance = await prisma.dbInstance.findFirst({
      where: { id, deletedAt: null },
      include: INSTANCE_INCLUDE,
    });
    if (!instance) return apiError(404, "Database instance not found");
    return NextResponse.json(serializeInstance(instance));
  },
);

export const DELETE = withErrorHandling(
  async (req: Request, { params }: Ctx): Promise<Response> => {
    const { session } = await requireApiRole("instance.remove");
    const { id } = await params;

    const raw = await req.json().catch(() => null);
    if (raw === null || typeof raw !== "object") {
      return apiError(400, "Invalid request — body must be a JSON object");
    }
    const body = removeSchema.parse(raw);

    const instance = await prisma.dbInstance.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, name: true },
    });
    if (!instance) return apiError(404, "Database instance not found");

    if (body.confirmName !== instance.name) {
      return apiError(400, "Confirmation does not match the instance name");
    }

    const result = await startRemove(
      id,
      { userId: session.user.id, userEmail: session.user.email },
      { force: body.force },
    );
    if ("busy" in result) {
      return apiError(409, `Server is busy — a '${result.busy}' job is running.`);
    }
    if ("invalid" in result) return apiError(409, result.invalid);
    return NextResponse.json({ jobId: result.jobId }, { status: 202 });
  },
);
