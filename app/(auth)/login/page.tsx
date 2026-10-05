/**
 * Login screen (design §5.1) — centered card on neutral-50 with the
 * .bg-grid-ink brand backdrop. Wordmark, email + password, primary button,
 * generic danger alert on failure. Nothing else.
 */
import type { Metadata } from "next";
import { LoginForm } from "./login-form";

export const metadata: Metadata = {
  title: "Sign in — WHARF",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string }>;
}) {
  const { returnTo } = await searchParams;

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
          Hosting control plane — sign in to continue.
        </p>
        <LoginForm returnTo={returnTo} />
      </div>
    </main>
  );
}
