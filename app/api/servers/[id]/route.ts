/**
 * /api/servers/:id — read, update, delete.
 * GET: viewer+ · PATCH: admin (servers.write) · DELETE: admin (server.delete,
 * blocked with 409 while websites or db instances still reference the server).
 * See docs/api.md.
 */
import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import {
  apiError,
  requireApiRole,
  withErrorHandling,
} from "@/lib/api-helpers";
import { audit } from "@/lib/audit";
import { sealBytes } from "@/lib/servers/seal-bytes";
import { prisma } from "@/lib/db";
import { serverUpdateSchema } from "@/lib/servers/schema";
import { serializeServer } from "@/lib/servers/serialize";

const COUNTS = { _count: { select: { websites: true, dbInstances: true } } };

type Ctx = { params: Promise<{ id: string }> };

export const GET = withErrorHandling(async (_req: Request, ctx: Ctx) => {
  await requireApiRole("servers.read");
  const { id } = await ctx.params;
  const server = await prisma.server.findUnique({
    where: { id },
    include: COUNTS,
  });
  if (!server) return apiError(404, "Server not found");
  return NextResponse.json(serializeServer(server));
});

export const PATCH = withErrorHandling(async (req: Request, ctx: Ctx) => {
  const { session } = await requireApiRole("servers.write");
  const { id } = await ctx.params;

  const existing = await prisma.server.findUnique({ where: { id } });
  if (!existing) return apiError(404, "Server not found");

  const raw = await req.json().catch(() => null);
  if (raw === null || typeof raw !== "object") {
    return apiError(400, "Invalid request — body must be a JSON object");
  }
  const body = serverUpdateSchema.parse(raw);

  const data: Prisma.ServerUpdateInput = {};
  if (body.name !== undefined) data.name = body.name;
  if (body.host !== undefined) data.host = body.host;
  if (body.sshPort !== undefined) data.sshPort = body.sshPort;
  if (body.sshUser !== undefined) data.sshUser = body.sshUser;
  if (body.authMethod !== undefined) data.authMethod = body.authMethod;
  if (body.linkedPanelUrl !== undefined) {
    data.linkedPanelUrl = body.linkedPanelUrl || null;
  }
  if (body.tags !== undefined) data.tags = body.tags;
  // Secret fields survive schema.transform only when provided non-empty;
  // absent means "keep the currently stored ciphertext".
  if (body.sshPassword !== undefined) data.sshPasswordEnc = sealBytes(body.sshPassword);
  if (body.sshPrivateKey !== undefined) {
    data.sshPrivateKeyEnc = sealBytes(body.sshPrivateKey);
  }
  if (body.panelUser !== undefined) data.panelUserEnc = sealBytes(body.panelUser);
  if (body.panelPass !== undefined) data.panelPassEnc = sealBytes(body.panelPass);

  const server = await prisma.server.update({
    where: { id },
    data,
    include: COUNTS,
  });

  await audit({
    userId: session.user.id,
    userEmail: session.user.email,
    action: "server.update",
    targetType: "server",
    targetId: id,
    metadata: { host: server.host, fields: Object.keys(body) },
  });

  return NextResponse.json(serializeServer(server));
});

export const DELETE = withErrorHandling(async (_req: Request, ctx: Ctx) => {
  const { session } = await requireApiRole("server.delete");
  const { id } = await ctx.params;

  const server = await prisma.server.findUnique({
    where: { id },
    include: COUNTS,
  });
  if (!server) return apiError(404, "Server not found");

  const { websites, dbInstances } = server._count;
  if (websites > 0 || dbInstances > 0) {
    return apiError(
      409,
      `Server still has linked resources — ${JSON.stringify({ websites, dbInstances })}`,
    );
  }

  await prisma.server.delete({ where: { id } });

  await audit({
    userId: session.user.id,
    userEmail: session.user.email,
    action: "server.delete",
    targetType: "server",
    targetId: id,
    metadata: { host: server.host },
  });

  return NextResponse.json({ ok: true });
});
