"use server";

/**
 * Login server action — wraps Auth.js v5 signIn('credentials').
 *
 * v5 quirk: on success signIn THROWS Next's redirect error (NEXT_REDIRECT)
 * to perform the navigation, and on bad credentials it throws an AuthError
 * subclass (CredentialsSignin when authorize() returns null; errors thrown
 * inside authorize() surface as CallbackRouteError). So: catch AuthError →
 * generic message; rethrow everything else so the redirect happens.
 */
import { AuthError } from "next-auth";
import { signIn } from "@/lib/auth";
import { safeReturnTo } from "./return-to";

export interface LoginState {
  error: string | null;
}

export async function loginAction(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const redirectTo = safeReturnTo(formData.get("returnTo"));

  try {
    await signIn("credentials", {
      email: formData.get("email"),
      password: formData.get("password"),
      redirectTo,
    });
    // Unreachable — signIn redirects on success.
    return { error: null };
  } catch (error) {
    if (error instanceof AuthError) {
      // Deliberately generic — never reveal whether the email exists or the
      // account is locked (design §5.1 / architecture §6).
      return { error: "Invalid email or password." };
    }
    throw error; // NEXT_REDIRECT and genuine failures propagate
  }
}
