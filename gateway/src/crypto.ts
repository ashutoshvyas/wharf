/**
 * Minimal secrets-at-rest decryption for the gateway.
 *
 * layout mirrors lib/crypto.ts — keep in sync
 *
 * Sealed buffer layout (every `*_enc` column):
 *
 *   iv (12 bytes) ‖ ciphertext (n bytes) ‖ authTag (16 bytes)
 *
 * Algorithm: AES-256-GCM. Master key from WHARF_MASTER_KEY (base64, exactly
 * 32 bytes decoded), read lazily on first use and cached. The gateway cannot
 * import the panel's lib/crypto.ts (different tsconfig rootDir), hence this
 * deliberate duplicate of the minimal open() path only — the gateway never
 * seals anything.
 */
import { createDecipheriv } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;

let cachedKey: Buffer | null = null;

function getMasterKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = process.env.WHARF_MASTER_KEY;
  if (!raw) {
    throw new Error("WHARF_MASTER_KEY is not set (base64-encoded 32-byte key).");
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
 * Decrypt a sealed buffer (iv ‖ ciphertext ‖ authTag) under the WHARF master
 * key. Throws if the buffer is malformed or authentication fails.
 * The plaintext is held in memory only for the lifetime of the SSH connect —
 * it is never logged or persisted.
 */
export function open(sealed: Buffer | Uint8Array): string {
  const key = getMasterKey();
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
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
