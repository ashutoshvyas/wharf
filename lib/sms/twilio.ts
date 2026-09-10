/** Twilio Programmable Messaging only: Supabase owns OTP generation/verification. */
export interface TwilioCredentials {
  accountSid: string;
  authToken: string;
  messageServiceSid: string;
  whatsappSender: string;
  contentSid: string;
  smsTemplate: string;
}
export type DeliveryChannel = "sms" | "whatsapp";
export type TwilioResult =
  | { ok: true; sid: string; status: string }
  | { ok: false; uncertain: boolean; code: string };

export function internationalPhone(value: string): string | null {
  const digits = value.replace(/^\+/, "");
  return /^[1-9]\d{1,14}$/.test(digits) ? `+${digits}` : null;
}

export function smsBody(template: string, otp: string): string {
  return (template || "Your code is {{ .Code }}").replace(/{{\s*\.Code\s*}}/g, otp);
}

export async function sendTwilioOtp(
  creds: TwilioCredentials,
  channel: DeliveryChannel,
  phone: string,
  otp: string,
  callbackUrl: string,
  expiresAt: Date,
  deadlineMs: number = Date.now() + 4000,
): Promise<TwilioResult> {
  const budget = deadlineMs - Date.now() - 100;
  if (budget < 1) return { ok: false, uncertain: false, code: "request_deadline" };
  const to = internationalPhone(phone);
  const remaining = Math.floor((expiresAt.getTime() - Date.now()) / 1000);
  if (!to || !/^\d{6,10}$/.test(otp) || remaining < 1) {
    return { ok: false, uncertain: false, code: "invalid_or_expired" };
  }
  const body = new URLSearchParams({
    To: channel === "whatsapp" ? `whatsapp:${to}` : to,
    StatusCallback: callbackUrl,
    ValidityPeriod: String(Math.min(remaining, 36000)),
  });
  if (channel === "whatsapp") {
    body.set("From", `whatsapp:${creds.whatsappSender.replace(/^whatsapp:/, "")}`);
    body.set("ContentSid", creds.contentSid);
    body.set("ContentVariables", JSON.stringify({ "1": otp }));
  } else {
    body.set("MessagingServiceSid", creds.messageServiceSid);
    body.set("Body", smsBody(creds.smsTemplate, otp));
  }
  try {
    // Both primary + synchronous fallback must fit inside Auth's 5-second hook budget.
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(creds.accountSid)}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${creds.accountSid}:${creds.authToken}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
      signal: AbortSignal.timeout(Math.min(1500, budget)),
      redirect: "error",
    });
    const data = await res.json().catch(() => null) as { sid?: string; status?: string; code?: number; error_code?: number } | null;
    // Never expose provider text: it can contain numbers, credentials or message bodies.
    if (!res.ok) return {
      ok: false,
      uncertain: res.status >= 500,
      code: typeof data?.code === "number" ? String(data.code) : `http_${res.status}`,
    };
    if (!data || !/^SM[0-9a-fA-F]{32}$/.test(data.sid ?? "")) {
      return { ok: false, uncertain: true, code: "invalid_response" };
    }
    if (["failed", "undelivered", "canceled"].includes(data.status ?? "")) {
      return { ok: false, uncertain: false, code: String(data.error_code ?? "delivery_failed") };
    }
    return { ok: true, sid: data.sid!, status: data.status ?? "accepted" };
  } catch {
    // An interrupted POST may already have sent the message. Never blindly resend.
    return { ok: false, uncertain: true, code: "request_uncertain" };
  }
}
