/**
 * /api/db-instances/:id/sync-source — where a live-database sync
 * pulls FROM: a hosted Supabase project, or any reachable Postgres.
 *
 * All three verbs are admin-only under `instance.restore`: the stored
 * credentials grant full READ of the source project, and the sync they drive
 * overwrites this instance's data in place — same tier as remove and restore.
 *
 * GET:    the configuration WITHOUT its secrets — only `pgPasswordConfigured`
 *         / `serviceRoleKeyConfigured`, the same rule as the secrets route.
 *         `null` when no source has been configured yet.
 * PUT:    create or replace. An omitted/empty `pgPassword` or `serviceRoleKey`
 *         keeps the stored value (lib/instances/sync-source-schema.ts); on
 *         CREATE `pgPassword` is therefore required.
 * DELETE: forget the source (and its credentials) entirely.
 *
 * 400   invalid body, or no password on create
 * 404   unknown or soft-deleted instance (DELETE: or no source configured)
 */
import { NextResponse } from "next/server";
import type { InstanceSyncSource } from "@prisma/client";
import { apiError, requireApiRole, withErrorHandling } from "@/lib/api-helpers";
import { audit } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { syncSourceSchema } from "@/lib/instances/sync-source-schema";
import { sealBytes } from "@/lib/servers/seal-bytes";

type Ctx = { params: Promise<{ id: string }> };

export const dynamic = "force-dynamic";

/** Strict allowlist — neither encrypted column is ever serialized. */
function toDto(row: InstanceSyncSource) {
  return {
    kind: row.kind,
    label: row.label ?? "",
    pgHost: row.pgHost,
    pgPort: row.pgPort,
    pgDatabase: row.pgDatabase,
    pgUser: row.pgUser,
    pgPasswordConfigured: true, // the column is non-nullable
    pgSslMode: row.pgSslMode,
    projectUrl: row.projectUrl ?? "",
    serviceRoleKeyConfigured: row.serviceRoleKeyEnc !== null,
    includeAuthUsers: row.includeAuthUsers,
    includeStorageObjects: row.includeStorageObjects,
    extraSchemas: row.extraSchemas,
    lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
    lastSyncStatus: row.lastSyncStatus,
    lastSyncSummary: row.lastSyncSummary,
  };
}

async function findInstance(id: string) {
  return prisma.dbInstance.findFirst({ where: { id, deletedAt: null }, select: { id: true } });
}

export const GET = withErrorHandling(async (_req: Request, { params }: Ctx) => {
  await requireApiRole("instance.restore");
  const { id } = await params;

  if (!(await findInstance(id))) return apiError(404, "Database instance not found");

  const row = await prisma.instanceSyncSource.findUnique({ where: { dbInstanceId: id } });
  return NextResponse.json(row ? toDto(row) : null, {
    headers: { "Cache-Control": "no-store" },
  });
});

export const PUT = withErrorHandling(async (req: Request, { params }: Ctx) => {
  const { session } = await requireApiRole("instance.restore");
  const { id } = await params;

  if (!(await findInstance(id))) return apiError(404, "Database instance not found");

  const raw = await req.json().catch(() => null);
  if (raw === null || typeof raw !== "object") {
    return apiError(400, "Invalid request — body must be a JSON object");
  }
  const body = syncSourceSchema.parse(raw);

  const existing = await prisma.instanceSyncSource.findUnique({ where: { dbInstanceId: id } });
  if (!existing && !body.pgPassword) {
    return apiError(400, "pgPassword is required when configuring a source for the first time");
  }
  if (body.includeStorageObjects && !existing?.serviceRoleKeyEnc && !body.serviceRoleKey) {
    return apiError(
      400,
      "serviceRoleKey is required when copying storage objects — it is what reads them " +
        "from the source project.",
    );
  }

  const common = {
    kind: body.kind,
    label: body.label ?? null,
    pgHost: body.pgHost,
    pgPort: body.pgPort,
    pgDatabase: body.pgDatabase,
    pgUser: body.pgUser,
    pgSslMode: body.pgSslMode,
    projectUrl: body.projectUrl ? body.projectUrl : null,
    includeAuthUsers: body.includeAuthUsers,
    includeStorageObjects: body.includeStorageObjects,
    extraSchemas: body.extraSchemas,
  };

  // Seal ONCE, up front. `upsert` builds both its `create` and `update`
  // objects eagerly in JS — it cannot know which one the database will use —
  // so a `sealBytes(body.pgPassword!)` sitting in the `create` branch still
  // runs when the row already exists and the password was left blank to mean
  // "keep the stored one". That threw ERR_INVALID_ARG_TYPE from the cipher
  // and surfaced as a 500 on every re-save.
  const secrets = {
    ...(body.pgPassword ? { pgPasswordEnc: sealBytes(body.pgPassword) } : {}),
    ...(body.serviceRoleKey ? { serviceRoleKeyEnc: sealBytes(body.serviceRoleKey) } : {}),
  };

  // With a password in hand both branches are valid, so the write stays a
  // single atomic upsert. Without one there is nothing to create — the guard
  // above already rejected that case — so it can only be an update.
  const row = body.pgPassword
    ? await prisma.instanceSyncSource.upsert({
        where: { dbInstanceId: id },
        create: { dbInstanceId: id, ...common, ...secrets, pgPasswordEnc: secrets.pgPasswordEnc! },
        update: { ...common, ...secrets },
      })
    : await prisma.instanceSyncSource.update({
        where: { dbInstanceId: id },
        data: { ...common, ...secrets },
      });

  await audit({
    userId: session.user.id,
    userEmail: session.user.email,
    action: "instance.sync-source.write",
    targetType: "db_instance",
    targetId: id,
    // Identity of the source, never its credentials.
    metadata: {
      kind: row.kind,
      source: `${row.pgUser}@${row.pgHost}:${row.pgPort}/${row.pgDatabase}`,
      includeAuthUsers: row.includeAuthUsers,
      includeStorageObjects: row.includeStorageObjects,
      created: !existing,
    },
  });

  return NextResponse.json(toDto(row));
});

export const DELETE = withErrorHandling(async (_req: Request, { params }: Ctx) => {
  const { session } = await requireApiRole("instance.restore");
  const { id } = await params;

  if (!(await findInstance(id))) return apiError(404, "Database instance not found");

  const existing = await prisma.instanceSyncSource.findUnique({ where: { dbInstanceId: id } });
  if (!existing) return apiError(404, "No sync source is configured for this instance");

  await prisma.instanceSyncSource.delete({ where: { dbInstanceId: id } });
  await audit({
    userId: session.user.id,
    userEmail: session.user.email,
    action: "instance.sync-source.delete",
    targetType: "db_instance",
    targetId: id,
    metadata: { source: `${existing.pgUser}@${existing.pgHost}:${existing.pgPort}` },
  });

  return new NextResponse(null, { status: 204 });
});
