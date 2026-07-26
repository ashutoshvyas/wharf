"use client";

import { useActionState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { loginAction, type LoginState } from "../actions";

const INPUT_CLASSES =
  "h-10 w-full rounded-sm border border-neutral-200 bg-white px-3 text-sm text-ink " +
  "transition-[border-color,box-shadow] duration-150 " +
  "focus:border-cobalt-400 focus:shadow-[0_0_0_2px_rgba(92,120,227,0.25)] focus:outline-none";

const initialState: LoginState = { error: null };

export function LoginForm({ returnTo }: { returnTo?: string }) {
  const [state, formAction, pending] = useActionState(loginAction, initialState);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      {state.error ? <Alert variant="danger">{state.error}</Alert> : null}

      <input type="hidden" name="returnTo" value={returnTo ?? ""} />

      <div>
        <label htmlFor="login-email" className="label-track mb-1.5 block text-neutral-500">
          Email
        </label>
        <input
          id="login-email"
          name="email"
          type="email"
          required
          autoComplete="username"
          autoFocus
          className={INPUT_CLASSES}
        />
      </div>

      <div>
        <label htmlFor="login-password" className="label-track mb-1.5 block text-neutral-500">
          Password
        </label>
        <input
          id="login-password"
          name="password"
          type="password"
          required
          autoComplete="current-password"
          className={INPUT_CLASSES}
        />
      </div>

      <Button type="submit" disabled={pending} className="mt-1.5 w-full">
        {pending ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  );
}
