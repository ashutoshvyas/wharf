/**
 * NextAuth v5 setup — full config with the Credentials provider.
 *
 * Split-config pattern: the edge-safe half (session/cookies/callbacks/pages)
 * lives in auth.config.ts and is shared with middleware.ts; this file adds
 * the DB-backed authorize() and is what routes / server actions import.
 *
 * authorize() security posture:
 * - Generic failure only: returns null for bad email, bad password, malformed
 *   input AND active lockout — the UI shows one message ("Invalid email or
 *   password.") and never reveals whether an account exists.
 * - Timing equalization: bcrypt.compare always runs (against a dummy hash
 *   when the email is unknown) so response time doesn't leak existence.
 * - Rate limiting: checked BEFORE the compare; failures recorded
 *   after a bad attempt; cleared on success. 'auth.lockout' is audited once
 *   per lockout episode (recordFailure signals the transition exactly once).
 * - Every bad attempt is audited as 'auth.login_failed' with the email only
 *   (no user id — again, no existence signal in the audit trail either).
 */
import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { z } from "zod";
import authConfig from "@/auth.config";
import { audit } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { clearFailures, isLocked, recordFailure } from "@/lib/rate-limit";
import type { Role } from "@/lib/rbac";

const credentialsSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email()),
  password: z.string().min(1),
});

// Valid bcrypt hash (cost 12) of a throwaway string — compared against when
// the email doesn't exist, so unknown-email and wrong-password take the same
// time. Never matches a real password.
const DUMMY_HASH = "$2b$12$prY0L5/.lOvnoyrIlFBpWeDY1h/askiEPGaqlD/vkCgt74y//gcdW";

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const parsed = credentialsSchema.safeParse(credentials);
        if (!parsed.success) return null;
        const { email, password } = parsed.data;

        // Locked out: refuse before touching the DB or bcrypt. No audit row
        // per blocked attempt — the episode was audited once at lock time.
        if (isLocked(email)) return null;

        const user = await prisma.panelUser.findUnique({ where: { email } });
        const passwordOk = await bcrypt.compare(
          password,
          user?.passwordHash ?? DUMMY_HASH,
        );

        if (!user || !passwordOk) {
          const { lockoutTriggered } = recordFailure(email);
          await audit({
            userEmail: email,
            action: "auth.login_failed",
            targetType: "auth",
          });
          if (lockoutTriggered) {
            await audit({
              userEmail: email,
              action: "auth.lockout",
              targetType: "auth",
              metadata: { windowMinutes: 15, lockoutMinutes: 15 },
            });
          }
          return null;
        }

        clearFailures(email);
        return { id: user.id, email: user.email, role: user.role as Role };
      },
    }),
  ],
});
