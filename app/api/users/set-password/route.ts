/**
 * POST /api/users/set-password — PUBLIC invite / reset redemption.
 *
 * The only unauthenticated mutation in the panel (allowlisted in
 * middleware.ts). The token IS the credential: 256 bits of CSPRNG output,
 * stored only as a SHA-256 digest inside the user's `passwordHash` sentinel
 * (lib/users/invite.ts).
 *
 * Disclosure posture — one generic failure for every rejection (unknown
 * token, expired token, already redeemed, malformed). The response never says
 * which, and never names an account, so the endpoint cannot be used to probe
 * whether an address is a panel user.
 *
 * Timing posture — every pending-invite row is scanned and compared with
 * `timingSafeEqual`, with no early exit, so the work does not depend on WHICH
 * row matches. (It still depends on how many invites are outstanding, which
 * leaks nothing about the token.)
 *
 * Single use — redemption is a compare-and-swap: `updateMany` matches on both
 * the id AND the exact sentinel it read, so two concurrent redemptions of the
 * same link produce one winner and one generic failure.
 */
import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { apiError, withErrorHandling } from "@/lib/api-helpers";
import { audit } from "@/lib/audit";
import { prisma } from "@/lib/db";
import {
  INVITE_PREFIX,
  hashInviteToken,
  isInviteExpired,
  parseInvite,
  tokenHashEquals,
} from "@/lib/users/invite";
import { setPasswordSchema } from "@/lib/users/schema";

const BCRYPT_COST = 12;

const GENERIC_FAILURE =
  "This link is invalid, already used, or has expired. Ask an admin for a new one.";

export const POST = withErrorHandling(async (req: Request) => {
  const raw = await req.json().catch(() => null);
  if (raw === null || typeof raw !== "object") {
    return apiError(400, "Invalid request — body must be a JSON object");
  }
  const body = setPasswordSchema.parse(raw);
  const tokenHash = hashInviteToken(body.token);
  const now = Date.now();

  // Every row whose credential column currently holds an invite sentinel.
  const pending = await prisma.panelUser.findMany({
    where: { passwordHash: { startsWith: INVITE_PREFIX } },
  });

  let matched: (typeof pending)[number] | null = null;
  for (const candidate of pending) {
    const invite = parseInvite(candidate.passwordHash);
    if (!invite) continue;
    const sameToken = tokenHashEquals(invite.tokenHash, tokenHash);
    const live = !isInviteExpired(invite, now);
    // No early break — the loop cost must not reveal the match position.
    if (sameToken && live && matched === null) matched = candidate;
  }

  if (!matched) return apiError(400, GENERIC_FAILURE);

  const passwordHash = await bcrypt.hash(body.password, BCRYPT_COST);
  const swap = await prisma.panelUser.updateMany({
    // Compare-and-swap: the sentinel must still be the one we matched.
    where: { id: matched.id, passwordHash: matched.passwordHash },
    data: { passwordHash },
  });
  if (swap.count !== 1) return apiError(400, GENERIC_FAILURE);

  await audit({
    userId: matched.id,
    userEmail: matched.email,
    action: "user.password_set",
    targetType: "user",
    targetId: matched.id,
    metadata: { email: matched.email },
  });

  return NextResponse.json({ ok: true });
});
