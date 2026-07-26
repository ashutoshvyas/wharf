/**
 * Invite / password-reset tokens — stored WITHOUT a schema migration.
 *
 * ── Why a sentinel instead of a table ───────────────────────────────────────
 * `PanelUser` has exactly one credential column (`passwordHash`) and this
 * milestone may not migrate the schema. A pending invite is therefore encoded
 * *into that column* as a sentinel string:
 *
 *     invite$<sha256-hex-of-token>$<expiryEpochMs>
 *
 * This is unambiguous and cannot collide with a real credential:
 *
 *  1. Every bcrypt hash produced by bcryptjs begins with `$2` (`$2a$`/`$2b$`/
 *     `$2y$`). A sentinel begins with the literal letter `i`, so the two
 *     namespaces are disjoint by the FIRST character — no prefix ambiguity,
 *     no length coincidence.
 *  2. `bcrypt.compare(anything, "invite$…")` returns **false** (bcryptjs
 *     rejects the malformed salt and resolves false rather than throwing —
 *     verified). So `lib/auth.ts` needs no change and no knowledge of this
 *     encoding: a user holding a pending invite simply cannot sign in, and
 *     the failure is indistinguishable from a wrong password (it even keeps
 *     the same timing path, since compare still runs).
 *  3. Only the SHA-256 of the raw token is persisted. The raw token is
 *     returned to the admin exactly once (in the create/reset response) and
 *     is unrecoverable from the database, so a DB read cannot be replayed
 *     into an account takeover. SHA-256 (not bcrypt) is correct here: the
 *     token is 256 bits of CSPRNG output, so it has no guessable structure to
 *     protect with a slow KDF, and redemption must stay cheap enough to
 *     compare against every pending row.
 *
 * Redemption overwrites `passwordHash` with a real bcrypt hash, which is what
 * makes the token single-use: the sentinel is gone.
 *
 * If a future migration adds a proper `invite_token` table, only this file
 * and the three call sites in app/api/users/** change.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Sentinel namespace marker — deliberately NOT `$…` so bcrypt can't collide. */
export const INVITE_PREFIX = "invite$";

/** Invites and reset links live for 48 hours (design §5.11 copy says so too). */
export const INVITE_TTL_MS = 48 * 60 * 60 * 1000;

/** 32 bytes = 256 bits of entropy, url-safe. */
const TOKEN_BYTES = 32;

export interface ParsedInvite {
  /** Lowercase hex SHA-256 of the raw token. */
  tokenHash: string;
  /** Absolute expiry, epoch milliseconds. */
  expiresAtMs: number;
}

/** Cryptographically random, URL-safe invite token (the raw secret). */
export function generateInviteToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/** Lowercase hex SHA-256 — the only form of the token that touches the DB. */
export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Build the `passwordHash` sentinel for a pending invite. */
export function encodeInvite(tokenHash: string, expiresAtMs: number): string {
  return `${INVITE_PREFIX}${tokenHash}$${Math.trunc(expiresAtMs)}`;
}

/** True when this credential column currently holds an invite, not a password. */
export function isInviteSentinel(passwordHash: string): boolean {
  return passwordHash.startsWith(INVITE_PREFIX);
}

/**
 * Parse a sentinel back into its parts. Returns null for a real bcrypt hash
 * or for a malformed sentinel (defensive — a hand-edited row must never be
 * treated as a live invite).
 */
export function parseInvite(passwordHash: string): ParsedInvite | null {
  if (!isInviteSentinel(passwordHash)) return null;
  const rest = passwordHash.slice(INVITE_PREFIX.length);
  const sep = rest.lastIndexOf("$");
  if (sep <= 0) return null;
  const tokenHash = rest.slice(0, sep);
  const expiry = rest.slice(sep + 1);
  if (!/^[0-9a-f]{64}$/.test(tokenHash)) return null;
  if (!/^\d+$/.test(expiry)) return null;
  const expiresAtMs = Number(expiry);
  if (!Number.isSafeInteger(expiresAtMs)) return null;
  return { tokenHash, expiresAtMs };
}

export function isInviteExpired(
  invite: ParsedInvite,
  now: number = Date.now(),
): boolean {
  return invite.expiresAtMs <= now;
}

export interface NewInvite {
  /** Raw token — shown to the admin once, never stored. */
  token: string;
  /** Value to write into `PanelUser.passwordHash`. */
  passwordHash: string;
  expiresAtMs: number;
}

/** Mint a fresh invite (used by user create AND password reset). */
export function createInvite(now: number = Date.now()): NewInvite {
  const token = generateInviteToken();
  const expiresAtMs = now + INVITE_TTL_MS;
  return {
    token,
    passwordHash: encodeInvite(hashInviteToken(token), expiresAtMs),
    expiresAtMs,
  };
}

/**
 * Constant-time comparison of two hex digests. Length-mismatched input
 * returns false without touching timingSafeEqual (which throws on unequal
 * lengths) — the digests are fixed-width, so a mismatch is malformed data,
 * not a guess.
 */
export function tokenHashEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/**
 * `${PANEL_URL}/invite/<rawToken>` — the link the admin hands to the invitee.
 * Trailing slashes on PANEL_URL are trimmed so the path never doubles up.
 */
export function inviteUrl(token: string, panelUrl?: string): string {
  const base = (panelUrl ?? process.env.PANEL_URL ?? "").replace(/\/+$/, "");
  return `${base}/invite/${token}`;
}
