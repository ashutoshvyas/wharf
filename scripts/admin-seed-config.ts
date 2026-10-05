import { passwordSchema, userEmailSchema } from "../lib/users/schema";

const TEMPLATE_PASSWORDS = new Set(["change-me", "change-me-now"]);

/** Reject missing/template credentials before the seed opens a database session. */
export function adminSeedConfig(env: Record<string, string | undefined>) {
  const email = userEmailSchema.safeParse(env.ADMIN_EMAIL);
  if (!email.success) {
    throw new Error("ADMIN_EMAIL must be set to a valid administrator email.");
  }

  const rawPassword = env.ADMIN_PASSWORD ?? "";
  const password = passwordSchema.safeParse(rawPassword);
  if (
    !password.success ||
    TEMPLATE_PASSWORDS.has(rawPassword.trim().toLowerCase()) ||
    Buffer.byteLength(rawPassword, "utf8") > 72
  ) {
    throw new Error(
      "ADMIN_PASSWORD must be a unique passphrase of at least 12 characters, " +
        "at most 72 UTF-8 bytes, and must not be a template password.",
    );
  }

  return { adminEmail: email.data, adminPassword: password.data };
}
