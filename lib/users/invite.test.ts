/**
 * Invite sentinel encode/parse + expiry.
 *
 * The load-bearing claim this file protects: a sentinel can never be mistaken
 * for a bcrypt hash, and bcrypt.compare() against one is false — which is the
 * only reason lib/auth.ts needs no change to keep un-redeemed accounts out.
 */
import { describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import {
  INVITE_PREFIX,
  INVITE_TTL_MS,
  createInvite,
  encodeInvite,
  generateInviteToken,
  hashInviteToken,
  inviteUrl,
  isInviteExpired,
  isInviteSentinel,
  parseInvite,
  tokenHashEquals,
} from "./invite";

const HEX64 = "a".repeat(64);

describe("token generation + hashing", () => {
  it("mints url-safe, non-repeating tokens", () => {
    const a = generateInviteToken();
    const b = generateInviteToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    // 32 bytes → 43 base64url chars.
    expect(a.length).toBe(43);
  });

  it("hashes to a stable lowercase hex sha256", () => {
    const digest = hashInviteToken("token-abc");
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(hashInviteToken("token-abc")).toBe(digest);
    expect(hashInviteToken("token-abd")).not.toBe(digest);
  });
});

describe("sentinel encoding", () => {
  it("round-trips through parseInvite", () => {
    const expiry = 1_800_000_000_000;
    const encoded = encodeInvite(HEX64, expiry);
    expect(encoded).toBe(`invite$${HEX64}$${expiry}`);
    expect(parseInvite(encoded)).toEqual({
      tokenHash: HEX64,
      expiresAtMs: expiry,
    });
  });

  it("cannot collide with a bcrypt hash — the namespaces differ at char 0", async () => {
    const bcryptHash = await bcrypt.hash("correct horse battery staple", 4);
    expect(bcryptHash.startsWith("$2")).toBe(true);
    expect(INVITE_PREFIX.startsWith("$")).toBe(false);
    expect(isInviteSentinel(bcryptHash)).toBe(false);
    expect(parseInvite(bcryptHash)).toBeNull();
  });

  it("keeps a pending invite unusable as a login credential", async () => {
    const invite = createInvite();
    // lib/auth.ts does exactly this — it must be false, and must not throw.
    await expect(bcrypt.compare(invite.token, invite.passwordHash)).resolves.toBe(
      false,
    );
    await expect(bcrypt.compare("", invite.passwordHash)).resolves.toBe(false);
    await expect(
      bcrypt.compare("any password at all", invite.passwordHash),
    ).resolves.toBe(false);
  });

  it("rejects malformed sentinels rather than treating them as live", () => {
    for (const bad of [
      "invite$",
      "invite$$1800000000000",
      `invite$${HEX64}`,
      `invite$${HEX64}$`,
      `invite$${HEX64}$notanumber`,
      `invite$${"z".repeat(64)}$1800000000000`, // non-hex digest
      `invite$${"a".repeat(63)}$1800000000000`, // wrong digest length
      "$2b$12$abcdefghijklmnopqrstuv",
      "",
    ]) {
      expect(parseInvite(bad)).toBeNull();
    }
  });
});

describe("expiry", () => {
  it("createInvite expires 48 hours out", () => {
    const now = 1_800_000_000_000;
    const invite = createInvite(now);
    expect(invite.expiresAtMs).toBe(now + INVITE_TTL_MS);
    expect(INVITE_TTL_MS).toBe(48 * 60 * 60 * 1000);
  });

  it("is live before the deadline and dead at/after it", () => {
    const now = 1_800_000_000_000;
    const invite = createInvite(now);
    const parsed = parseInvite(invite.passwordHash)!;
    expect(isInviteExpired(parsed, now)).toBe(false);
    expect(isInviteExpired(parsed, now + INVITE_TTL_MS - 1)).toBe(false);
    // Boundary is inclusive — an invite is dead the instant it expires.
    expect(isInviteExpired(parsed, now + INVITE_TTL_MS)).toBe(true);
    expect(isInviteExpired(parsed, now + INVITE_TTL_MS + 1)).toBe(true);
  });

  it("stores only the digest, never the raw token", () => {
    const invite = createInvite();
    expect(invite.passwordHash).not.toContain(invite.token);
    expect(invite.passwordHash).toContain(hashInviteToken(invite.token));
  });
});

describe("tokenHashEquals", () => {
  it("matches identical digests", () => {
    expect(tokenHashEquals(HEX64, HEX64)).toBe(true);
  });

  it("rejects a different digest of the same length", () => {
    expect(tokenHashEquals(HEX64, `b${"a".repeat(63)}`)).toBe(false);
  });

  it("rejects length mismatches without throwing", () => {
    expect(tokenHashEquals(HEX64, "a")).toBe(false);
    expect(tokenHashEquals("", HEX64)).toBe(false);
  });
});

describe("inviteUrl", () => {
  it("builds ${PANEL_URL}/invite/<token>", () => {
    expect(inviteUrl("tok123", "https://panel.wharf.example.com")).toBe(
      "https://panel.wharf.example.com/invite/tok123",
    );
  });

  it("trims trailing slashes so the path never doubles", () => {
    expect(inviteUrl("tok123", "https://panel.wharf.example.com///")).toBe(
      "https://panel.wharf.example.com/invite/tok123",
    );
  });
});
