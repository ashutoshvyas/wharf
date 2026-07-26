/**
 * /api/websites/:id — detail, update, delete.
 *
 * GET    websites.read   — single website with embedded refs.
 * PATCH  websites.write  — partial update; the credential password is
 *                          re-sealed ONLY when a non-empty value is sent
 *                          (empty/absent = keep stored). Audits 'website.update'.
 * DELETE websites.write  — removes ONLY the metadata record + stored
 *                          credential; nothing on the server itself is
 *                          touched (architecture §4.4 — no SSH actions in
 *                          this module). Audits 'website.delete'.
 */
import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { apiError, requireApiRole, withErrorHandling } from "@/lib/api-helpers";
import { audit } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { sealBytes } from "@/lib/servers/seal-bytes";
import { websiteUpdateSchema } from "@/lib/websites/schema";
import { serializeWebsite, WEBSITE_INCLUDE } from "@/lib/websites/serialize";

type Ctx = { params: Promise<{ id: string }> };

export const GET = withErrorHandling(async (_req: Request, ctx: Ctx) => {
  await requireApiRole("websites.read");
  const { id } = await ctx.params;
  const website = await prisma.website.findUnique({
    where: { id },
    include: WEBSITE_INCLUDE,
  });
  if (!website) return apiError(404, "Website not found.");
  return NextResponse.json({ website: serializeWebsite(website) });
});

export const PATCH = withErrorHandling(async (req: Request, ctx: Ctx) => {
  const { session } = await requireApiRole("websites.write");
  const { id } = await ctx.params;
  const input = websiteUpdateSchema.parse(await req.json());

  const existing = await prisma.website.findUnique({
    where: { id },
    select: { id: true },
  });
  if (!existing) return apiError(404, "Website not found.");

  if (input.serverId !== undefined) {
    const server = await prisma.server.findUnique({
      where: { id: input.serverId },
      select: { id: true },
    });
    if (!server) return apiError(400, "Server not found.");
  }
  if (input.dbInstanceId != null) {
    const instance = await prisma.dbInstance.findUnique({
      where: { id: input.dbInstanceId },
      select: { id: true },
    });
    if (!instance) return apiError(400, "Database instance not found.");
  }

  const data: Prisma.WebsiteUncheckedUpdateInput = {};
  if (input.domain !== undefined) data.domain = input.domain;
  if (input.serverId !== undefined) data.serverId = input.serverId;
  if (input.path !== undefined) data.path = input.path;
  if (input.dbInstanceId !== undefined) data.dbInstanceId = input.dbInstanceId;
  if (input.credentialLabel !== undefined)
    data.credentialLabel = input.credentialLabel;
  if (input.accessUsername !== undefined)
    data.accessUsername = input.accessUsername || null;
  // Re-seal only when a NON-EMPTY password was provided; '' means keep.
  if (input.accessPassword) data.accessPasswordEnc = sealBytes(input.accessPassword);
  if (input.notes !== undefined) data.notes = input.notes;

  const website = await prisma.website.update({
    where: { id },
    data,
    include: WEBSITE_INCLUDE,
  });

  await audit({
    userId: session.user.id,
    userEmail: session.user.email,
    action: "website.update",
    targetType: "website",
    targetId: website.id,
    metadata: { domain: website.domain },
  });

  return NextResponse.json({ website: serializeWebsite(website) });
});

export const DELETE = withErrorHandling(async (_req: Request, ctx: Ctx) => {
  const { session } = await requireApiRole("websites.write");
  const { id } = await ctx.params;

  const website = await prisma.website.findUnique({
    where: { id },
    select: { id: true, domain: true },
  });
  if (!website) return apiError(404, "Website not found.");

  await prisma.website.delete({ where: { id } });

  await audit({
    userId: session.user.id,
    userEmail: session.user.email,
    action: "website.delete",
    targetType: "website",
    targetId: website.id,
    metadata: { domain: website.domain },
  });

  return NextResponse.json({ ok: true });
});
