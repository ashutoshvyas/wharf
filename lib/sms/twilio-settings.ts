import type { InstanceAuthSettings } from "@prisma/client";
import { DEFAULT_AUTH_SETTINGS, type AuthSettingsValues } from "@/lib/provision/render";
import { open } from "@/lib/crypto";

/** OTP delivery must not depend on decrypting unrelated SMTP/OAuth credentials. */
export function twilioDeliverySettings(row: InstanceAuthSettings): AuthSettingsValues {
  return {
    ...DEFAULT_AUTH_SETTINGS,
    smsProvider: "twilio",
    smsOtpExp: row.smsOtpExp ?? DEFAULT_AUTH_SETTINGS.smsOtpExp,
    smsTemplate: row.smsTemplate ?? "",
    smsTwilioAccountSid: row.smsTwilioAccountSid ?? "",
    smsTwilioAuthToken: row.smsTwilioAuthTokenEnc ? open(row.smsTwilioAuthTokenEnc) : "",
    smsTwilioMessageServiceSid: row.smsTwilioMessageServiceSid ?? "",
    smsTwilioDeliveryChannel: row.smsTwilioDeliveryChannel === "whatsapp" ? "whatsapp" : "sms",
    smsTwilioWhatsappSender: row.smsTwilioWhatsappSender ?? "",
    smsTwilioContentSid: row.smsTwilioContentSid ?? "",
    smsTwilioSmsFallback: row.smsTwilioSmsFallback ?? false,
  };
}

/** Check merged settings, not sparse PATCH input, before touching a server. */
export function twilioSettingsError(settings: AuthSettingsValues, panelUrl?: string): string | null {
  if (settings.smsProvider !== "twilio") return null;
  try {
    const url = new URL(panelUrl ?? "");
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error();
  } catch {
    return "Twilio delivery requires PANEL_URL to be a public HTTPS URL without credentials, query parameters or a fragment.";
  }
  if (!/^AC[0-9a-fA-F]{32}$/.test(settings.smsTwilioAccountSid)) return "Enter a valid Twilio account SID (AC followed by 32 hex characters).";
  if (!settings.smsTwilioAuthToken.trim()) return "Enter the Twilio auth token.";
  if (settings.smsTwilioDeliveryChannel === "whatsapp") {
    if (!/^(?:whatsapp:)?\+[1-9]\d{1,14}$/.test(settings.smsTwilioWhatsappSender)) return "Enter a registered WhatsApp sender in international format.";
    if (!/^HX[0-9a-fA-F]{32}$/.test(settings.smsTwilioContentSid)) return "Enter an approved WhatsApp authentication template SID (HX followed by 32 hex characters).";
  }
  if (settings.smsTwilioDeliveryChannel === "sms" || settings.smsTwilioSmsFallback) {
    if (!/^MG[0-9a-fA-F]{32}$/.test(settings.smsTwilioMessageServiceSid)) return "SMS delivery requires a Twilio Messaging Service SID (MG followed by 32 hex characters).";
    const template = settings.smsTemplate;
    if (template && (!/{{\s*\.Code\s*}}/.test(template) || /{{|}}/.test(template.replace(/{{\s*\.Code\s*}}/g, "")))) {
      return "The SMS template must include {{ .Code }} and no other template expressions.";
    }
    if (template.length > 1500) return "Keep the SMS template under 1,500 characters.";
  }
  if (settings.smsTwilioSmsFallback && settings.smsTwilioDeliveryChannel !== "whatsapp") return "SMS fallback is only available with WhatsApp delivery.";
  return null;
}
