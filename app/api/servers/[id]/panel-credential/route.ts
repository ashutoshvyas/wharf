/**
 * /api/servers/:id/panel-credential — audited reveal of the linked panel
 * login. GET: operator+ (secrets.reveal). This is the ONLY route
 * that returns the decrypted panel credential; list/detail payloads expose
 * just the hasPanelCredential flag. Response is never cached.
 */
import { NextResponse } from "next/server";
import {
  apiError,
  requireApiRole,
  withErrorHandling,
} from "@/lib/api-helpers";
import { audit } from "@/lib/audit";
import { open } from "@/lib/crypto";
import { prisma } from "@/lib/db";

type Ctx = { params: Promise<{ id: string }> };

export const GET = withErrorHandling(async (_req: Request, ctx: Ctx) => {
  const { session } = await requireApiRole("secrets.reveal");
  const { id } = await ctx.params;

  const server = await prisma.server.findUnique({ where: { id } });
  if (!server) return apiError(404, "Server not found");

  const username = server.panelUserEnc ? open(server.panelUserEnc) : null;
  const password = server.panelPassEnc ? open(server.panelPassEnc) : null;

  await audit({
    userId: session.user.id,
    userEmail: session.user.email,
    action: "server.credential_reveal",
    targetType: "server",
    targetId: id,
    metadata: { serverId: id },
  });

  return NextResponse.json(
    { username, password },
    { headers: { "Cache-Control": "no-store" } },
  );
});
