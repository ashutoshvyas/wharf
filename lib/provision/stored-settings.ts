/**
 * Everything stored for an instance that shapes its rendered .env and
 * docker-compose.yml — Auth settings, email templates, the analytics toggle.
 *
 * Every path that re-renders an existing instance must start from ALL of it
 * and override only what it is changing. renderInstanceCompose falls back to
 * defaults for any input left out, and the caller's `up -d` then pushes those
 * defaults to the server: before this module, toggling analytics reset the
 * instance's OAuth/SMTP/SMS config, and saving Auth settings dropped the
 * analytics profile.
 */
import type { InstanceAuthSettings, InstanceEmailTemplate } from "@prisma/client";
import { open } from "@/lib/crypto";
import {
  DEFAULT_AUTH_SETTINGS,
  SMS_PROVIDERS,
  type AuthSettingsValues,
  type EmailTemplateValues,
  type RenderInstanceInput,
  type SmsProvider,
} from "./render";

/** Guards the free-text `sms_provider` column back into the union. */
function isSmsProvider(value: string | null): value is SmsProvider {
  return value !== null && (SMS_PROVIDERS as readonly string[]).includes(value);
}

/**
 * Decrypt a stored settings row into the plain shape render.ts consumes.
 * A field an operator has never touched (null in the DB) falls back to
 * render.ts's own default for that field — not an empty string — so a
 * partially-configured row (e.g. OAuth set, SMTP untouched) still renders
 * the same safe SMTP defaults this template always shipped.
 */
export function decryptAuthSettings(row: InstanceAuthSettings | null): AuthSettingsValues {
  if (!row) return DEFAULT_AUTH_SETTINGS;
  return {
    disableSignup: row.disableSignup,
    enableEmailSignup: row.enableEmailSignup,
    enableEmailAutoconfirm: row.enableEmailAutoconfirm,
    enablePhoneSignup: row.enablePhoneSignup,
    enablePhoneAutoconfirm: row.enablePhoneAutoconfirm,
    enableAnonymousUsers: row.enableAnonymousUsers,
    manualLinkingEnabled: row.manualLinkingEnabled,
    jwtExpirySeconds: row.jwtExpirySeconds,
    additionalRedirectUrls: row.additionalRedirectUrls ?? DEFAULT_AUTH_SETTINGS.additionalRedirectUrls,
    siteUrl: row.siteUrl ?? DEFAULT_AUTH_SETTINGS.siteUrl,
    oauthCallbackUrl: row.oauthCallbackUrl ?? DEFAULT_AUTH_SETTINGS.oauthCallbackUrl,
    smtpHost: row.smtpHost ?? DEFAULT_AUTH_SETTINGS.smtpHost,
    smtpPort: row.smtpPort ?? DEFAULT_AUTH_SETTINGS.smtpPort,
    smtpUser: row.smtpUser ?? DEFAULT_AUTH_SETTINGS.smtpUser,
    smtpPass: row.smtpPassEnc ? open(row.smtpPassEnc) : DEFAULT_AUTH_SETTINGS.smtpPass,
    smtpSenderName: row.smtpSenderName ?? DEFAULT_AUTH_SETTINGS.smtpSenderName,
    smtpAdminEmail: row.smtpAdminEmail ?? DEFAULT_AUTH_SETTINGS.smtpAdminEmail,
    smsProvider: isSmsProvider(row.smsProvider) ? row.smsProvider : DEFAULT_AUTH_SETTINGS.smsProvider,
    smsOtpExp: row.smsOtpExp ?? DEFAULT_AUTH_SETTINGS.smsOtpExp,
    smsOtpLength: row.smsOtpLength ?? DEFAULT_AUTH_SETTINGS.smsOtpLength,
    smsMaxFrequency: row.smsMaxFrequency ?? DEFAULT_AUTH_SETTINGS.smsMaxFrequency,
    smsTemplate: row.smsTemplate ?? DEFAULT_AUTH_SETTINGS.smsTemplate,
    smsTwilioAccountSid: row.smsTwilioAccountSid ?? DEFAULT_AUTH_SETTINGS.smsTwilioAccountSid,
    smsTwilioAuthToken: row.smsTwilioAuthTokenEnc
      ? open(row.smsTwilioAuthTokenEnc)
      : DEFAULT_AUTH_SETTINGS.smsTwilioAuthToken,
    smsTwilioMessageServiceSid:
      row.smsTwilioMessageServiceSid ?? DEFAULT_AUTH_SETTINGS.smsTwilioMessageServiceSid,
    smsTwilioDeliveryChannel: row.smsTwilioDeliveryChannel === "whatsapp" ? "whatsapp" : "sms",
    smsTwilioWhatsappSender: row.smsTwilioWhatsappSender ?? "",
    smsTwilioContentSid: row.smsTwilioContentSid ?? "",
    smsTwilioSmsFallback: row.smsTwilioSmsFallback ?? false,
    smsMsg91AuthKey: row.smsMsg91AuthKeyEnc
      ? open(row.smsMsg91AuthKeyEnc)
      : DEFAULT_AUTH_SETTINGS.smsMsg91AuthKey,
    smsMsg91TemplateId: row.smsMsg91TemplateId ?? DEFAULT_AUTH_SETTINGS.smsMsg91TemplateId,
    smsMsg91SenderId: row.smsMsg91SenderId ?? DEFAULT_AUTH_SETTINGS.smsMsg91SenderId,
    // Falls back to "OTP" rather than "" — an empty variable name would build
    // an MSG91 payload the template can never substitute into.
    smsMsg91OtpVariable: row.smsMsg91OtpVariable || DEFAULT_AUTH_SETTINGS.smsMsg91OtpVariable,
    googleEnabled: row.googleEnabled,
    googleClientId: row.googleClientId ?? DEFAULT_AUTH_SETTINGS.googleClientId,
    googleSecret: row.googleSecretEnc ? open(row.googleSecretEnc) : DEFAULT_AUTH_SETTINGS.googleSecret,
    googleSkipNonceCheck: row.googleSkipNonceCheck,
    googleEmailOptional: row.googleEmailOptional,
    githubEnabled: row.githubEnabled,
    githubClientId: row.githubClientId ?? DEFAULT_AUTH_SETTINGS.githubClientId,
    githubSecret: row.githubSecretEnc ? open(row.githubSecretEnc) : DEFAULT_AUTH_SETTINGS.githubSecret,
    azureEnabled: row.azureEnabled,
    azureClientId: row.azureClientId ?? DEFAULT_AUTH_SETTINGS.azureClientId,
    azureSecret: row.azureSecretEnc ? open(row.azureSecretEnc) : DEFAULT_AUTH_SETTINGS.azureSecret,
    appleEnabled: row.appleEnabled,
    appleClientId: row.appleClientId ?? DEFAULT_AUTH_SETTINGS.appleClientId,
    appleSecret: row.appleSecretEnc ? open(row.appleSecretEnc) : DEFAULT_AUTH_SETTINGS.appleSecret,
    appleEmailOptional: row.appleEmailOptional,
  };
}

/**
 * Map stored email-template rows to the plain shape render.ts
 * consumes. Subjects come through as-is (not encrypted); `hasBody` is
 * derived from whether bodyHtml was actually set, since the row's own
 * content isn't needed here — render.ts only needs to know whether to
 * point GOTRUE_MAILER_TEMPLATES_<FLOW> at the serving URL at all.
 */
export function toEmailTemplateValues(
  rows: Pick<InstanceEmailTemplate, "flow" | "subject" | "bodyHtml">[],
): EmailTemplateValues[] {
  return rows.map((row) => ({
    flow: row.flow,
    subject: row.subject ?? "",
    hasBody: !!row.bodyHtml,
  }));
}

/** Prisma `include` that loads every relation {@link storedRenderSettings} reads. */
export const STORED_SETTINGS_INCLUDE = {
  authSettings: true,
  emailTemplates: true,
  analyticsSettings: true,
} as const;

/** The render inputs that come from stored settings rather than identity/secrets. */
export type StoredRenderSettings = Required<
  Pick<RenderInstanceInput, "authSettings" | "emailTemplates" | "analyticsSettings">
> &
  Pick<RenderInstanceInput, "instanceId" | "panelUrl">;

/**
 * Map an instance row (loaded with {@link STORED_SETTINGS_INCLUDE}) to render
 * inputs. A relation that is missing or was not loaded reads as "never
 * configured", which renders exactly what a fresh provision renders.
 */
export function storedRenderSettings(instance: {
  id: string;
  authSettings?: InstanceAuthSettings | null;
  emailTemplates?: Pick<InstanceEmailTemplate, "flow" | "subject" | "bodyHtml">[];
  analyticsSettings?: { enabled: boolean } | null;
}): StoredRenderSettings {
  return {
    authSettings: decryptAuthSettings(instance.authSettings ?? null),
    emailTemplates: toEmailTemplateValues(instance.emailTemplates ?? []),
    analyticsSettings: { enabled: instance.analyticsSettings?.enabled ?? false },
    instanceId: instance.id,
    panelUrl: process.env.PANEL_URL,
  };
}
