/**
 * Users API request schemas.
 *
 * - createUserSchema: invite a new panel user (email + role). The email is
 *   trimmed and lowercased before validation so `Foo@Bar.com` and
 *   `foo@bar.com` collide on the unique index rather than creating two rows.
 * - updateUserSchema: role change only. Email is immutable — it is the login
 *   identity and the audit-log join key.
 * - setPasswordSchema: the PUBLIC invite/reset redemption body. 12 characters
 *   minimum (architecture §6 wants a real passphrase, not a PIN); no
 *   composition rules, because length beats character classes.
 */
import { z } from "zod";

export const roleSchema = z.enum(["admin", "operator", "viewer"], {
  message: "must be one of admin, operator, viewer",
});

export type UserRole = z.infer<typeof roleSchema>;

/** Trim + lowercase first, then validate shape and length. */
export const userEmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(
    z
      .email("must be a valid email address")
      .max(160, "must be at most 160 characters"),
  );

/** Minimum length of a redeemed panel password. */
export const PASSWORD_MIN_LENGTH = 12;
/** Upper bound — bcrypt silently truncates past 72 bytes, so refuse earlier. */
export const PASSWORD_MAX_LENGTH = 72;

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `must be at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH, `must be at most ${PASSWORD_MAX_LENGTH} characters`);

export const createUserSchema = z.object({
  email: userEmailSchema,
  role: roleSchema,
});

export const updateUserSchema = z.object({
  role: roleSchema,
});

export const setPasswordSchema = z.object({
  token: z.string().min(1, "token is required").max(200),
  password: passwordSchema,
});

export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
export type SetPasswordInput = z.infer<typeof setPasswordSchema>;
