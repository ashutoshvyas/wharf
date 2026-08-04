import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MAX_SKEW_SECONDS, verifyHookSignature } from "./hook-signature";

const SECRET = Buffer.from("a".repeat(32), "utf8").toString("base64");
const NOW = 1_800_000_000;

/**
 * Reproduces what GoTrue does: strip `v1,`, hand `whsec_<value>` to
 * standard-webhooks, which strips the prefix, base64-DECODES the remainder
 * into the HMAC key, and signs `{id}.{timestamp}.{body}`.
 */
function sign(body: string, id = "msg_1", timestamp = String(NOW), secret = SECRET): string {
  return createHmac("sha256", Buffer.from(secret, "base64"))
    .update(`${id}.${timestamp}.${body}`)
    .digest("base64");
}

const headersFor = (body: string, overrides: Partial<Record<string, string>> = {}) => ({
  id: overrides.id ?? "msg_1",
  timestamp: overrides.timestamp ?? String(NOW),
  signature: overrides.signature ?? `v1,${sign(body)}`,
});

describe("verifyHookSignature", () => {
  const body = JSON.stringify({ sms: { otp: "123456", phone: "919999999999" } });

  it("accepts a correctly signed request", () => {
    expect(verifyHookSignature(SECRET, headersFor(body), body, NOW)).toEqual({ ok: true });
  });

  it("accepts a match anywhere in the list GoTrue sends during a rotation", () => {
    // GoTrue joins with ", ", so entries carry a trailing comma once split.
    const signature = `v1,${sign(body, "msg_1", String(NOW), Buffer.from("b".repeat(32)).toString("base64"))}, v1,${sign(body)}`;
    expect(verifyHookSignature(SECRET, headersFor(body, { signature }), body, NOW)).toEqual({
      ok: true,
    });
  });

  it("rejects a body altered after signing", () => {
    const tampered = JSON.stringify({ sms: { otp: "000000", phone: "919999999999" } });
    const res = verifyHookSignature(SECRET, headersFor(body), tampered, NOW);
    expect(res).toEqual({ ok: false, reason: "No signature matched." });
  });

  it("rejects a signature made with a different instance's secret", () => {
    const other = Buffer.from("z".repeat(32), "utf8").toString("base64");
    const signature = `v1,${sign(body, "msg_1", String(NOW), other)}`;
    expect(verifyHookSignature(SECRET, headersFor(body, { signature }), body, NOW).ok).toBe(
      false,
    );
  });

  it("rejects a replay from outside the timestamp window", () => {
    const stale = String(NOW - MAX_SKEW_SECONDS - 1);
    const signature = `v1,${sign(body, "msg_1", stale)}`;
    const res = verifyHookSignature(
      SECRET,
      headersFor(body, { timestamp: stale, signature }),
      body,
      NOW,
    );
    expect(res).toEqual({
      ok: false,
      reason: "webhook-timestamp is outside the allowed window.",
    });
  });

  it("rejects missing headers rather than treating them as unsigned", () => {
    for (const missing of ["id", "timestamp", "signature"] as const) {
      const headers = { ...headersFor(body), [missing]: null };
      expect(verifyHookSignature(SECRET, headers, body, NOW).ok).toBe(false);
    }
  });

  it("rejects an unknown signature version", () => {
    const signature = `v2,${sign(body)}`;
    expect(verifyHookSignature(SECRET, headersFor(body, { signature }), body, NOW).ok).toBe(
      false,
    );
  });
});
