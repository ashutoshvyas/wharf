"use client";

/**
 * Invite redemption form. Posts {token, password} to the public
 * POST /api/users/set-password and, on success, swaps itself for a "you're
 * set" panel linking to /login.
 *
 * The API answers with ONE generic message for every rejection (unknown /
 * expired / already-used token) — this component renders it verbatim in a
 * danger Alert rather than trying to interpret it, so the UI cannot leak more
 * than the API chose to.
 */
import { useState, type FormEvent } from "react";
import Link from "next/link";
import { CircleCheck } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button, ButtonLink } from "@/components/ui/button";
import { PASSWORD_MIN_LENGTH } from "@/lib/users/schema";

const INPUT_CLASSES =
  "h-10 w-full rounded-sm border border-neutral-200 bg-white px-3 text-sm text-ink " +
  "transition-[border-color,box-shadow] duration-150 " +
  "focus:border-cobalt-400 focus:shadow-[0_0_0_2px_rgba(92,120,227,0.25)] focus:outline-none";

export function SetPasswordForm({ token }: { token: string }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);

    if (password.length < PASSWORD_MIN_LENGTH) {
      setError(`Password must be at least ${PASSWORD_MIN_LENGTH} characters.`);
      return;
    }
    if (password !== confirm) {
      setError("The two passwords do not match.");
      return;
    }

    setPending(true);
    try {
      const res = await fetch("/api/users/set-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      if (!res.ok) {
        let message = `Request failed (${res.status}).`;
        try {
          const body: unknown = await res.json();
          if (
            body &&
            typeof body === "object" &&
            typeof (body as { error?: unknown }).error === "string"
          ) {
            message = (body as { error: string }).error;
          }
        } catch {
          // keep the generic message
        }
        setError(message);
        return;
      }
      setDone(true);
    } catch {
      setError("Could not reach the panel. Check your connection and retry.");
    } finally {
      setPending(false);
    }
  }

  if (done) {
    return (
      <div className="flex flex-col gap-4">
        <Alert variant="success" title="Password set" icon={<CircleCheck size={17} strokeWidth={1.75} />}>
          Your account is ready. Sign in with your email and the password you
          just chose.
        </Alert>
        <ButtonLink href="/login" className="w-full">
          Go to sign in
        </ButtonLink>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      {error ? <Alert variant="danger">{error}</Alert> : null}

      <div>
        <label
          htmlFor="invite-password"
          className="label-track mb-1.5 block text-neutral-500"
        >
          New password
        </label>
        <input
          id="invite-password"
          name="password"
          type="password"
          required
          autoFocus
          autoComplete="new-password"
          minLength={PASSWORD_MIN_LENGTH}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className={INPUT_CLASSES}
        />
        <p className="mt-1.5 text-[12px] text-neutral-500">
          At least {PASSWORD_MIN_LENGTH} characters. A passphrase beats a
          short, clever string.
        </p>
      </div>

      <div>
        <label
          htmlFor="invite-confirm"
          className="label-track mb-1.5 block text-neutral-500"
        >
          Confirm password
        </label>
        <input
          id="invite-confirm"
          name="confirm"
          type="password"
          required
          autoComplete="new-password"
          minLength={PASSWORD_MIN_LENGTH}
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          className={INPUT_CLASSES}
        />
      </div>

      <Button type="submit" disabled={pending} className="mt-1.5 w-full">
        {pending ? "Setting password…" : "Set password"}
      </Button>

      <p className="text-center text-[12.5px] text-neutral-500">
        Already have a password?{" "}
        <Link href="/login" className="text-cobalt-600 hover:underline">
          Sign in
        </Link>
      </p>
    </form>
  );
}
