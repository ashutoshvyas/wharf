/**
 * PATCH /api/db-instances/:id/ssl-mode — change an existing instance's
 * Supavisor client TLS policy without rebuilding the instance.
 *
 * Admin-only because `disable` allows database credentials and traffic over
 * plaintext. The per-server single-flight lock prevents this from racing a
 * provision, restore, teardown, lifecycle action, or another settings apply.
 */
import { NextResponse } from "next/server";
import { apiError, requireApiRole, withErrorHandling } from "@/lib/api-helpers";
import { audit } from "@/lib/audit";
import { updateInstanceSslModeSchema } from "@/lib/instances/schema";
import { serializeInstance } from "@/lib/instances/serialize";
import { updateInstanceSslMode } from "@/lib/provision/ssl-mode";

type Ctx = { params: Promise<{ id: string }> };

export const PATCH = withErrorHandling(async (req: Request, { params }: Ctx) => {
  const { session } = await requireApiRole("instance.ssl-mode.write");
  const { id } = await params;

  const raw = await req.json().catch(() => null);
  if (raw === null || typeof raw !== "object") {
    return apiError(400, "Invalid request — body must be a JSON object");
  }
  const { sslMode } = updateInstanceSslModeSchema.parse(raw);

  const result = await updateInstanceSslMode(id, sslMode);
  if ("notFound" in result) return apiError(404, "Database instance not found");
  if ("busy" in result) {
    return apiError(409, `Server is busy — a '${result.busy}' job is running.`);
  }
  if ("invalid" in result) return apiError(409, result.invalid);

  await audit({
    userId: session.user.id,
    userEmail: session.user.email,
    action: "instance.ssl-mode.update",
    targetType: "db_instance",
    targetId: id,
    metadata: { sslMode },
  });

  return NextResponse.json(serializeInstance(result.instance));
});
