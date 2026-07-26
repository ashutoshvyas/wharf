/**
 * POST /api/users/:id/reset — reissue a set-password link.
 * Admin only (`users`).
 *
 * Reissuing overwrites `passwordHash` with a fresh invite sentinel, which
 * both (a) invalidates any earlier outstanding link and (b) immediately
 * disables sign-in for that account until the new link is redeemed. That is
 * the intended semantic for "this person lost their password": the old
 * credential stops working the moment the reset is issued.
 */
import { NextResponse } from "next/server";
import {
  apiError,
  requireApiRole,
  withErrorHandling,
} from "@/lib/api-helpers";
import { audit } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { createInvite, isInviteSentinel, inviteUrl } from "@/lib/users/invite";

type Ctx = { params: Promise<{ id: string }> };

export const POST = withErrorHandling(async (_req: Request, ctx: Ctx) => {
  const { session } = await requireApiRole("users");
  const { id } = await ctx.params;

  const target = await prisma.panelUser.findUnique({ where: { id } });
  if (!target) return apiError(404, "User not found");

  const invite = createInvite();
  await prisma.panelUser.update({
    where: { id },
    data: { passwordHash: invite.passwordHash },
  });

  await audit({
    userId: session.user.id,
    userEmail: session.user.email,
    action: "user.reset",
    targetType: "user",
    targetId: target.id,
    metadata: {
      email: target.email,
      // Distinguishes "resent a pending invite" from "revoked a live password".
      hadPassword: !isInviteSentinel(target.passwordHash),
      inviteExpiresAt: new Date(invite.expiresAtMs).toISOString(),
    },
  });

  return NextResponse.json({ inviteUrl: inviteUrl(invite.token) });
});
