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
import type { Prisma } from "@prisma/client";
import { apiError, requireApiRole, withErrorHandling } from "@/lib/api-helpers";
import { audit } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { authSettingsUpdateSchema } from "@/lib/instances/auth-settings-schema";
import { applyAuthSettings, decryptAuthSettings } from "@/lib/provision/auth-settings";
import { DEFAULT_AUTH_SETTINGS, type AuthSettingsValues } from "@/lib/provision/render";
import { sealBytes } from "@/lib/servers/seal-bytes";

type Ctx = { params: Promise<{ id: string }> };

function toDto(row: Awaited<ReturnType<typeof prisma.instanceAuthSettings.findUnique>>) {
  const values = decryptAuthSettings(row);
  return {
    disableSignup: values.disableSignup,
    enableEmailSignup: values.enableEmailSignup,
    enableEmailAutoconfirm: values.enableEmailAutoconfirm,
    enablePhoneSignup: values.enablePhoneSignup,
    enableAnonymousUsers: values.enableAnonymousUsers,
    jwtExpirySeconds: values.jwtExpirySeconds,
    additionalRedirectUrls: values.additionalRedirectUrls,
    smtpHost: values.smtpHost,
    smtpPort: values.smtpPort,
    smtpUser: values.smtpUser,
    smtpPassConfigured: values.smtpPass !== DEFAULT_AUTH_SETTINGS.smtpPass,
    smtpSenderName: values.smtpSenderName,
    smtpAdminEmail: values.smtpAdminEmail,
    googleEnabled: values.googleEnabled,
    googleClientId: values.googleClientId,
    googleSecretConfigured: values.googleSecret !== "",
    githubEnabled: values.githubEnabled,
    githubClientId: values.githubClientId,
    githubSecretConfigured: values.githubSecret !== "",
    azureEnabled: values.azureEnabled,
    azureClientId: values.azureClientId,
    azureSecretConfigured: values.azureSecret !== "",
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

  const settings = await prisma.instanceAuthSettings.findUnique({
    where: { dbInstanceId: id },
  });
  return NextResponse.json(toDto(settings), { headers: { "Cache-Control": "no-store" } });
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

  const existingRow = await prisma.instanceAuthSettings.findUnique({
    where: { dbInstanceId: id },
  });
  // Field names in `body` (post schema transform) match AuthSettingsValues'
  // own field names exactly (smtpPass, googleSecret, ...) — spreading only
  // overrides what was actually provided, same "sparse merge" the DB update
  // below performs.
  const prospective: AuthSettingsValues = { ...decryptAuthSettings(existingRow), ...body };

  // Apply BEFORE persisting: a busy server-lock conflict must leave no
  // trace, matching every other busy-conflict route in this codebase
  // (restore/remove/retry all persist nothing on a 409 busy).
  let applied = true;
  let applyError: string | undefined;
  try {
    const result = await applyAuthSettings(id, prospective);
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
  if (body.enableAnonymousUsers !== undefined) {
    data.enableAnonymousUsers = body.enableAnonymousUsers;
  }
  if (body.jwtExpirySeconds !== undefined) data.jwtExpirySeconds = body.jwtExpirySeconds;
  if (body.additionalRedirectUrls !== undefined) {
    data.additionalRedirectUrls = body.additionalRedirectUrls;
  }
  if (body.smtpHost !== undefined) data.smtpHost = body.smtpHost;
  if (body.smtpPort !== undefined) data.smtpPort = body.smtpPort;
  if (body.smtpUser !== undefined) data.smtpUser = body.smtpUser;
  if (body.smtpPass !== undefined) data.smtpPassEnc = sealBytes(body.smtpPass);
  if (body.smtpSenderName !== undefined) data.smtpSenderName = body.smtpSenderName;
  if (body.smtpAdminEmail !== undefined) data.smtpAdminEmail = body.smtpAdminEmail;
  if (body.googleEnabled !== undefined) data.googleEnabled = body.googleEnabled;
  if (body.googleClientId !== undefined) data.googleClientId = body.googleClientId;
  if (body.googleSecret !== undefined) data.googleSecretEnc = sealBytes(body.googleSecret);
  if (body.githubEnabled !== undefined) data.githubEnabled = body.githubEnabled;
  if (body.githubClientId !== undefined) data.githubClientId = body.githubClientId;
  if (body.githubSecret !== undefined) data.githubSecretEnc = sealBytes(body.githubSecret);
  if (body.azureEnabled !== undefined) data.azureEnabled = body.azureEnabled;
  if (body.azureClientId !== undefined) data.azureClientId = body.azureClientId;
  if (body.azureSecret !== undefined) data.azureSecretEnc = sealBytes(body.azureSecret);

  const settings = await prisma.instanceAuthSettings.upsert({
    where: { dbInstanceId: id },
    create: { dbInstanceId: id, ...data },
    update: data,
  });

  await audit({
    userId: session.user.id,
    userEmail: session.user.email,
    action: "instance.auth-settings.update",
    targetType: "db_instance",
    targetId: id,
    metadata: { fields: Object.keys(body), applied },
  });

  return NextResponse.json({
    ...toDto(settings),
    applied,
    ...(applyError ? { applyError } : {}),
  });
});
