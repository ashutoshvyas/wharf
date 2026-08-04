/**
 * MSG91 delivery for GoTrue's send-SMS hook.
 *
 * GoTrue has no native MSG91 driver — `GetSmsProvider` in supabase/auth
 * v2.189.0 knows only twilio/twilio_verify/messagebird/textlocal/vonage — so
 * MSG91 is reached the supported way instead: GoTrue POSTs the OTP it already
 * generated to a hook, and the hook sends the message. That hook is a panel
 * route (app/api/db-instances/[id]/sms-hook/route.ts), which is why this file
 * lives in the panel and not in the instance.
 *
 * Uses MSG91's Flow API rather than their OTP API on purpose: the OTP
 * endpoint generates and verifies its own code, which would leave two
 * different codes in play (GoTrue's, which it will check on /verify, and
 * MSG91's, which it will not). Flow just delivers the code we hand it.
 *
 * Indian DLT rules mean the message body is not ours to compose — it lives in
 * an approved template registered with MSG91, identified by `templateId`, and
 * the OTP is substituted into one named variable in it. That variable name
 * varies per template, hence `otpVariable`.
 */

const MSG91_FLOW_ENDPOINT = "https://control.msg91.com/api/v5/flow/";

/** How long to wait on MSG91 before giving up — GoTrue is holding a request. */
const TIMEOUT_MS = 10_000;

export interface Msg91Credentials {
  authKey: string;
  templateId: string;
  /** Optional: DLT templates usually pin their own sender header. */
  senderId: string;
  /** The template variable the OTP is substituted into, e.g. "OTP". */
  otpVariable: string;
}

export type Msg91Result = { ok: true } | { ok: false; error: string };

/**
 * MSG91 wants a bare international number: digits only, no `+`, no spaces.
 * GoTrue already stores phones without a leading `+`, but callers should not
 * have to know that.
 */
export function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, "");
}

/**
 * Send one OTP. Never throws — the caller is an HTTP route answering GoTrue,
 * and a thrown error there would surface to the end user as an opaque 500
 * rather than something an operator can act on.
 */
export async function sendMsg91Otp(
  creds: Msg91Credentials,
  phone: string,
  otp: string,
): Promise<Msg91Result> {
  const mobiles = normalizePhone(phone);
  if (!mobiles) return { ok: false, error: "No phone number to send to." };
  if (!creds.authKey) return { ok: false, error: "MSG91 auth key is not configured." };
  if (!creds.templateId) return { ok: false, error: "MSG91 template id is not configured." };

  const recipient: Record<string, string> = {
    mobiles,
    [creds.otpVariable || "OTP"]: otp,
  };
  const body: Record<string, unknown> = {
    template_id: creds.templateId,
    // Their docs' own default; keeps MSG91 from rewriting anything in the
    // message as a tracking link.
    short_url: "0",
    recipients: [recipient],
  };
  if (creds.senderId) body.sender = creds.senderId;

  let res: Response;
  try {
    res = await fetch(MSG91_FLOW_ENDPOINT, {
      method: "POST",
      headers: {
        authkey: creds.authKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `MSG91 request failed: ${reason}` };
  }

  const text = await res.text().catch(() => "");
  if (!res.ok) {
    return { ok: false, error: `MSG91 responded ${res.status}: ${truncate(text)}` };
  }

  // MSG91 answers 200 even for some rejections, distinguishing them only by a
  // "type" field in the body — so status alone is not proof of delivery.
  try {
    const parsed = JSON.parse(text) as { type?: string; message?: unknown };
    if (parsed.type && parsed.type !== "success") {
      return { ok: false, error: `MSG91 rejected the request: ${truncate(text)}` };
    }
  } catch {
    // Not JSON. A 2xx with an unparseable body is not worth failing the OTP
    // over — the message has almost certainly gone out.
  }
  return { ok: true };
}

function truncate(value: string, max = 300): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}
