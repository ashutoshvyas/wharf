/**
 * Per-instance secret and API-key generation — the `secrets` phase of
 * docs/provisioning-contract.md §5.
 *
 * Two hard constraints shape this module:
 *
 * 1. **Charset.** Generated values land *unquoted* in a `.env` file that
 *    `docker compose --env-file` reads, and the Postgres password additionally
 *    ends up inside `postgres://user:PASSWORD@host/db` DSNs in that same file.
 *    Restricting the alphabet to `[A-Za-z0-9]` means there is nothing to
 *    escape: no `#` (comment), no `$` (interpolation), no quote, no `@` or `/`
 *    (DSN delimiters), no whitespace or newline.
 * 2. **No modulo bias.** Draws use rejection sampling over `crypto.randomBytes`
 *    so every character of the alphabet is equally likely. `byte % 62` alone
 *    would over-represent the first eight characters by ~1.6%.
 *
 * Nothing here is ever logged. Callers seal these values with lib/crypto before
 * they touch the database (architecture.md §6).
 */
import { createHmac, randomBytes } from "node:crypto";
import { SignJWT } from "jose";

/** 62 characters: shell-, URL- and dotenv-safe by construction. */
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/**
 * Largest multiple of ALPHABET.length that fits in a byte (62 * 4 = 248).
 * Bytes >= this are discarded rather than folded, which is what removes the
 * modulo bias.
 */
const REJECTION_LIMIT = Math.floor(256 / ALPHABET.length) * ALPHABET.length;

/** Postgres password length (contract: 32 chars). */
export const PG_PASSWORD_LENGTH = 32;

/** JWT secret entropy. 40 bytes → 80 hex chars, comfortably over Supabase's 32-char floor. */
export const JWT_SECRET_BYTES = 40;

/** Supabase API keys are long-lived: 10 years, matching upstream's demo keys. */
export const TOKEN_LIFETIME_SECONDS = 60 * 60 * 24 * 365 * 10;

/** `iss` claim on both API keys — what the stock Supabase clients expect. */
export const TOKEN_ISSUER = "supabase";

/**
 * `length` characters drawn uniformly from `[A-Za-z0-9]` via rejection
 * sampling over the CSPRNG. Refills in batches so a long password does not
 * make one `randomBytes` syscall per accepted character.
 */
export function generateAlphanumeric(length: number): string {
  if (!Number.isInteger(length) || length <= 0) {
    throw new Error(`generateAlphanumeric: length must be a positive integer (got ${length}).`);
  }
  let out = "";
  while (out.length < length) {
    // Over-draw by ~1/3 so the loop almost always completes in one pass:
    // the expected rejection rate is (256 - 248) / 256 = 3.1%.
    const batch = randomBytes(Math.max(16, (length - out.length) * 2));
    for (const byte of batch) {
      if (byte >= REJECTION_LIMIT) continue; // biased tail — discard, never fold
      out += ALPHABET.charAt(byte % ALPHABET.length);
      if (out.length === length) break;
    }
  }
  return out;
}

/**
 * Postgres superuser password: 32 chars, `[A-Za-z0-9]` only.
 * See the module header for why the charset is not negotiable.
 */
export function generatePgPassword(): string {
  return generateAlphanumeric(PG_PASSWORD_LENGTH);
}

/** HS256 signing secret for the instance's API keys: 40 random bytes, hex. */
export function generateJwtSecret(): string {
  return randomBytes(JWT_SECRET_BYTES).toString("hex");
}

export interface SupabaseKeys {
  /** `role: anon` JWT — safe to ship to browsers. */
  anonKey: string;
  /** `role: service_role` JWT — bypasses RLS, server-side only. */
  serviceRoleKey: string;
}

/**
 * Sign the two standard Supabase API keys with `jwtSecret` (HS256).
 *
 * Both tokens share one `iat`, so the pair is internally consistent and the
 * `exp` values are identical rather than a second apart.
 */
export async function signSupabaseKeys(jwtSecret: string): Promise<SupabaseKeys> {
  if (!jwtSecret || jwtSecret.length < 32) {
    throw new Error("signSupabaseKeys: jwtSecret must be at least 32 characters.");
  }
  const key = new TextEncoder().encode(jwtSecret);
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + TOKEN_LIFETIME_SECONDS;

  const sign = (role: "anon" | "service_role") =>
    new SignJWT({ role, iss: TOKEN_ISSUER, iat, exp })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .sign(key);

  const [anonKey, serviceRoleKey] = await Promise.all([sign("anon"), sign("service_role")]);
  return { anonKey, serviceRoleKey };
}

export interface InstanceSecrets extends SupabaseKeys {
  /** Postgres superuser password. */
  pgPassword: string;
  /** HS256 secret the two keys above are signed with. */
  jwtSecret: string;
}

/** Everything the `secrets` phase produces for one instance. */
export async function generateInstanceSecrets(): Promise<InstanceSecrets> {
  const pgPassword = generatePgPassword();
  const jwtSecret = generateJwtSecret();
  const { anonKey, serviceRoleKey } = await signSupabaseKeys(jwtSecret);
  return { pgPassword, jwtSecret, anonKey, serviceRoleKey };
}

/**
 * Supporting keys the Supabase services need that are not part of the
 * instance's public contract (Realtime's signing salt, Studio's crypto key,
 * the Storage S3-protocol credentials, Kong's dashboard basic-auth password).
 *
 * These are **derived** from `jwtSecret` via HMAC-SHA-512 rather than drawn
 * fresh, for two reasons:
 *
 *   - Rendering stays a pure function of its inputs, which is what makes the
 *     "render twice, get identical bytes" guarantee in render.ts hold. A retry
 *     therefore re-renders byte-identical files instead of silently rotating
 *     keys under running containers.
 *   - Every instance still gets distinct values. Shipping upstream's
 *     `.env.example` defaults (`supabaserealtime`, the published
 *     `SECRET_KEY_BASE`) would hand every WHARF instance the same publicly
 *     known keys.
 *
 * Domain-separated by label, so no two derived values can ever collide.
 */
export function deriveAncillarySecrets(jwtSecret: string): AncillarySecrets {
  if (!jwtSecret || jwtSecret.length < 32) {
    throw new Error("deriveAncillarySecrets: jwtSecret must be at least 32 characters.");
  }
  const derive = (label: string, chars: number): string =>
    createHmac("sha512", jwtSecret).update(`wharf:${label}`).digest("hex").slice(0, chars);

  return {
    // Phoenix requires >= 64 characters.
    secretKeyBase: derive("secret_key_base", 64),
    // Realtime requires exactly 16 characters.
    realtimeDbEncKey: derive("realtime_db_enc_key", 16),
    // postgres-meta requires >= 32 characters.
    pgMetaCryptoKey: derive("pg_meta_crypto_key", 64),
    s3AccessKeyId: derive("s3_access_key_id", 32),
    s3AccessKeySecret: derive("s3_access_key_secret", 64),
    dashboardPassword: derive("dashboard_password", 32),
  };
}

export interface AncillarySecrets {
  secretKeyBase: string;
  realtimeDbEncKey: string;
  pgMetaCryptoKey: string;
  s3AccessKeyId: string;
  s3AccessKeySecret: string;
  dashboardPassword: string;
}

/**
 * Analytics buckets' (Iceberg, ) supporting secrets — MinIO's root
 * password, the static bearer token storage-api sends to Lakekeeper's
 * Iceberg REST catalog, and Lakekeeper's own at-rest encryption key for its
 * Postgres metadata store. Derived the same way as {@link deriveAncillarySecrets}
 * and for the same reason: these are only ever reachable from inside this
 * instance's own Docker network (Lakekeeper runs "Unsecured" — see
 * templates/supabase/docker-compose.yml), so a fresh independently-rotatable
 * secret would add storage without adding real security — anyone who already
 * has jwtSecret holds the service_role key, i.e. full API/DB access.
 */
export function deriveAnalyticsSecrets(jwtSecret: string): AnalyticsSecrets {
  if (!jwtSecret || jwtSecret.length < 32) {
    throw new Error("deriveAnalyticsSecrets: jwtSecret must be at least 32 characters.");
  }
  const derive = (label: string, chars: number): string =>
    createHmac("sha512", jwtSecret).update(`wharf:${label}`).digest("hex").slice(0, chars);

  return {
    minioRootPassword: derive("minio_root_password", 32),
    icebergCatalogToken: derive("iceberg_catalog_token", 40),
    lakekeeperPgEncryptionKey: derive("lakekeeper_pg_encryption_key", 32),
  };
}

export interface AnalyticsSecrets {
  minioRootPassword: string;
  icebergCatalogToken: string;
  lakekeeperPgEncryptionKey: string;
}

/** Fixed MinIO root username — only the password needs randomness. */
export const MINIO_ROOT_USER = "wharf-minio-root";
