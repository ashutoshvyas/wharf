/**
 * WHARF secrets-at-rest crypto (architecture.md §6).
 *
 * Every encrypted (`*_enc`) column stores a single Buffer with this layout:
 *
 *   ┌──────────────┬─────────────────────┬──────────────────┐
 *   │ iv (12 bytes)│ ciphertext (n bytes)│ authTag (16 bytes)│
 *   └──────────────┴─────────────────────┴──────────────────┘
 *
 * Algorithm: AES-256-GCM (Node `crypto`), fresh random 12-byte IV per seal.
 * The key-rotation tool (scripts/rotate-key.ts) depends on this exact layout —
 * do not change it without migrating every stored value.
 *
 * The master key comes from the WHARF_MASTER_KEY env var (base64, exactly
 * 32 bytes decoded). It is read lazily on first use — never at module import,
 * because Next.js builds import modules without runtime env — and cached
 * afterwards. The key and plaintexts are never logged.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;

let cachedKey: Buffer | null = null;

function getMasterKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = process.env.WHARF_MASTER_KEY;
  if (!raw) {
    throw new Error(
      "WHARF_MASTER_KEY is not set. Provide a base64-encoded 32-byte key " +
        "(generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\").",
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== KEY_LENGTH) {
    throw new Error(
      `WHARF_MASTER_KEY must be a base64-encoded 32-byte key (decoded to ${key.length} bytes).`,
    );
  }
  cachedKey = key;
  return key;
}

/**
 * Encrypt `plaintext` (UTF-8) under an explicit 32-byte key.
 * Returns iv ‖ ciphertext ‖ authTag per the layout above.
 */
export function sealWith(key: Buffer, plaintext: string): Buffer {
  if (key.length !== KEY_LENGTH) {
    throw new Error(`Encryption key must be exactly ${KEY_LENGTH} bytes (got ${key.length}).`);
  }
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, ciphertext, authTag]);
}

/**
 * Decrypt a sealed buffer (iv ‖ ciphertext ‖ authTag) under an explicit
 * 32-byte key. Throws if the buffer is malformed or authentication fails
 * (tampered data or wrong key).
 */
export function openWith(key: Buffer, sealed: Buffer | Uint8Array): string {
  if (key.length !== KEY_LENGTH) {
    throw new Error(`Decryption key must be exactly ${KEY_LENGTH} bytes (got ${key.length}).`);
  }
  const buf = Buffer.isBuffer(sealed) ? sealed : Buffer.from(sealed);
  if (buf.length < IV_LENGTH + TAG_LENGTH) {
    throw new Error(
      `Sealed value is too short (${buf.length} bytes; minimum ${IV_LENGTH + TAG_LENGTH}).`,
    );
  }
  const iv = buf.subarray(0, IV_LENGTH);
  const ciphertext = buf.subarray(IV_LENGTH, buf.length - TAG_LENGTH);
  const authTag = buf.subarray(buf.length - TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}

/** Encrypt `plaintext` under the WHARF master key. */
export function seal(plaintext: string): Buffer {
  return sealWith(getMasterKey(), plaintext);
}

/** Decrypt a sealed buffer under the WHARF master key. Throws on auth failure. */
export function open(sealed: Buffer | Uint8Array): string {
  return openWith(getMasterKey(), sealed);
}

/** Test-only: clear the cached master key so a changed env var is re-read. */
export function __resetKeyCacheForTests(): void {
  cachedKey = null;
}
