/**
 * Verification for GoTrue's send-SMS hook calls.
 *
 * GoTrue signs HTTP hook requests with the Standard Webhooks scheme: the
 * signed payload is `{webhook-id}.{webhook-timestamp}.{body}`, HMAC-SHA256'd
 * with the raw bytes behind the `whsec_` prefix, base64-encoded, and sent as
 * a space-separated list of `v1,<sig>` entries in `webhook-signature` (a list,
 * because a secret rotation can leave two valid at once).
 *
 * This matters more than it does for the email-template route: that one only
 * serves markup, whereas an unauthenticated call here makes the panel send a
 * real SMS on the operator's account. Verification is what stops this route
 * from being a way to spend someone else's SMS credit.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** Reject anything older than this, so a captured call cannot be replayed later. */
export const MAX_SKEW_SECONDS = 5 * 60;

export interface HookHeaders {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
}

export type VerifyResult = { ok: true } | { ok: false; reason: string };

/**
 * @param secret the derived secret WITHOUT the `v1,whsec_` prefix — i.e.
 *   exactly what lib/provision/secrets.ts produced.
 */
export function verifyHookSignature(
  secret: string,
  headers: HookHeaders,
  rawBody: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): VerifyResult {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) {
    return { ok: false, reason: "Missing webhook-id, webhook-timestamp or webhook-signature." };
  }

  const sentAt = Number(timestamp);
  if (!Number.isFinite(sentAt)) {
    return { ok: false, reason: "webhook-timestamp is not a number." };
  }
  if (Math.abs(nowSeconds - sentAt) > MAX_SKEW_SECONDS) {
    return { ok: false, reason: "webhook-timestamp is outside the allowed window." };
  }

  // The key is the DECODED bytes: GoTrue passes `whsec_<value>` straight to
  // standard-webhooks, which strips the prefix and base64-decodes it.
  const expected = createHmac("sha256", Buffer.from(secret, "base64"))
    .update(`${id}.${timestamp}.${rawBody}`)
    .digest("base64");

  // `v1,<sig>, v1,<sig>` — GoTrue joins with ", ", and any one matching is
  // enough (two are valid at once across a secret rotation).
  for (const raw of signature.split(/\s+/)) {
    const entry = raw.replace(/,+$/, "");
    const [version, candidate] = entry.split(",", 2);
    if (version !== "v1" || !candidate) continue;
    if (equalsConstantTime(candidate, expected)) return { ok: true };
  }
  return { ok: false, reason: "No signature matched." };
}

/** Length-safe: timingSafeEqual throws when the two buffers differ in size. */
function equalsConstantTime(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
