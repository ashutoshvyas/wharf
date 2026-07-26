import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { rawEd25519PublicKey, toOpenSshPublicKey } from "./openssh";

describe("toOpenSshPublicKey", () => {
  it("produces the canonical ssh-ed25519 prefix", () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const line = toOpenSshPublicKey(publicKey);
    expect(line).toMatch(/^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5/);
    expect(line.endsWith(" wharf-panel")).toBe(true);
  });

  it("round-trips the two RFC 4253 length-prefixed fields", () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const b64 = toOpenSshPublicKey(publicKey).split(" ")[1] ?? "";
    const wire = Buffer.from(b64, "base64");

    const typeLen = wire.readUInt32BE(0);
    expect(typeLen).toBe(11);
    const type = wire.subarray(4, 4 + typeLen).toString("ascii");
    expect(type).toBe("ssh-ed25519");

    const keyLen = wire.readUInt32BE(4 + typeLen);
    expect(keyLen).toBe(32);
    const raw = wire.subarray(4 + typeLen + 4, 4 + typeLen + 4 + keyLen);
    expect(raw.length).toBe(32);
    expect(raw.equals(rawEd25519PublicKey(publicKey))).toBe(true);

    // Nothing after the second field.
    expect(wire.length).toBe(4 + typeLen + 4 + keyLen);
  });

  it("honors a custom comment", () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    expect(toOpenSshPublicKey(publicKey, "ops@wharf").endsWith(" ops@wharf")).toBe(true);
  });
});
