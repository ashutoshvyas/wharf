/**
 * /api/websites — list + create.
 *
 * GET  websites.read   — full list (optional ?serverId= filter), domain asc,
 *                        with embedded server {id,name,host} and
 *                        dbInstance {id,name,slug,status} refs.
 * POST websites.write  — validate, verify FKs, seal the credential password
 *                        (AES-256-GCM, lib/crypto), audit 'website.create'.
 */
import { NextResponse } from "next/server";
import { apiError, requireApiRole, withErrorHandling } from "@/lib/api-helpers";
import { audit } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { sealBytes } from "@/lib/servers/seal-bytes";
import { websiteCreateSchema } from "@/lib/websites/schema";
import { serializeWebsite, WEBSITE_INCLUDE } from "@/lib/websites/serialize";

export const GET = withErrorHandling(async (req: Request) => {
  await requireApiRole("websites.read");
  const serverId = new URL(req.url).searchParams.get("serverId");
  const websites = await prisma.website.findMany({
    where: serverId ? { serverId } : undefined,
    orderBy: { domain: "asc" },
    include: WEBSITE_INCLUDE,
  });
  return NextResponse.json({ websites: websites.map(serializeWebsite) });
});

export const POST = withErrorHandling(async (req: Request) => {
  const { session } = await requireApiRole("websites.write");
  const input = websiteCreateSchema.parse(await req.json());

  const server = await prisma.server.findUnique({
    where: { id: input.serverId },
    select: { id: true },
  });
  if (!server) return apiError(400, "Server not found.");

  if (input.dbInstanceId) {
    const instance = await prisma.dbInstance.findUnique({
      where: { id: input.dbInstanceId },
      select: { id: true },
    });
    if (!instance) return apiError(400, "Database instance not found.");
  }

  const website = await prisma.website.create({
    data: {
      domain: input.domain,
      serverId: input.serverId,
      path: input.path,
      dbInstanceId: input.dbInstanceId ?? null,
      credentialLabel: input.credentialLabel,
      accessUsername: input.accessUsername || null,
      accessPasswordEnc: input.accessPassword
        ? sealBytes(input.accessPassword)
        : null,
      notes: input.notes ?? "",
    },
    include: WEBSITE_INCLUDE,
  });

  await audit({
    userId: session.user.id,
    userEmail: session.user.email,
    action: "website.create",
    targetType: "website",
    targetId: website.id,
    metadata: { domain: website.domain },
  });

  return NextResponse.json({ website: serializeWebsite(website) }, { status: 201 });
});
