/**
 * /api/users — list + invite. Admin only (`users`). See docs/api.md.
 *
 * A created user has NO password: `passwordHash` holds an invite sentinel
 * (lib/users/invite.ts) until the invitee redeems it, and bcrypt.compare
 * against that sentinel is always false — so the account cannot sign in
 * before redemption without lib/auth.ts knowing anything about invites.
 */
import { NextResponse } from "next/server";
import {
  apiError,
  requireApiRole,
  withErrorHandling,
} from "@/lib/api-helpers";
import { audit } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { createInvite, inviteUrl } from "@/lib/users/invite";
import { createUserSchema } from "@/lib/users/schema";
import { serializeUser } from "@/lib/users/serialize";

export const GET = withErrorHandling(async () => {
  await requireApiRole("users");
  const users = await prisma.panelUser.findMany({ orderBy: { email: "asc" } });
  return NextResponse.json(users.map(serializeUser));
});

export const POST = withErrorHandling(async (req: Request) => {
  const { session } = await requireApiRole("users");

  const raw = await req.json().catch(() => null);
  if (raw === null || typeof raw !== "object") {
    return apiError(400, "Invalid request — body must be a JSON object");
  }
  const body = createUserSchema.parse(raw);

  const existing = await prisma.panelUser.findUnique({
    where: { email: body.email },
  });
  if (existing) {
    return apiError(409, `${body.email} is already a panel user.`);
  }

  const invite = createInvite();
  const user = await prisma.panelUser.create({
    data: {
      email: body.email,
      role: body.role,
      passwordHash: invite.passwordHash,
    },
  });

  await audit({
    userId: session.user.id,
    userEmail: session.user.email,
    action: "user.create",
    targetType: "user",
    targetId: user.id,
    metadata: {
      email: user.email,
      role: user.role,
      inviteExpiresAt: new Date(invite.expiresAtMs).toISOString(),
    },
  });

  // The raw token is returned ONCE — it is not recoverable from the database.
  return NextResponse.json(
    { ...serializeUser(user), inviteUrl: inviteUrl(invite.token) },
    { status: 201 },
  );
});
