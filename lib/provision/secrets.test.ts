import { describe, expect, it } from "vitest";
import { jwtVerify } from "jose";
import {
  deriveAnalyticsSecrets,
  deriveAncillarySecrets,
  generateAlphanumeric,
  generateInstanceSecrets,
  generateJwtSecret,
  generatePgPassword,
  JWT_SECRET_BYTES,
  MINIO_ROOT_USER,
  PG_PASSWORD_LENGTH,
  signSupabaseKeys,
  TOKEN_ISSUER,
  TOKEN_LIFETIME_SECONDS,
} from "./secrets";

const ALPHANUMERIC_ONLY = /^[A-Za-z0-9]+$/;

describe("generatePgPassword", () => {
  it("is exactly 32 characters", () => {
    expect(generatePgPassword()).toHaveLength(PG_PASSWORD_LENGTH);
    expect(PG_PASSWORD_LENGTH).toBe(32);
  });

  it("uses only [A-Za-z0-9] across 1000 generated passwords", () => {
    // The password lands unquoted in a .env and inside postgres:// DSNs, so a
    // single `#`, `$`, `@`, `/`, quote or space would break a real deployment.
    for (let i = 0; i < 1000; i += 1) {
      const password = generatePgPassword();
      expect(password).toMatch(ALPHANUMERIC_ONLY);
      expect(password).toHaveLength(PG_PASSWORD_LENGTH);
    }
  });

  it("never emits shell, URL or dotenv metacharacters", () => {
    const joined = Array.from({ length: 200 }, generatePgPassword).join("");
    for (const bad of ["#", "$", "@", "/", ":", "'", '"', "`", "\\", " ", "\n", "%", "&", "=", "?"]) {
      expect(joined).not.toContain(bad);
    }
  });

  it("differs across calls", () => {
    const seen = new Set(Array.from({ length: 500 }, generatePgPassword));
    expect(seen.size).toBe(500);
  });
});

describe("generateAlphanumeric distribution", () => {
  it("shows no modulo bias between the folded and unfolded halves", () => {
    // With `byte % 62` and no rejection, bytes 248..255 would fold onto the
    // first 8 alphabet characters, giving them ~1.6% more mass than the rest.
    // Rejection sampling removes that, so both groups should land within a few
    // percent of their expected share.
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    const sample = generateAlphanumeric(200_000);
    const counts = new Map<string, number>();
    for (const ch of sample) counts.set(ch, (counts.get(ch) ?? 0) + 1);

    // Every character of the alphabet must actually appear.
    expect(counts.size).toBe(alphabet.length);

    const expected = sample.length / alphabet.length;
    // The 8 characters a biased implementation would over-represent.
    const biasedGroup = alphabet.slice(0, 8);
    const biasedTotal = [...biasedGroup].reduce((sum, ch) => sum + (counts.get(ch) ?? 0), 0);
    const biasedRatio = biasedTotal / (expected * 8);
    // A modulo-biased generator sits at ~1.032 here; uniform sits at ~1.000.
    // 200k samples put the sampling noise well under 1%.
    expect(biasedRatio).toBeGreaterThan(0.98);
    expect(biasedRatio).toBeLessThan(1.02);

    // No individual character is wildly off either.
    for (const ch of alphabet) {
      const ratio = (counts.get(ch) ?? 0) / expected;
      expect(ratio).toBeGreaterThan(0.9);
      expect(ratio).toBeLessThan(1.1);
    }
  });

  it("rejects non-positive lengths", () => {
    expect(() => generateAlphanumeric(0)).toThrow(/positive integer/);
    expect(() => generateAlphanumeric(-4)).toThrow(/positive integer/);
    expect(() => generateAlphanumeric(2.5)).toThrow(/positive integer/);
  });
});

describe("generateJwtSecret", () => {
  it("is 40 bytes of hex and comfortably over Supabase's 32-char floor", () => {
    const secret = generateJwtSecret();
    expect(secret).toMatch(/^[0-9a-f]+$/);
    expect(secret).toHaveLength(JWT_SECRET_BYTES * 2);
    expect(secret.length).toBeGreaterThanOrEqual(32);
  });

  it("differs across calls", () => {
    const seen = new Set(Array.from({ length: 200 }, generateJwtSecret));
    expect(seen.size).toBe(200);
  });
});

describe("signSupabaseKeys", () => {
  it("issues tokens that verify against the secret with the right claims", async () => {
    const jwtSecret = generateJwtSecret();
    const { anonKey, serviceRoleKey } = await signSupabaseKeys(jwtSecret);
    const key = new TextEncoder().encode(jwtSecret);
    const before = Math.floor(Date.now() / 1000);

    for (const [token, role] of [
      [anonKey, "anon"],
      [serviceRoleKey, "service_role"],
    ] as const) {
      const { payload, protectedHeader } = await jwtVerify(token, key);
      expect(protectedHeader.alg).toBe("HS256");
      expect(protectedHeader.typ).toBe("JWT");
      expect(payload.role).toBe(role);
      expect(payload.iss).toBe(TOKEN_ISSUER);
      expect(payload.iss).toBe("supabase");

      const iat = payload.iat as number;
      const exp = payload.exp as number;
      expect(iat).toBeLessThanOrEqual(before + 1);
      expect(iat).toBeGreaterThan(before - 30);
      expect(exp - iat).toBe(TOKEN_LIFETIME_SECONDS);
      // ~10 years out.
      expect(exp - iat).toBe(60 * 60 * 24 * 365 * 10);
    }
  });

  it("shares a single iat between the two keys", async () => {
    const { anonKey, serviceRoleKey } = await signSupabaseKeys(generateJwtSecret());
    const decode = (t: string) =>
      JSON.parse(Buffer.from(t.split(".")[1] ?? "", "base64url").toString("utf8"));
    expect(decode(anonKey).iat).toBe(decode(serviceRoleKey).iat);
    expect(decode(anonKey).exp).toBe(decode(serviceRoleKey).exp);
  });

  it("does not verify against a different secret", async () => {
    const { anonKey } = await signSupabaseKeys(generateJwtSecret());
    const wrong = new TextEncoder().encode(generateJwtSecret());
    await expect(jwtVerify(anonKey, wrong)).rejects.toThrow();
  });

  it("rejects a too-short secret", async () => {
    await expect(signSupabaseKeys("short")).rejects.toThrow(/at least 32/);
    await expect(signSupabaseKeys("")).rejects.toThrow(/at least 32/);
  });
});

describe("generateInstanceSecrets", () => {
  it("returns all four values, correctly shaped", async () => {
    const secrets = await generateInstanceSecrets();
    expect(Object.keys(secrets).sort()).toEqual([
      "anonKey",
      "jwtSecret",
      "pgPassword",
      "serviceRoleKey",
    ]);
    expect(secrets.pgPassword).toMatch(ALPHANUMERIC_ONLY);
    expect(secrets.pgPassword).toHaveLength(PG_PASSWORD_LENGTH);
    expect(secrets.jwtSecret).toHaveLength(JWT_SECRET_BYTES * 2);
    expect(secrets.anonKey.split(".")).toHaveLength(3);
    expect(secrets.serviceRoleKey.split(".")).toHaveLength(3);
  });

  it("signs its keys with its own jwtSecret", async () => {
    const secrets = await generateInstanceSecrets();
    const key = new TextEncoder().encode(secrets.jwtSecret);
    await expect(jwtVerify(secrets.anonKey, key)).resolves.toBeTruthy();
    await expect(jwtVerify(secrets.serviceRoleKey, key)).resolves.toBeTruthy();
  });

  it("produces different secrets on every call", async () => {
    const a = await generateInstanceSecrets();
    const b = await generateInstanceSecrets();
    expect(a.pgPassword).not.toBe(b.pgPassword);
    expect(a.jwtSecret).not.toBe(b.jwtSecret);
    expect(a.anonKey).not.toBe(b.anonKey);
    expect(a.serviceRoleKey).not.toBe(b.serviceRoleKey);
    expect(a.anonKey).not.toBe(a.serviceRoleKey);
  });
});

describe("deriveAncillarySecrets", () => {
  it("is deterministic for a given jwtSecret", () => {
    const secret = generateJwtSecret();
    expect(deriveAncillarySecrets(secret)).toEqual(deriveAncillarySecrets(secret));
  });

  it("gives every instance distinct values", () => {
    const a = deriveAncillarySecrets(generateJwtSecret());
    const b = deriveAncillarySecrets(generateJwtSecret());
    for (const key of Object.keys(a) as (keyof typeof a)[]) {
      expect(a[key]).not.toBe(b[key]);
    }
  });

  it("meets each service's length requirement and is domain-separated", () => {
    const derived = deriveAncillarySecrets(generateJwtSecret());
    expect(derived.secretKeyBase.length).toBeGreaterThanOrEqual(64);
    expect(derived.realtimeDbEncKey).toHaveLength(16); // Realtime requires exactly 16
    expect(derived.pgMetaCryptoKey.length).toBeGreaterThanOrEqual(32);
    expect(derived.s3AccessKeySecret.length).toBeGreaterThanOrEqual(32);

    const values = Object.values(derived);
    expect(new Set(values).size).toBe(values.length);
    // smsHookSecret is the one deliberate exception: it is rendered as
    // `v1,whsec_<value>` and GoTrue base64-DECODES it into the HMAC key, so
    // it must be standard base64 (which includes +, / and =) rather than the
    // hex every other value here uses.
    const { smsHookSecret, ...alphanumeric } = derived;
    for (const value of Object.values(alphanumeric)) expect(value).toMatch(ALPHANUMERIC_ONLY);
    expect(smsHookSecret).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(Buffer.from(smsHookSecret, "base64")).toHaveLength(32);
  });

  it("never reuses upstream's published example values", () => {
    const derived = deriveAncillarySecrets(generateJwtSecret());
    expect(derived.realtimeDbEncKey).not.toBe("supabaserealtime");
    expect(derived.secretKeyBase).not.toBe(
      "UpNVntn3cDxHJpq99YMc1T1AQgQpc8kfYTuRgBiYa15BLrx8etQoXz3gZv1/u2oq",
    );
  });

  it("rejects a too-short secret", () => {
    expect(() => deriveAncillarySecrets("short")).toThrow(/at least 32/);
  });
});

describe("deriveAnalyticsSecrets", () => {
  it("is deterministic for a given jwtSecret", () => {
    const secret = generateJwtSecret();
    expect(deriveAnalyticsSecrets(secret)).toEqual(deriveAnalyticsSecrets(secret));
  });

  it("gives every instance distinct values", () => {
    const a = deriveAnalyticsSecrets(generateJwtSecret());
    const b = deriveAnalyticsSecrets(generateJwtSecret());
    for (const key of Object.keys(a) as (keyof typeof a)[]) {
      expect(a[key]).not.toBe(b[key]);
    }
  });

  it("is domain-separated from deriveAncillarySecrets (same jwtSecret, different labels)", () => {
    const secret = generateJwtSecret();
    const analytics = deriveAnalyticsSecrets(secret);
    const ancillary = deriveAncillarySecrets(secret);
    const analyticsValues = Object.values(analytics);
    const ancillaryValues = Object.values(ancillary);
    for (const v of analyticsValues) expect(ancillaryValues).not.toContain(v);
  });

  it("produces alphanumeric-only values with sane lengths", () => {
    const derived = deriveAnalyticsSecrets(generateJwtSecret());
    expect(derived.minioRootPassword).toHaveLength(32);
    expect(derived.icebergCatalogToken).toHaveLength(40);
    expect(derived.lakekeeperPgEncryptionKey).toHaveLength(32);
    for (const value of Object.values(derived)) expect(value).toMatch(ALPHANUMERIC_ONLY);
  });

  it("rejects a too-short secret", () => {
    expect(() => deriveAnalyticsSecrets("short")).toThrow(/at least 32/);
  });
});

describe("MINIO_ROOT_USER", () => {
  it("is a fixed, non-empty constant", () => {
    expect(MINIO_ROOT_USER).toBe("wharf-minio-root");
  });
});
