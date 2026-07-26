/**
 * /api/db-instances/:id/analytics-settings — Storage Analytics
 * buckets (Iceberg) on/off toggle. Mirrors auth-settings/route.ts's shape,
 * much smaller: there's nothing to configure besides `enabled` — MinIO and
 * Lakekeeper are real extra containers (`profiles: ["analytics"]` in
 * templates/supabase/docker-compose.yml), unlike Vector buckets, which are
 * always on. See lib/provision/analytics-settings.ts's module doc.
 *
 * GET:   secrets.reveal (operator+) — `{enabled}`; defaults to `false` when
 *        no row exists yet (never configured), same as auth-settings.
 * PATCH: instance.auth-settings.write (admin-only) — `{enabled: boolean}`.
 *        Applied BEFORE persisting, matching every other apply-to-a-running-
 *        instance route in this codebase (a busy 409 leaves no trace; a
 *        non-busy apply failure still saves the toggle so the operator's
 *        intent isn't lost, only the "did it take effect" step failed).
 *
 * 404           unknown or soft-deleted instance
 * 409 {error}   the target server's single-flight lock is held (PATCH only)
 */
import { NextResponse } from "next/server";
import { apiError, requireApiRole, withErrorHandling } from "@/lib/api-helpers";
import { audit } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { analyticsSettingsUpdateSchema } from "@/lib/instances/analytics-settings-schema";
import { applyAnalyticsSettings } from "@/lib/provision/analytics-settings";

type Ctx = { params: Promise<{ id: string }> };

export const GET = withErrorHandling(async (_req: Request, { params }: Ctx) => {
  await requireApiRole("secrets.reveal");
  const { id } = await params;

  const instance = await prisma.dbInstance.findFirst({
    where: { id, deletedAt: null },
    select: { id: true },
  });
  if (!instance) return apiError(404, "Database instance not found");

  const settings = await prisma.instanceAnalyticsSettings.findUnique({
    where: { dbInstanceId: id },
    select: { enabled: true },
  });

  return NextResponse.json(
    { enabled: settings?.enabled ?? false },
    { headers: { "Cache-Control": "no-store" } },
  );
});

export const PATCH = withErrorHandling(async (req: Request, { params }: Ctx) => {
  const { session } = await requireApiRole("instance.auth-settings.write");
  const { id } = await params;

  const instance = await prisma.dbInstance.findFirst({
    where: { id, deletedAt: null },
    select: { id: true },
  });
  if (!instance) return apiError(404, "Database instance not found");

  const raw = await req.json().catch(() => null);
  if (raw === null || typeof raw !== "object") {
    return apiError(400, "Invalid request — body must be a JSON object");
  }
  const { enabled } = analyticsSettingsUpdateSchema.parse(raw);

  // Apply BEFORE persisting: a busy server-lock conflict must leave no
  // trace, matching every other busy-conflict route in this codebase.
  let applied = true;
  let applyError: string | undefined;
  try {
    const result = await applyAnalyticsSettings(id, enabled);
    if ("busy" in result) {
      return apiError(409, `Server is busy — a '${result.busy}' job is running.`);
    }
  } catch (err) {
    applied = false;
    applyError = err instanceof Error ? err.message : String(err);
  }

  const settings = await prisma.instanceAnalyticsSettings.upsert({
    where: { dbInstanceId: id },
    create: { dbInstanceId: id, enabled },
    update: { enabled },
  });

  await audit({
    userId: session.user.id,
    userEmail: session.user.email,
    action: "instance.analytics-settings.update",
    targetType: "db_instance",
    targetId: id,
    metadata: { enabled, applied },
  });

  return NextResponse.json({
    enabled: settings.enabled,
    applied,
    ...(applyError ? { applyError } : {}),
  });
});
