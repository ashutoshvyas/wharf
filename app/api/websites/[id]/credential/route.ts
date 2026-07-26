/**
 * /api/websites/:id/credential — audited credential reveal.
 *
 * GET secrets.reveal — decrypts the stored password in memory only, returns
 * {label, username, password} with Cache-Control: no-store, and writes a
 * 'website.credential_reveal' audit row. 404 when the website doesn't exist
 * OR no password is stored.
 */
import { NextResponse } from "next/server";
import { apiError, requireApiRole, withErrorHandling } from "@/lib/api-helpers";
import { audit } from "@/lib/audit";
import { open } from "@/lib/crypto";
import { prisma } from "@/lib/db";

type Ctx = { params: Promise<{ id: string }> };

export const GET = withErrorHandling(async (_req: Request, ctx: Ctx) => {
  const { session } = await requireApiRole("secrets.reveal");
  const { id } = await ctx.params;

  const website = await prisma.website.findUnique({
    where: { id },
    select: {
      id: true,
      domain: true,
      credentialLabel: true,
      accessUsername: true,
      accessPasswordEnc: true,
    },
  });
  if (!website) return apiError(404, "Website not found.");
  if (!website.accessPasswordEnc || website.accessPasswordEnc.length === 0) {
    return apiError(404, "No credential stored for this website.");
  }

  const password = open(website.accessPasswordEnc);

  await audit({
    userId: session.user.id,
    userEmail: session.user.email,
    action: "website.credential_reveal",
    targetType: "website",
    targetId: website.id,
    metadata: { domain: website.domain },
  });

  return NextResponse.json(
    {
      label: website.credentialLabel,
      username: website.accessUsername,
      password,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
});
