/**
 * POST /api/db-instances/:id/sms-hook — PUBLIC, unauthenticated
 * (see middleware.ts's PUBLIC_PATHS), called by GoTrue itself.
 *
 * Twilio channel selection/fallback and MSG91 delivery both use this hook: GoTrue generates the OTP as usual, then POSTs it here instead of
 * calling a built-in provider, and this route sends the message using
 * credentials that stay in the panel and never reach the instance's .env.
 *
 * Unlike the email-template route — the app's other unauthenticated
 * endpoint, which only serves markup — a call here spends money and sends a
 * real SMS. The instance id being an unguessable UUID is NOT the trust
 * boundary: every request must carry a valid standard-webhooks signature,
 * made with a secret derived from that instance's own jwtSecret
 * (lib/provision/secrets.ts), or it is rejected before a provider is contacted.
 *
 * Responses are deliberately terse. GoTrue surfaces a hook failure to the
 * end user attempting to sign in, so nothing here echoes configuration
 * state, and every rejection reads the same from outside.
 *
 * 401  missing/invalid signature, or stale timestamp
 * 404  unknown or soft-deleted instance
 * 409  the instance is not configured for a hook-delivered SMS provider
 * 502  the provider rejected the send
 */
import { open } from "@/lib/crypto";
import { apiError, withErrorHandling } from "@/lib/api-helpers";
import { prisma } from "@/lib/db";
import { deriveAncillarySecrets } from "@/lib/provision/secrets";
import { verifyHookSignature } from "@/lib/sms/hook-signature";
import { deliverTwilioOtp } from "@/lib/sms/twilio-delivery";
import { twilioDeliverySettings, twilioSettingsError } from "@/lib/sms/twilio-settings";
import { sendMsg91Otp } from "@/lib/sms/msg91";

type Ctx = { params: Promise<{ id: string }> };

/** GoTrue's SendSMSInput — only the two fields this route acts on. */
interface SendSmsHookBody {
  sms?: { otp?: string; phone?: string };
  user?: { phone?: string };
}

export const POST = withErrorHandling(async (req: Request, { params }: Ctx): Promise<Response> => {
  const deadlineMs = Date.now() + 4500;
  const { id } = await params;

  // Read the body as raw text, never req.json(): the signature covers the
  // exact bytes GoTrue sent, and re-serializing parsed JSON would not
  // reproduce them.
  const rawBody = await req.text();
  if (rawBody.length > 65_536) return apiError(413, "Request too large.");

  const instance = await prisma.dbInstance.findFirst({
    where: { id, deletedAt: null },
    select: { jwtSecretEnc: true, authSettings: true },
  });
  if (!instance?.jwtSecretEnc) return apiError(404, "Not found.");

  const { smsHookSecret } = deriveAncillarySecrets(open(instance.jwtSecretEnc));
  const verified = verifyHookSignature(
    smsHookSecret,
    {
      id: req.headers.get("webhook-id"),
      timestamp: req.headers.get("webhook-timestamp"),
      signature: req.headers.get("webhook-signature"),
    },
    rawBody,
  );
  if (!verified.ok) return apiError(401, "Unauthorized.");

  const settings = instance.authSettings;
  if (settings?.smsProvider !== "msg91" && settings?.smsProvider !== "twilio") {
    return apiError(409, "This instance is not configured for hook-delivered SMS.");
  }

  let body: SendSmsHookBody;
  try {
    body = JSON.parse(rawBody) as SendSmsHookBody;
  } catch {
    return apiError(400, "Body is not valid JSON.");
  }

  if (!body || typeof body !== "object") return apiError(400, "Invalid body.");
  const otp = body.sms?.otp ?? "";
  const phone = body.sms?.phone || body.user?.phone || "";
  if (typeof otp !== "string" || typeof phone !== "string" || !/^\d{6,10}$/.test(otp) || !phone) {
    return apiError(400, "Body is missing a valid sms.otp or sms.phone.");
  }
  if (settings.smsProvider === "twilio") {
    const values = twilioDeliverySettings(settings);
    if (twilioSettingsError(values, process.env.PANEL_URL)) return apiError(502, "Phone delivery is not configured.");
    const ok = await deliverTwilioOtp({
      instanceId: id, webhookId: req.headers.get("webhook-id")!, rawBody,
      hookSecret: smsHookSecret, phone, otp, settings: values, panelUrl: process.env.PANEL_URL!, deadlineMs,
    });
    return ok ? Response.json({}, { headers: { "Cache-Control": "no-store" } })
      : apiError(502, "Could not send the verification message.");
  }

  const result = await sendMsg91Otp(
    {
      authKey: settings.smsMsg91AuthKeyEnc ? open(settings.smsMsg91AuthKeyEnc) : "",
      templateId: settings.smsMsg91TemplateId ?? "",
      senderId: settings.smsMsg91SenderId ?? "",
      otpVariable: settings.smsMsg91OtpVariable || "OTP",
    },
    phone,
    otp,
  );

  if (!result.ok) {
    // Logged, not returned: the operator needs the provider's reason, the
    // person signing in must not see it.
    console.error(`[sms-hook] instance=${id} MSG91 send failed: ${result.error}`);
    return apiError(502, "Could not send the verification message.");
  }

  // GoTrue treats a 2xx with an empty object as success.
  return Response.json({}, { headers: { "Cache-Control": "no-store" } });
});
