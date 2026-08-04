/**
 * /api/db-instances/:id/auth-settings — self-hosted-configurable
 * Auth (GoTrue) settings: OAuth providers, SMTP, sign-up/session toggles.
 * Built because self-hosted Supabase Studio's own equivalent pages are
 * gated behind Supabase Cloud's platform-only management API and never
 * render (confirmed against a live upstream Studio issue) — see
 * lib/provision/auth-settings.ts's module doc.
 *
 * GET:   secrets.reveal (operator+) — never echoes secret values, only
 *        `*Configured` booleans, matching the existing secrets-reveal route.
 * PATCH: instance.auth-settings.write (admin-only) — sparse update; empty-
 *        string secret fields mean "keep the existing stored value" (see
 *        lib/instances/auth-settings-schema.ts). Settings are saved BEFORE
 *        the apply step runs, so a restart failure never loses the
 *        operator's input — only the "did it take effect on the server"
 *        step is reported as failed.
 *
 * 404           unknown or soft-deleted instance
 * 409 {error}   the target server's single-flight lock is held (PATCH only)
 */
import { NextResponse } from "next/server";
import type { InstanceEmailTemplate, Prisma } from "@prisma/client";
import { apiError, requireApiRole, withErrorHandling } from "@/lib/api-helpers";
import { audit } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { authSettingsUpdateSchema } from "@/lib/instances/auth-settings-schema";
import { applyAuthSettings, decryptAuthSettings } from "@/lib/provision/auth-settings";
import {
  DEFAULT_AUTH_SETTINGS,
  EMAIL_TEMPLATE_FLOWS,
  type AuthSettingsValues,
  type EmailTemplateValues,
} from "@/lib/provision/render";
import { sealBytes } from "@/lib/servers/seal-bytes";

type Ctx = { params: Promise<{ id: string }> };

/** Always all 6 flows, even ones never configured — the form needs the full picture. */
function emailTemplatesDto(rows: Pick<InstanceEmailTemplate, "flow" | "subject" | "bodyHtml">[]) {
  const byFlow = new Map(rows.map((r) => [r.flow, r]));
  return EMAIL_TEMPLATE_FLOWS.map((flow) => {
    const row = byFlow.get(flow);
    return { flow, subject: row?.subject ?? "", hasBody: !!row?.bodyHtml };
  });
}

function toDto(
  row: Awaited<ReturnType<typeof prisma.instanceAuthSettings.findUnique>>,
  templateRows: Pick<InstanceEmailTemplate, "flow" | "subject" | "bodyHtml">[],
) {
  const values = decryptAuthSettings(row);
  return {
    disableSignup: values.disableSignup,
    enableEmailSignup: values.enableEmailSignup,
    enableEmailAutoconfirm: values.enableEmailAutoconfirm,
    enablePhoneSignup: values.enablePhoneSignup,
    enablePhoneAutoconfirm: values.enablePhoneAutoconfirm,
    enableAnonymousUsers: values.enableAnonymousUsers,
    manualLinkingEnabled: values.manualLinkingEnabled,
    jwtExpirySeconds: values.jwtExpirySeconds,
    additionalRedirectUrls: values.additionalRedirectUrls,
    siteUrl: values.siteUrl,
    oauthCallbackUrl: values.oauthCallbackUrl,
    smtpHost: values.smtpHost,
    smtpPort: values.smtpPort,
    smtpUser: values.smtpUser,
    smtpPassConfigured: values.smtpPass !== DEFAULT_AUTH_SETTINGS.smtpPass,
    smtpSenderName: values.smtpSenderName,
    smtpAdminEmail: values.smtpAdminEmail,
    smsProvider: values.smsProvider,
    smsOtpExp: values.smsOtpExp,
    smsOtpLength: values.smsOtpLength,
    smsMaxFrequency: values.smsMaxFrequency,
    smsTemplate: values.smsTemplate,
    smsTwilioAccountSid: values.smsTwilioAccountSid,
    smsTwilioAuthTokenConfigured: values.smsTwilioAuthToken !== "",
    smsTwilioMessageServiceSid: values.smsTwilioMessageServiceSid,
    smsMsg91AuthKeyConfigured: values.smsMsg91AuthKey !== "",
    smsMsg91TemplateId: values.smsMsg91TemplateId,
    smsMsg91SenderId: values.smsMsg91SenderId,
    smsMsg91OtpVariable: values.smsMsg91OtpVariable,
    googleEnabled: values.googleEnabled,
    googleClientId: values.googleClientId,
    googleSecretConfigured: values.googleSecret !== "",
    googleSkipNonceCheck: values.googleSkipNonceCheck,
    googleEmailOptional: values.googleEmailOptional,
    githubEnabled: values.githubEnabled,
    githubClientId: values.githubClientId,
    githubSecretConfigured: values.githubSecret !== "",
    azureEnabled: values.azureEnabled,
    azureClientId: values.azureClientId,
    azureSecretConfigured: values.azureSecret !== "",
    appleEnabled: values.appleEnabled,
    appleClientId: values.appleClientId,
    appleSecretConfigured: values.appleSecret !== "",
    appleEmailOptional: values.appleEmailOptional,
    emailTemplates: emailTemplatesDto(templateRows),
  };
}

export const GET = withErrorHandling(async (_req: Request, { params }: Ctx) => {
  await requireApiRole("secrets.reveal");
  const { id } = await params;

  const instance = await prisma.dbInstance.findFirst({
    where: { id, deletedAt: null },
    select: { id: true },
  });
  if (!instance) return apiError(404, "Database instance not found");

  const [settings, templateRows] = await Promise.all([
    prisma.instanceAuthSettings.findUnique({ where: { dbInstanceId: id } }),
    prisma.instanceEmailTemplate.findMany({
      where: { dbInstanceId: id },
      select: { flow: true, subject: true, bodyHtml: true },
    }),
  ]);
  return NextResponse.json(toDto(settings, templateRows), {
    headers: { "Cache-Control": "no-store" },
  });
});

export const PATCH = withErrorHandling(async (req: Request, { params }: Ctx) => {
  const { session } = await requireApiRole("instance.auth-settings.write");
  const { id } = await params;

  const instance = await prisma.dbInstance.findFirst({
    where: { id, deletedAt: null },
    select: { id: true },
  });
  if (!instance) return apiError(404, "Database instance not found");

  const raw = await req.json().catch(() => null);
  if (raw === null || typeof raw !== "object") {
    return apiError(400, "Invalid request — body must be a JSON object");
  }
  const body = authSettingsUpdateSchema.parse(raw);

  const [existingRow, existingTemplateRows] = await Promise.all([
    prisma.instanceAuthSettings.findUnique({ where: { dbInstanceId: id } }),
    prisma.instanceEmailTemplate.findMany({ where: { dbInstanceId: id } }),
  ]);
  // Field names in `body` (post schema transform) match AuthSettingsValues'
  // own field names exactly (smtpPass, googleSecret, ...) — spreading only
  // overrides what was actually provided, same "sparse merge" the DB update
  // below performs.
  const prospective: AuthSettingsValues = { ...decryptAuthSettings(existingRow), ...body };

  // Full state of all 6 flows, not just whichever ones this request touches:
  // applyAuthSettings re-renders the .env from scratch, so any flow left out
  // here would silently lose its configured template on an unrelated change
  // (e.g. toggling an OAuth provider without touching emailTemplates at all).
  // Per-flow "omitted field = keep existing, explicit value = overwrite" —
  // unlike the secret-field "empty string = keep" convention used elsewhere
  // in this route, since subject/bodyHtml are never secrets.
  const templateOverrides = new Map((body.emailTemplates ?? []).map((t) => [t.flow, t]));
  const existingTemplatesByFlow = new Map(existingTemplateRows.map((r) => [r.flow, r]));
  const prospectiveTemplates: EmailTemplateValues[] = EMAIL_TEMPLATE_FLOWS.map((flow) => {
    const override = templateOverrides.get(flow);
    const existing = existingTemplatesByFlow.get(flow);
    const subject = override?.subject ?? existing?.subject ?? "";
    const bodyHtml = override?.bodyHtml ?? existing?.bodyHtml ?? "";
    return { flow, subject, hasBody: !!bodyHtml };
  });

  // Apply BEFORE persisting: a busy server-lock conflict must leave no
  // trace, matching every other busy-conflict route in this codebase
  // (restore/remove/retry all persist nothing on a 409 busy).
  let applied = true;
  let applyError: string | undefined;
  try {
    const result = await applyAuthSettings(id, prospective, prospectiveTemplates);
    if ("busy" in result) {
      return apiError(409, `Server is busy — a '${result.busy}' job is running.`);
    }
  } catch (err) {
    applied = false;
    applyError = err instanceof Error ? err.message : String(err);
  }

  // Persist regardless of `applied` — a restart failure must never lose the
  // operator's input, only report that the server-side apply didn't take.
  // Plain scalar fields only (never Prisma's {set:...} field-update-operation
  // form), so this one object is valid for both the create and update below.
  const data: Partial<Prisma.InstanceAuthSettingsUncheckedCreateInput> = {};
  if (body.disableSignup !== undefined) data.disableSignup = body.disableSignup;
  if (body.enableEmailSignup !== undefined) data.enableEmailSignup = body.enableEmailSignup;
  if (body.enableEmailAutoconfirm !== undefined) {
    data.enableEmailAutoconfirm = body.enableEmailAutoconfirm;
  }
  if (body.enablePhoneSignup !== undefined) data.enablePhoneSignup = body.enablePhoneSignup;
  if (body.enablePhoneAutoconfirm !== undefined) {
    data.enablePhoneAutoconfirm = body.enablePhoneAutoconfirm;
  }
  if (body.enableAnonymousUsers !== undefined) {
    data.enableAnonymousUsers = body.enableAnonymousUsers;
  }
  if (body.manualLinkingEnabled !== undefined) {
    data.manualLinkingEnabled = body.manualLinkingEnabled;
  }
  if (body.jwtExpirySeconds !== undefined) data.jwtExpirySeconds = body.jwtExpirySeconds;
  if (body.additionalRedirectUrls !== undefined) {
    data.additionalRedirectUrls = body.additionalRedirectUrls;
  }
  if (body.siteUrl !== undefined) data.siteUrl = body.siteUrl;
  if (body.oauthCallbackUrl !== undefined) data.oauthCallbackUrl = body.oauthCallbackUrl;
  if (body.smtpHost !== undefined) data.smtpHost = body.smtpHost;
  if (body.smtpPort !== undefined) data.smtpPort = body.smtpPort;
  if (body.smtpUser !== undefined) data.smtpUser = body.smtpUser;
  if (body.smtpPass !== undefined) data.smtpPassEnc = sealBytes(body.smtpPass);
  if (body.smtpSenderName !== undefined) data.smtpSenderName = body.smtpSenderName;
  if (body.smtpAdminEmail !== undefined) data.smtpAdminEmail = body.smtpAdminEmail;
  if (body.smsProvider !== undefined) data.smsProvider = body.smsProvider;
  if (body.smsOtpExp !== undefined) data.smsOtpExp = body.smsOtpExp;
  if (body.smsOtpLength !== undefined) data.smsOtpLength = body.smsOtpLength;
  if (body.smsMaxFrequency !== undefined) data.smsMaxFrequency = body.smsMaxFrequency;
  if (body.smsTemplate !== undefined) data.smsTemplate = body.smsTemplate;
  if (body.smsTwilioAccountSid !== undefined) {
    data.smsTwilioAccountSid = body.smsTwilioAccountSid;
  }
  if (body.smsTwilioAuthToken !== undefined) {
    data.smsTwilioAuthTokenEnc = sealBytes(body.smsTwilioAuthToken);
  }
  if (body.smsTwilioMessageServiceSid !== undefined) {
    data.smsTwilioMessageServiceSid = body.smsTwilioMessageServiceSid;
  }
  if (body.smsMsg91AuthKey !== undefined) {
    data.smsMsg91AuthKeyEnc = sealBytes(body.smsMsg91AuthKey);
  }
  if (body.smsMsg91TemplateId !== undefined) data.smsMsg91TemplateId = body.smsMsg91TemplateId;
  if (body.smsMsg91SenderId !== undefined) data.smsMsg91SenderId = body.smsMsg91SenderId;
  if (body.smsMsg91OtpVariable !== undefined) {
    data.smsMsg91OtpVariable = body.smsMsg91OtpVariable;
  }
  if (body.googleEnabled !== undefined) data.googleEnabled = body.googleEnabled;
  if (body.googleClientId !== undefined) data.googleClientId = body.googleClientId;
  if (body.googleSecret !== undefined) data.googleSecretEnc = sealBytes(body.googleSecret);
  if (body.googleSkipNonceCheck !== undefined) {
    data.googleSkipNonceCheck = body.googleSkipNonceCheck;
  }
  if (body.googleEmailOptional !== undefined) data.googleEmailOptional = body.googleEmailOptional;
  if (body.githubEnabled !== undefined) data.githubEnabled = body.githubEnabled;
  if (body.githubClientId !== undefined) data.githubClientId = body.githubClientId;
  if (body.githubSecret !== undefined) data.githubSecretEnc = sealBytes(body.githubSecret);
  if (body.azureEnabled !== undefined) data.azureEnabled = body.azureEnabled;
  if (body.azureClientId !== undefined) data.azureClientId = body.azureClientId;
  if (body.azureSecret !== undefined) data.azureSecretEnc = sealBytes(body.azureSecret);
  if (body.appleEnabled !== undefined) data.appleEnabled = body.appleEnabled;
  if (body.appleClientId !== undefined) data.appleClientId = body.appleClientId;
  if (body.appleSecret !== undefined) data.appleSecretEnc = sealBytes(body.appleSecret);
  if (body.appleEmailOptional !== undefined) data.appleEmailOptional = body.appleEmailOptional;

  const settings = await prisma.instanceAuthSettings.upsert({
    where: { dbInstanceId: id },
    create: { dbInstanceId: id, ...data },
    update: data,
  });

  // Only touch rows for flows this request actually mentioned — untouched
  // flows already carried forward correctly into `prospectiveTemplates`
  // above without needing a DB write.
  if (body.emailTemplates) {
    await Promise.all(
      body.emailTemplates.map((t) =>
        prisma.instanceEmailTemplate.upsert({
          where: { dbInstanceId_flow: { dbInstanceId: id, flow: t.flow } },
          create: {
            dbInstanceId: id,
            flow: t.flow,
            subject: t.subject ?? null,
            bodyHtml: t.bodyHtml ?? null,
          },
          update: {
            ...(t.subject !== undefined ? { subject: t.subject } : {}),
            ...(t.bodyHtml !== undefined ? { bodyHtml: t.bodyHtml } : {}),
          },
        }),
      ),
    );
  }

  await audit({
    userId: session.user.id,
    userEmail: session.user.email,
    action: "instance.auth-settings.update",
    targetType: "db_instance",
    targetId: id,
    metadata: { fields: Object.keys(body), applied },
  });

  const updatedTemplateRows: Pick<InstanceEmailTemplate, "flow" | "subject" | "bodyHtml">[] =
    EMAIL_TEMPLATE_FLOWS.map((flow) => {
      const override = templateOverrides.get(flow);
      const existing = existingTemplatesByFlow.get(flow);
      return {
        flow,
        subject: override?.subject ?? existing?.subject ?? null,
        bodyHtml: override?.bodyHtml ?? existing?.bodyHtml ?? null,
      };
    });

  return NextResponse.json({
    ...toDto(settings, updatedTemplateRows),
    applied,
    ...(applyError ? { applyError } : {}),
  });
});
