/**
 * /invite/<token> — set-password screen (styled after
 * app/(auth)/login: grid-ink backdrop, qube mark, wordmark).
 *
 * PUBLIC (allowlisted in middleware.ts) — the visitor has no session yet by
 * definition. The token is never validated here: doing so server-side would
 * turn this page into an oracle for "is this token real?", and would consume
 * a DB round trip on every crawl. It is validated exactly once, at redemption
 * time, by POST /api/users/set-password.
 */
import type { Metadata } from "next";
import { SetPasswordForm } from "./set-password-form";

export const metadata: Metadata = {
  title: "Set your password — WHARF",
  robots: { index: false, follow: false },
};

export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  return (
    <main className="bg-grid-ink flex min-h-screen items-center justify-center bg-neutral-50 p-5">
      <div className="w-full max-w-[400px] rounded-lg border border-neutral-200 bg-white p-9 shadow-lg">
        <div className="mb-1.5 flex items-center gap-2.5">
          {/* Qube mark — 2x2 grid, one coral spark (prototype .qube) */}
          <div aria-hidden className="grid h-[22px] w-[22px] grid-cols-2 gap-[2px]">
            <span className="rounded-[2px] bg-cobalt-500" />
            <span className="rounded-[2px] bg-coral-500" />
            <span className="rounded-[2px] bg-cobalt-500" />
            <span className="rounded-[2px] bg-cobalt-500" />
          </div>
          <span className="text-[19px] font-extrabold tracking-[-0.02em] text-ink">
            wharf
          </span>
        </div>
        <p className="mb-[26px] text-[13px] text-neutral-500">
          Set a password for your panel account. This link works once and
          expires 48 hours after it was issued.
        </p>
        <SetPasswordForm token={token} />
      </div>
    </main>
  );
}
