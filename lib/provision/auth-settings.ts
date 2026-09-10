/**
 * Instance Auth settings — the self-hosted-configurable subset of
 * GoTrue's Auth config (OAuth providers, SMTP, sign-up/session toggles),
 * surfaced on the panel because self-hosted Supabase Studio's own equivalent
 * pages are gated behind Supabase Cloud's platform-only management API and
 * never render (confirmed against a live upstream Studio issue).
 *
 * Applying a change re-renders and re-uploads the instance's own
 * docker-compose.yml/.env (lib/provision/render.ts), then restarts ONLY its
 * `auth` container — `docker compose up -d auth` only recreates the named
 * service, leaving db/kong/studio untouched even though they're interpolated
 * from the same .env file. The `cd` into remotePath is required: unlike
 * `stop`/`start`/`ps`, which resolve the project from running container
 * labels, `up` has to read docker-compose.yml off disk, and `-p` alone
 * doesn't tell Compose where to find it. Synchronous, lock-holding shape,
 * mirroring pipeline.ts's stopInstance/startInstance — not the async
 * job-stream pattern used by provision/restore/remove, since this completes
 * in a few seconds rather than minutes.
 */
import type { InstanceAuthSettings, InstanceEmailTemplate } from "@prisma/client";
import { open } from "@/lib/crypto";
import { prisma } from "@/lib/db";
import { serverLockHolder, tryAcquireServerLock } from "@/lib/jobs/lock";
import { exec, sftpWrite, withConnection } from "@/lib/ssh";
import {
  DEFAULT_AUTH_SETTINGS,
  renderInstanceCompose,
  SMS_PROVIDERS,
  type AuthSettingsValues,
  type EmailTemplateValues,
  type SmsProvider,
} from "./render";

/** Guards the free-text `sms_provider` column back into the union. */
function isSmsProvider(value: string | null): value is SmsProvider {
  return value !== null && (SMS_PROVIDERS as readonly string[]).includes(value);
}

/** The connection handle lib/ssh hands out (ssh2 Client, never imported here). */
type SshConnection = Parameters<typeof exec>[0];

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

export type ApplyAuthSettingsResult = { ok: true } | { busy: string };

/**
 * Re-render and re-upload this instance's docker-compose.yml/.env with the
 * given settings, then restart only its `auth` container to pick them up.
 *
 * Throws (rather than returning an error variant) for anything other than a
 * held lock — matching stopInstance/startInstance's convention, where the
 * caller's route maps a "busy" substring in the thrown message to 409 and
 * everything else to 500. The optional persistence callback runs under the
 * lock after rendering but before any SSH writes, so new hook configuration
 * is available when Auth restarts and a busy conflict leaves no saved changes.
 */
export async function applyAuthSettings(
  instanceId: string,
  settings: AuthSettingsValues,
  emailTemplates?: EmailTemplateValues[],
  persist?: () => Promise<void>,
): Promise<ApplyAuthSettingsResult> {
  const instance = await prisma.dbInstance.findFirst({
    where: { id: instanceId, deletedAt: null },
  });
  if (!instance) {
    throw new Error(`Instance ${instanceId} was not found.`);
  }
  if (
    !instance.pgPasswordEnc ||
    !instance.jwtSecretEnc ||
    !instance.anonKeyEnc ||
    !instance.serviceRoleKeyEnc
  ) {
    throw new Error("This instance has no stored secrets yet — it never finished provisioning.");
  }

  const release = tryAcquireServerLock(instance.serverId, "auth-settings");
  if (!release) {
    return { busy: serverLockHolder(instance.serverId) ?? "another job" };
  }

  try {
    const domain = process.env.INSTANCE_DOMAIN ?? "";
    const { composeYaml, envFile } = await renderInstanceCompose({
      slug: instance.slug,
      project: instance.composeProjectName,
      domain,
      secrets: {
        pgPassword: open(instance.pgPasswordEnc),
        jwtSecret: open(instance.jwtSecretEnc),
        anonKey: open(instance.anonKeyEnc),
        serviceRoleKey: open(instance.serviceRoleKeyEnc),
      },
      remotePath: instance.remotePath,
      authSettings: settings,
      emailTemplates,
      instanceId: instance.id,
      panelUrl: process.env.PANEL_URL,
    });

    // Persist hook credentials while holding the server lock, before Auth can call back.
    await persist?.();

    await withConnection(instance.serverId, async (conn: SshConnection) => {
      await sftpWrite(conn, `${instance.remotePath}/docker-compose.yml`, composeYaml);
      await sftpWrite(conn, `${instance.remotePath}/.env`, envFile, 0o600);
      const res = await exec(
        conn,
        `cd ${instance.remotePath} && docker compose -p ${instance.composeProjectName} up -d auth`,
        { timeoutMs: 120_000 },
      );
      if (res.code !== 0) {
        throw new Error(
          `docker compose up -d auth failed (code ${res.code}): ${res.stderr.trim()}`,
        );
      }
    });

    return { ok: true };
  } finally {
    release();
  }
}
