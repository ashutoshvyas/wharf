/**
 * OpenSSH public-key encoding for ed25519.
 *
 * The `authorized_keys` line format is:
 *   ssh-ed25519 <base64(wire)> <comment>
 * where wire = uint32BE(11) ‖ "ssh-ed25519" ‖ uint32BE(32) ‖ raw 32-byte key
 * (RFC 4253 §6.6 string encoding).
 */
import type { KeyObject } from "node:crypto";

const KEY_TYPE = "ssh-ed25519";

function lengthPrefixed(data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  return Buffer.concat([len, data]);
}

/** Extract the raw 32-byte ed25519 public key from a Node KeyObject. */
export function rawEd25519PublicKey(publicKey: KeyObject): Buffer {
  const jwk = publicKey.export({ format: "jwk" });
  if (typeof jwk.x !== "string") {
    throw new Error("Expected an ed25519 public key with a JWK 'x' component");
  }
  const raw = Buffer.from(jwk.x, "base64url");
  if (raw.length !== 32) {
    throw new Error(`ed25519 public key must be 32 bytes (got ${raw.length})`);
  }
  return raw;
}

/** Encode an ed25519 public KeyObject as an OpenSSH authorized_keys line. */
export function toOpenSshPublicKey(
  publicKey: KeyObject,
  comment = "wharf-panel",
): string {
  const raw = rawEd25519PublicKey(publicKey);
  const wire = Buffer.concat([
    lengthPrefixed(Buffer.from(KEY_TYPE, "ascii")),
    lengthPrefixed(raw),
  ]);
  return `${KEY_TYPE} ${wire.toString("base64")} ${comment}`;
}
