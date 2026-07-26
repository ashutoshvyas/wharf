/**
 * /api/servers — list + create.
 * GET: viewer+ · POST: admin (servers.write). See docs/api.md.
 */
import { NextResponse } from "next/server";
import {
  apiError,
  requireApiRole,
  withErrorHandling,
} from "@/lib/api-helpers";
import { audit } from "@/lib/audit";
import { sealBytes } from "@/lib/servers/seal-bytes";
import { prisma } from "@/lib/db";
import { serverCreateSchema } from "@/lib/servers/schema";
import { serializeServer } from "@/lib/servers/serialize";

const COUNTS = { _count: { select: { websites: true, dbInstances: true } } };

export const GET = withErrorHandling(async () => {
  await requireApiRole("servers.read");
  const servers = await prisma.server.findMany({
    orderBy: { name: "asc" },
    include: COUNTS,
  });
  return NextResponse.json(servers.map(serializeServer));
});

export const POST = withErrorHandling(async (req: Request) => {
  const { session } = await requireApiRole("servers.write");

  const raw = await req.json().catch(() => null);
  if (raw === null || typeof raw !== "object") {
    return apiError(400, "Invalid request — body must be a JSON object");
  }
  const body = serverCreateSchema.parse(raw);

  const server = await prisma.server.create({
    data: {
      name: body.name,
      host: body.host,
      sshPort: body.sshPort,
      sshUser: body.sshUser,
      authMethod: body.authMethod,
      sshPasswordEnc: body.sshPassword ? sealBytes(body.sshPassword) : null,
      sshPrivateKeyEnc: body.sshPrivateKey ? sealBytes(body.sshPrivateKey) : null,
      linkedPanelUrl: body.linkedPanelUrl || null,
      panelUserEnc: body.panelUser ? sealBytes(body.panelUser) : null,
      panelPassEnc: body.panelPass ? sealBytes(body.panelPass) : null,
      tags: body.tags,
    },
    include: COUNTS,
  });

  await audit({
    userId: session.user.id,
    userEmail: session.user.email,
    action: "server.create",
    targetType: "server",
    targetId: server.id,
    metadata: { host: server.host },
  });

  return NextResponse.json(serializeServer(server), { status: 201 });
});
